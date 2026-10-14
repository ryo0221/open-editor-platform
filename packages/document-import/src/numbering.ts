import { namespaces as ns, ImportError, type XmlNode } from '@editor-platform/office-import-core';
import {
  wc,
  ws,
  wa,
  value,
  integer,
  property,
  address,
  type DocumentImportContext,
} from './context';
export interface WordList {
  numId: string;
  level: number;
  kind: 'number' | 'bullet';
  start: number;
  restartAfter: number;
}
export class WordNumbering {
  private nums = new Map<string, XmlNode>();
  private abstracts = new Map<string, XmlNode>();
  private counters = new Map<string, Map<number, number>>();
  constructor(private context: DocumentImportContext) {
    const { pkg } = context,
      part = pkg.related(pkg.mainPart, 'numbering');
    if (!part) return;
    const root = pkg.xml(part);
    if (root.local !== 'numbering' || root.uri !== ns.w)
      throw new ImportError('INVALID_NUMBERING', part);
    for (const [local, key, map] of [
      ['num', 'numId', this.nums],
      ['abstractNum', 'abstractNumId', this.abstracts],
    ] as const)
      for (const n of ws(root, local)) {
        const id = wa(n, key);
        if (id === undefined || map.has(id)) throw new ImportError('DUPLICATE_NUMBERING', part);
        integer(id);
        map.set(id, n);
      }
  }
  resolve(properties: Map<string, XmlNode>): WordList | undefined {
    const p = property(properties, 'numPr');
    if (!p) return;
    const audit = (node: XmlNode, known: string[]) => {
      for (const n of node.children)
        if (n.uri !== ns.w || !known.includes(n.local))
          this.context.builder.unsupported(
            'NUMBERING_PROPERTY',
            address(n),
            'Unknown used numbering capability requires explicit exclusion.',
          );
    };
    audit(p, ['ilvl', 'numId']);
    const numId = value(p, 'numId');
    if (!numId || numId === '0') return;
    const level = integer(value(p, 'ilvl'), 0);
    if (level < 0 || level > 8)
      throw new ImportError('LIST_LEVEL', `Invalid numbering level ${level}`);
    const num = this.nums.get(numId),
      absId = value(num, 'abstractNumId'),
      abs = absId === undefined ? undefined : this.abstracts.get(absId);
    if (!num || !abs) throw new ImportError('UNRESOLVED_NUMBERING', numId);
    audit(num, ['abstractNumId', 'lvlOverride']);
    audit(abs, ['nsid', 'multiLevelType', 'tmpl', 'name', 'styleLink', 'numStyleLink', 'lvl']);
    for (const name of ['numStyleLink', 'styleLink'])
      if (wc(abs, name)) {
        this.context.builder.unsupported(
          'NUMBERING_STYLE_LINK',
          address(wc(abs, name)!),
          `Linked numbering styles are outside this profile. Exclusion removes numbering from these paragraphs.`,
        );
        return;
      }
    const levels = ws(abs, 'lvl').filter((n) => integer(wa(n, 'ilvl')) === level),
      overrides = ws(num, 'lvlOverride').filter((n) => integer(wa(n, 'ilvl')) === level);
    if (levels.length > 1 || overrides.length > 1)
      throw new ImportError('DUPLICATE_NUMBERING_LEVEL', numId);
    const override = overrides[0],
      lvl = wc(override, 'lvl') ?? levels[0];
    if (override) audit(override, ['startOverride', 'lvl']);
    if (!lvl) throw new ImportError('UNRESOLVED_NUMBERING_LEVEL', `${numId}/${level}`);
    const format = value(lvl, 'numFmt') ?? 'decimal';
    if (format === 'none') return;
    if (!['decimal', 'bullet'].includes(format)) {
      this.context.builder.unsupported(
        'NUMBER_FORMAT',
        address(lvl),
        `Number format ${format} cannot be represented. Explicit exclusion removes numbering while preserving paragraph text.`,
      );
      return;
    }
    const start = integer(value(override, 'startOverride') ?? value(lvl, 'start'), 1);
    if (start < 1 || start > 1_000_000)
      throw new ImportError('LIST_START', `Native list starts support 1–1,000,000: ${start}`);
    const label = value(lvl, 'lvlText');
    if (format === 'decimal' && label !== `%${level + 1}.`)
      this.context.builder.unsupported(
        'NUMBER_LABEL',
        address(lvl),
        `Custom numbering label ${label ?? '(absent)'} is not retained. Exclusion uses a single native decimal counter and period.`,
      );
    if (format === 'bullet' && label !== '•')
      this.context.builder.add(
        'BULLET_APPEARANCE',
        'approximation',
        address(lvl),
        'The bullet remains an editable list and uses the native bullet marker.',
        true,
      );
    const restart = value(lvl, 'lvlRestart'),
      restartAfter = restart === undefined ? level - 1 : integer(restart) - 1;
    if (restartAfter >= level || restartAfter < -1)
      throw new ImportError('LIST_RESTART', `${numId}/${level}`);
    for (const n of lvl.children)
      if (
        n.uri !== ns.w ||
        ![
          'start',
          'numFmt',
          'lvlText',
          'lvlJc',
          'pPr',
          'rPr',
          'suff',
          'lvlRestart',
          'pStyle',
          'isLgl',
          'legacy',
        ].includes(n.local)
      )
        this.context.builder.unsupported(
          'NUMBERING_PROPERTY',
          address(n),
          'Unknown numbering capability requires explicit exclusion.',
        );
    if (wc(lvl, 'isLgl') || wc(lvl, 'legacy'))
      this.context.builder.unsupported(
        'NUMBERING_LEGACY',
        address(lvl),
        'Legal/legacy numbering must be excluded; the native decimal counter remains.',
      );
    if (wc(lvl, 'pPr') || wc(lvl, 'rPr') || wc(lvl, 'suff'))
      this.context.builder.add(
        'LIST_LAYOUT',
        'approximation',
        address(lvl),
        'Number boundaries and nesting remain; Office marker font, alignment, tab suffix and indentation use native list layout.',
        true,
      );
    this.context.builder.add(
      'NUMBERING_RESOLVED',
      'resolved',
      address(lvl),
      'Numbering references and overrides resolve to an independent native list start and nesting.',
      true,
    );
    return { numId, level, kind: format === 'decimal' ? 'number' : 'bullet', start, restartAfter };
  }
  next(list: WordList): number {
    let counters = this.counters.get(list.numId);
    if (!counters) {
      counters = new Map();
      this.counters.set(list.numId, counters);
    }
    const result = counters.has(list.level) ? counters.get(list.level)! + 1 : list.start;
    if (result > 1_000_000) throw new ImportError('LIST_START', 'Numbering exceeded 1,000,000');
    counters.set(list.level, result);
    // Word defaults restart deeper levels when a parent advances. Explicit
    // restart=0 levels retain their counters; metadata is captured on first use.
    for (const [level] of counters)
      if (
        level > list.level &&
        (this.restarts.get(`${list.numId}/${level}`) ?? level - 1) >= list.level
      )
        counters.delete(level);
    this.restarts.set(`${list.numId}/${list.level}`, list.restartAfter);
    return result;
  }
  private restarts = new Map<string, number>();
}
