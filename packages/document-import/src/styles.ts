import {
  child,
  children,
  descendants,
  namespaces as ns,
  ImportError,
  type XmlNode,
} from '@editor-platform/office-import-core';
import type { InlineSpan, DocumentBlock } from '@editor-platform/document/model';
import {
  wc,
  ws,
  wa,
  value,
  address,
  enabled,
  integer,
  propertyMap,
  type DocumentImportContext,
} from './context';
export interface RunProperties {
  node: XmlNode;
  style: boolean;
}
export class WordStyles {
  private styles = new Map<string, XmlNode>();
  private chains = new Map<string, XmlNode[]>();
  private defaults?: XmlNode;
  private defaultParagraph?: string;
  private theme?: XmlNode;
  constructor(private context: DocumentImportContext) {
    const { pkg } = context;
    const part = pkg.related(pkg.mainPart, 'styles');
    if (part) {
      const root = pkg.xml(part);
      if (root.local !== 'styles' || root.uri !== ns.w)
        throw new ImportError('INVALID_STYLES', part);
      this.defaults = wc(root, 'docDefaults');
      for (const style of ws(root, 'style')) {
        const key = wa(style, 'styleId');
        if (!key || this.styles.has(key)) throw new ImportError('DUPLICATE_STYLE', part);
        this.styles.set(key, style);
        if (
          wa(style, 'type') === 'paragraph' &&
          ['1', 'true', 'on'].includes(wa(style, 'default') ?? '')
        ) {
          if (this.defaultParagraph)
            throw new ImportError('INVALID_STYLES', 'Duplicate default paragraph style');
          this.defaultParagraph = key;
        }
      }
    }
    const themePart = pkg.related(pkg.mainPart, 'theme');
    if (themePart) this.theme = pkg.xml(themePart);
  }
  chain(
    key: string | undefined,
    type: 'paragraph' | 'character' | 'table',
    visiting = new Set<string>(),
  ): XmlNode[] {
    if (!key) return [];
    const node = this.styles.get(key);
    if (!node || wa(node, 'type') !== type)
      throw new ImportError('UNRESOLVED_STYLE', `Missing or incompatible ${type} style ${key}`);
    const cached = this.chains.get(key);
    if (cached) return cached;
    if (visiting.has(key) || visiting.size >= 64) throw new ImportError('STYLE_CYCLE', key);
    visiting.add(key);
    const result = [...this.chain(value(node, 'basedOn'), type, visiting), node];
    visiting.delete(key);
    this.chains.set(key, result);
    return result;
  }
  paragraph(p: XmlNode) {
    const chain = this.chain(value(wc(p, 'pPr'), 'pStyle') ?? this.defaultParagraph, 'paragraph');
    for (const style of chain)
      this.context.builder.add(
        'WORD_STYLE_RESOLVED',
        'resolved',
        address(style),
        'Paragraph style inheritance is resolved; the Word style registry is not retained.',
        true,
      );
    const properties = propertyMap([
      wc(wc(this.defaults, 'pPrDefault'), 'pPr'),
      ...chain.map((s) => wc(s, 'pPr')),
      wc(p, 'pPr'),
    ]);
    const runProperties: RunProperties[] = [];
    const defaults = wc(wc(this.defaults, 'rPrDefault'), 'rPr');
    if (defaults) runProperties.push({ node: defaults, style: false });
    for (const style of chain) {
      const node = wc(style, 'rPr');
      if (node) runProperties.push({ node, style: true });
    }
    return { properties, runProperties };
  }
  marks(base: RunProperties[], run: XmlNode): InlineSpan {
    const result: InlineSpan = { text: '' };
    const direct = wc(run, 'rPr'),
      key = value(direct, 'rStyle');
    const entries = [
      ...base,
      ...this.chain(key, 'character').flatMap((s) => {
        const node = wc(s, 'rPr');
        return node ? [{ node, style: true }] : [];
      }),
      ...(direct ? [{ node: direct, style: false }] : []),
    ];
    const { builder } = this.context;
    for (const { node, style } of entries)
      for (const p of node.children) {
        if (p.uri !== ns.w) {
          builder.unsupported(
            'RUN_NAMESPACE',
            address(p),
            'Unknown run property requires explicit exclusion.',
          );
          continue;
        }
        const v = wa(p, 'val');
        const bool: Record<string, 'bold' | 'italic' | 'strike'> = {
          b: 'bold',
          i: 'italic',
          strike: 'strike',
          dstrike: 'strike',
        };
        if (bool[p.local]) {
          const key = bool[p.local];
          if (style) {
            if (enabled(p)) result[key] = !result[key];
          } else result[key] = enabled(p);
        } else if (p.local === 'u') {
          result.underline = v !== 'none';
          if (v && !['single', 'none'].includes(v))
            builder.add(
              'UNDERLINE_STYLE',
              'approximation',
              address(p),
              'Underline uses the native single line.',
              true,
            );
        } else if (p.local === 'color' || p.local === 'shd' || p.local === 'highlight') {
          const color = this.color(p, p.local === 'shd' ? 'fill' : 'val');
          if (color) result[p.local === 'color' ? 'color' : 'highlight'] = color;
        } else if (p.local === 'rFonts') {
          const declared: string[] = [];
          for (const [raw, themeKey] of [
            ['ascii', 'asciiTheme'],
            ['hAnsi', 'hAnsiTheme'],
            ['eastAsia', 'eastAsiaTheme'],
            ['cs', 'cstheme'],
          ] as const) {
            let family = wa(p, raw);
            const ref = wa(p, themeKey);
            if (!family && ref) {
              const font = descendants(
                this.theme,
                ref.startsWith('major') ? 'majorFont' : 'minorFont',
                ns.a,
              )[0];
              const script = raw === 'eastAsia' ? 'ea' : raw === 'cs' ? 'cs' : 'latin';
              family = child(font, script, ns.a)?.attributes.find(
                (a) => !a.uri && a.local === 'typeface',
              )?.value;
              if (!family && script === 'ea')
                family = children(font, 'font', ns.a)
                  .find((f) =>
                    f.attributes.some((a) => !a.uri && a.local === 'script' && a.value === 'Jpan'),
                  )
                  ?.attributes.find((a) => !a.uri && a.local === 'typeface')?.value;
              family ||= child(font, 'latin', ns.a)?.attributes.find(
                (a) => !a.uri && a.local === 'typeface',
              )?.value;
              if (!family) throw new ImportError('UNRESOLVED_FONT', `${p.part}${p.path}`);
            }
            if (family) declared.push(family);
          }
          if (declared.some((f) => f !== 'Noto Sans CJK JP'))
            builder.add(
              'FONT_SUBSTITUTION',
              'approximation',
              address(p),
              `Declared fonts ${[...new Set(declared)].join(', ')} use fixed Noto Sans CJK JP 2.004.`,
              true,
            );
        } else if (
          [
            'sz',
            'szCs',
            'kern',
            'spacing',
            'position',
            'w',
            'caps',
            'smallCaps',
            'vertAlign',
            'bCs',
            'iCs',
            'rtl',
            'eastAsianLayout',
            'em',
            'fitText',
            'snapToGrid',
          ].includes(p.local)
        ) {
          if (['rtl'].includes(p.local) && enabled(p))
            builder.unsupported(
              'BIDI_TEXT',
              address(p),
              'Right-to-left layout is outside the native Document profile. Exclusion uses native direction.',
            );
          else
            builder.add(
              'RUN_STYLE_APPROXIMATION',
              'approximation',
              address(p),
              `${p.local} is not stored in the native inline model; text uses native metrics and supported marks.`,
              true,
            );
        } else if (p.local === 'vanish' || p.local === 'webHidden') {
          if (enabled(p))
            builder.unsupported(
              'HIDDEN_TEXT',
              address(p),
              'Hidden text is not supported. Explicit exclusion of this property reveals the text in preview.',
            );
        } else if (!['rStyle', 'lang', 'noProof', 'specVanish'].includes(p.local))
          builder.unsupported(
            'RUN_PROPERTY',
            address(p),
            `Unsupported run property ${p.local}. Explicit exclusion removes that property.`,
          );
      }
    return result;
  }
  color(p: XmlNode, key: string): string | undefined {
    let hex = wa(p, key);
    const theme = wa(p, 'themeColor') ?? wa(p, 'themeFill');
    if (theme) {
      const map: Record<string, string> = {
        text1: 'dk1',
        text2: 'dk2',
        background1: 'lt1',
        background2: 'lt2',
      };
      const slot = children(
        descendants(this.theme, 'clrScheme', ns.a)[0],
        map[theme] ?? theme,
        ns.a,
      )[0]?.children[0];
      hex = slot?.attributes.find(
        (a) => !a.uri && a.local === (slot.local === 'sysClr' ? 'lastClr' : 'val'),
      )?.value;
      if (!hex) throw new ImportError('UNRESOLVED_COLOR', `${p.part}${p.path}`);
    }
    const named: Record<string, string> = {
      yellow: 'ffff00',
      green: '00ff00',
      cyan: '00ffff',
      magenta: 'ff00ff',
      blue: '0000ff',
      red: 'ff0000',
      darkBlue: '000080',
      darkCyan: '008080',
      darkGreen: '008000',
      darkMagenta: '800080',
      darkRed: '800000',
      darkYellow: '808000',
      darkGray: '808080',
      lightGray: 'c0c0c0',
      black: '000000',
      white: 'ffffff',
    };
    if (hex && named[hex]) hex = named[hex];
    if (!hex || ['auto', 'none'].includes(hex)) return undefined;
    if (!/^[0-9a-f]{6}$/i.test(hex)) throw new ImportError('INVALID_COLOR', hex);
    if (
      wa(p, 'themeTint') ||
      wa(p, 'themeShade') ||
      wa(p, 'themeFillTint') ||
      wa(p, 'themeFillShade')
    )
      this.context.builder.add(
        'COLOR_TRANSFORM',
        'approximation',
        address(p),
        'Word color tint/shade uses the resolved base color.',
        true,
      );
    if (p.local === 'shd' && wa(p, 'val') && !['clear', 'solid', 'nil'].includes(wa(p, 'val')!))
      this.context.builder.add(
        'SHADING_PATTERN',
        'approximation',
        address(p),
        'Pattern shading becomes a solid inline highlight.',
        true,
      );
    return '#' + hex.toLowerCase();
  }
  blockProperties(
    map: Map<string, XmlNode>,
  ): Pick<DocumentBlock, 'type' | 'level' | 'align' | 'indent'> {
    const out: Pick<DocumentBlock, 'type' | 'level' | 'align' | 'indent'> = { type: 'paragraph' };
    const { builder } = this.context;
    for (const p of map.values()) {
      if (p.uri !== ns.w) {
        builder.unsupported(
          'PARAGRAPH_NAMESPACE',
          address(p),
          'Unknown paragraph property requires exclusion.',
        );
        continue;
      }
      const v = wa(p, 'val');
      if (p.local === 'outlineLvl') {
        const level = integer(v);
        if (level < 0 || level > 9) throw new ImportError('OUTLINE_LEVEL', String(level));
        if (level < 6) {
          out.type = 'heading';
          out.level = level + 1;
        } else if (level < 9)
          builder.unsupported(
            'HEADING_LEVEL',
            address(p),
            'Native headings support levels 1–6; explicitly excluding this property produces a paragraph.',
          );
      } else if (p.local === 'jc') {
        const align: Record<string, NonNullable<DocumentBlock['align']>> = {
          left: 'left',
          start: 'left',
          right: 'right',
          end: 'right',
          center: 'center',
          both: 'justify',
        };
        if (v && align[v]) out.align = align[v];
        else
          builder.add(
            'PARAGRAPH_ALIGNMENT',
            'approximation',
            address(p),
            'This Word alignment uses native left alignment.',
            true,
          );
      } else if (p.local === 'ind') {
        const left = integer(wa(p, 'start') ?? wa(p, 'left'), 0) / 15;
        out.indent = Math.max(0, Math.min(20, Math.round(left / 24)));
        if (
          left !== out.indent * 24 ||
          integer(wa(p, 'firstLine'), 0) !== 0 ||
          integer(wa(p, 'hanging'), 0) !== 0
        )
          builder.add(
            'PARAGRAPH_INDENT',
            'approximation',
            address(p),
            'Native indentation uses 24px steps; hanging/first-line indents are not retained.',
            true,
          );
      } else if (p.local === 'bidi' && enabled(p))
        builder.unsupported(
          'BIDI_PARAGRAPH',
          address(p),
          'Right-to-left paragraph layout requires exclusion in this profile.',
        );
      else if (
        [
          'spacing',
          'tabs',
          'keepNext',
          'keepLines',
          'widowControl',
          'pageBreakBefore',
          'contextualSpacing',
          'suppressAutoHyphens',
          'suppressLineNumbers',
          'snapToGrid',
          'textAlignment',
          'shd',
          'pBdr',
          'framePr',
        ].includes(p.local)
      )
        builder.add(
          'PARAGRAPH_LAYOUT',
          'approximation',
          address(p),
          `${p.local} uses native flowing paragraph layout; source pagination is not retained.`,
          true,
        );
      else if (!['pStyle', 'rPr', 'numPr', 'sectPr', 'bidi'].includes(p.local))
        builder.unsupported(
          'PARAGRAPH_PROPERTY',
          address(p),
          `Unsupported paragraph property ${p.local}; exclusion removes this property.`,
        );
    }
    return out;
  }
  tableStyle(p: XmlNode | undefined) {
    const key = value(p, 'tblStyle');
    if (key)
      for (const s of this.chain(key, 'table'))
        this.context.builder.add(
          'TABLE_STYLE_RESOLVED',
          'approximation',
          address(s),
          'Word table styles are resolved as declared source styling; native table cell appearance uses native styling, not the Word style registry.',
          true,
        );
  }
}
