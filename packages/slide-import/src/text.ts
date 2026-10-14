import {
  attribute,
  child,
  children,
  descendants,
  ImportError,
  namespaces as ns,
  type XmlNode,
  type OfficeSourceAddress,
} from '@editor-platform/office-import-core';
import type { TextRun, TextStyle } from '@editor-platform/editor-core';
import { numeric } from './geometry';
import { resolveColor, type ThemeContext } from './style';
const atNode = (address: OfficeSourceAddress, node: XmlNode): OfficeSourceAddress => ({
  part: node.part,
  path: node.path,
  ...(node.part === address.part && address.elementId ? { elementId: address.elementId } : {}),
});
const truth = (n: XmlNode | undefined, key: string) =>
  attribute(n, key) === undefined ? undefined : !['0', 'false'].includes(attribute(n, key)!);
/** DrawingML plain text keeps both explicit breaks and paragraph boundaries, including empty paragraphs. */
export function plainText(body: XmlNode | undefined): string {
  return children(body, 'p', ns.a)
    .map((p) =>
      p.children
        .map((n) => {
          if (n.uri !== ns.a) return '';
          if (n.local === 'br') return '\n';
          if (n.local === 'r' || n.local === 'fld')
            return children(n, 't', ns.a)
              .map((t) => t.text)
              .join('');
          return '';
        })
        .join(''),
    )
    .join('\n');
}
function runStyle(
  nodes: (XmlNode | undefined)[],
  context: ThemeContext,
  address: OfficeSourceAddress,
  fontColor: string,
): TextStyle {
  const result: TextStyle = { fontFamily: context.font, fontSize: 24, color: fontColor };
  for (const n of nodes) {
    if (!n) continue;
    if (attribute(n, 'sz') !== undefined) result.fontSize = numeric(n, 'sz') / 75;
    for (const [xml, key] of [
      ['b', 'bold'],
      ['i', 'italic'],
    ] as const) {
      const v = truth(n, xml);
      if (v !== undefined) result[key] = v;
    }
    if (attribute(n, 'u') !== undefined) result.underline = attribute(n, 'u') !== 'none';
    if (attribute(n, 'strike') !== undefined) result.strike = attribute(n, 'strike') !== 'noStrike';
    if (attribute(n, 'spc') !== undefined) result.letterSpacing = numeric(n, 'spc') / 75;
    const color = resolveColor(child(n, 'solidFill', ns.a), context, address);
    if (color) result.color = color;
    const declaredFonts = ['latin', 'ea', 'cs']
      .map((script) => {
        const raw = attribute(child(n, script, ns.a), 'typeface');
        if (!raw?.startsWith('+')) return raw;
        const family = descendants(
          context.theme,
          raw.startsWith('+mj-') ? 'majorFont' : 'minorFont',
          ns.a,
        )[0];
        const kind = raw.endsWith('-ea') ? 'ea' : raw.endsWith('-cs') ? 'cs' : 'latin';
        const font =
          attribute(child(family, kind, ns.a), 'typeface') ||
          (kind === 'ea'
            ? attribute(
                children(family, 'font', ns.a).find((f) => attribute(f, 'script') === 'Jpan'),
                'typeface',
              )
            : undefined) ||
          attribute(child(family, 'latin', ns.a), 'typeface');
        if (!font)
          throw new ImportError(
            'UNRESOLVED_FONT',
            `${n.part}${n.path}: theme font reference is unresolved`,
          );
        return font;
      })
      .filter((font): font is string => !!font && font !== context.font);
    if (declaredFonts.length)
      context.builder.add(
        'FONT_SUBSTITUTION',
        'approximation',
        atNode(address, n),
        `Declared source fonts ${[...new Set(declaredFonts)].join(', ')} are replaced by the fixed Noto Sans CJK JP 2.004 profile.`,
        true,
      );
    for (const key of ['baseline', 'kern', 'cap', 'normalizeH'])
      if (
        attribute(n, key) !== undefined &&
        attribute(n, key) !== '0' &&
        !(key === 'cap' && attribute(n, key) === 'none')
      )
        context.builder.add(
          'RUN_METRICS',
          'approximation',
          atNode(address, n),
          'Baseline, kerning/capitalization or normalization uses native text layout.',
          true,
        );
    for (const c of n.children) {
      if (
        c.uri !== ns.a ||
        ![
          'solidFill',
          'latin',
          'ea',
          'cs',
          'sym',
          'effectLst',
          'uFillTx',
          'uLnTx',
          'hlinkClick',
          'hlinkMouseOver',
        ].includes(c.local)
      )
        context.builder.unsupported(
          'TEXT_PROPERTY',
          atNode(address, c),
          `Unsupported text property ${c.local}; explicitly exclude this property to continue.`,
        );
      else if (c.local === 'effectLst' && c.children.length)
        context.builder.unsupported(
          'TEXT_EFFECT',
          atNode(address, c),
          'Text effects are not represented.',
        );
      else if (c.local.startsWith('hlink'))
        context.builder.add(
          'TEXT_LINK',
          'approximation',
          atNode(address, c),
          'Slide native text does not retain Office hyperlinks; only the displayed text is retained.',
          true,
        );
    }
  }
  return result;
}
export function importText(
  body: XmlNode | undefined,
  inheritedBodies: XmlNode[],
  masterStyle: XmlNode | undefined,
  defaultStyle: XmlNode | undefined,
  context: ThemeContext,
  address: OfficeSourceAddress,
  scale = 1,
  fontRef?: XmlNode,
): { text: string; runs: TextRun[]; typography: TextStyle } {
  const runs: TextRun[] = [];
  const fontColor =
    (fontRef && resolveColor(fontRef, context, atNode(address, fontRef))) ?? '#000000';
  let typography: TextStyle = {
    fontFamily: context.font,
    fontSize: 24,
    padding: 0,
    overflow: 'clip',
    verticalAlign: 'top',
    align: 'left',
  };
  const bodies = [...inheritedBodies, ...(body ? [body] : [])];
  let bodyPr: XmlNode | undefined;
  for (const b of bodies) {
    const next = child(b, 'bodyPr', ns.a);
    if (!next) continue;
    const attributes = new Map((bodyPr?.attributes ?? []).map((a) => [`${a.uri}#${a.local}`, a]));
    for (const a of next.attributes) attributes.set(`${a.uri}#${a.local}`, a);
    const children = new Map((bodyPr?.children ?? []).map((c) => [`${c.uri}#${c.local}`, c]));
    for (const c of next.children) {
      if (['noAutofit', 'normAutofit', 'spAutoFit'].includes(c.local))
        for (const key of ['noAutofit', 'normAutofit', 'spAutoFit'])
          children.delete(`${ns.a}#${key}`);
      children.set(`${c.uri}#${c.local}`, c);
    }
    bodyPr = { ...next, attributes: [...attributes.values()], children: [...children.values()] };
  }
  if (bodyPr) {
    const pads = ['lIns', 'rIns', 'tIns', 'bIns'].map(
      (k, i) => (numeric(bodyPr, k, i < 2 ? 91440 : 45720) / 9525) * scale,
    );
    typography.padding = Math.min(...pads);
    if (pads.some((v) => Math.abs(v - pads[0]) > 0.001))
      context.builder.add(
        'TEXT_INSETS',
        'approximation',
        atNode(address, bodyPr),
        'Native text has one padding value; asymmetric Office insets are reduced to their minimum.',
        true,
      );
    typography.verticalAlign =
      attribute(bodyPr, 'anchor') === 'ctr'
        ? 'middle'
        : attribute(bodyPr, 'anchor') === 'b'
          ? 'bottom'
          : 'top';
    if (attribute(bodyPr, 'vert') && attribute(bodyPr, 'vert') !== 'horz')
      context.builder.unsupported(
        'VERTICAL_TEXT',
        atNode(address, bodyPr),
        'Vertical text is not supported; explicit exclusion uses horizontal text.',
      );
    if (child(bodyPr, 'spAutoFit', ns.a) || child(bodyPr, 'normAutofit', ns.a))
      context.builder.add(
        'TEXT_AUTOFIT',
        'approximation',
        atNode(address, bodyPr),
        'Office auto-fit is flattened to captured geometry with native text clipping.',
        true,
      );
    if (numeric(bodyPr, 'numCol', 1) !== 1 || numeric(bodyPr, 'rot', 0) !== 0)
      context.builder.unsupported(
        'TEXT_FRAME',
        atNode(address, bodyPr),
        'Columns or independent text rotation cannot be retained.',
      );
  }
  const paragraphs = children(body, 'p', ns.a);
  const aligns = new Set<string>();
  for (const [index, p] of paragraphs.entries()) {
    const pp = child(p, 'pPr', ns.a),
      level = numeric(pp, 'lvl', 0);
    if (level < 0 || level > 8)
      context.builder.unsupported(
        'TEXT_LIST_LEVEL',
        atNode(address, p),
        'Invalid or unsupported list level.',
      );
    const styleName = `lvl${level + 1}pPr`;
    const baseParagraphs = [
      child(defaultStyle, styleName, ns.a),
      child(masterStyle, styleName, ns.a),
      ...bodies.flatMap((b) => [
        child(child(b, 'lstStyle', ns.a), styleName, ns.a),
        ...(b === body ? [] : [child(child(b, 'p', ns.a), 'pPr', ns.a)]),
      ]),
      pp,
    ];
    const baseRuns = baseParagraphs.map((n) => child(n, 'defRPr', ns.a));
    const base = runStyle(baseRuns, context, address, fontColor);
    const alignment =
      baseParagraphs
        .map((n) => attribute(n, 'algn'))
        .filter(Boolean)
        .at(-1) ?? 'l';
    aligns.add(alignment);
    if (index === 0) {
      typography = {
        ...typography,
        ...base,
        fontSize: base.fontSize! * scale,
        align: alignment === 'ctr' ? 'center' : alignment === 'r' ? 'right' : 'left',
      };
    }
    let bullet: XmlNode | undefined;
    for (const n of baseParagraphs)
      for (const c of n?.children ?? [])
        if (['buNone', 'buChar', 'buAutoNum', 'buBlip'].includes(c.local)) bullet = c;
    if (index) runs.push({ text: '\n' });
    if (bullet && bullet.local !== 'buNone') {
      context.builder.add(
        'TEXT_LIST',
        'approximation',
        atNode(address, p),
        'Office paragraph numbering/bullets are retained as editable literal text; automatic numbering and indentation are not retained.',
        true,
      );
      const prefix =
        bullet.local === 'buChar'
          ? (attribute(bullet, 'char') ?? '•')
          : bullet.local === 'buAutoNum'
            ? `${index + 1}.`
            : '•';
      runs.push({ text: `${prefix} `, style: base });
    }
    for (const n of p.children) {
      if (n.uri !== ns.a) {
        context.builder.unsupported(
          'TEXT_NAMESPACE',
          atNode(address, n),
          'Unknown text namespace.',
        );
        continue;
      }
      if (n.local === 'r' || n.local === 'fld') {
        if (n.local === 'fld')
          context.builder.add(
            'DYNAMIC_FIELD',
            'approximation',
            atNode(address, n),
            'Dynamic Office field is converted to its displayed text.',
            true,
          );
        const style = runStyle([...baseRuns, child(n, 'rPr', ns.a)], context, address, fontColor);
        style.fontSize = style.fontSize! * scale;
        if (style.letterSpacing !== undefined) style.letterSpacing *= scale;
        const texts = children(n, 't', ns.a);
        if (texts.length !== 1)
          context.builder.unsupported(
            'TEXT_RUN_STRUCTURE',
            atNode(address, n),
            'Text run must contain one text element.',
          );
        runs.push({ text: texts.map((n) => n.text).join(''), style });
        for (const c of n.children)
          if (!['rPr', 'pPr', 't'].includes(c.local) || c.uri !== ns.a)
            context.builder.unsupported(
              'TEXT_RUN_CHILD',
              atNode(address, c),
              `Unsupported run child ${c.local}.`,
            );
      } else if (n.local === 'br')
        runs.push({
          text: '\n',
          style: runStyle([...baseRuns, child(n, 'rPr', ns.a)], context, address, fontColor),
        });
      else if (!['pPr', 'endParaRPr'].includes(n.local))
        context.builder.unsupported(
          'TEXT_CHILD',
          atNode(address, n),
          `Unsupported text child ${n.local}.`,
        );
    }
    for (const n of baseParagraphs)
      if (n) {
        if (
          ['marL', 'marR', 'indent', 'defTabSz'].some(
            (k) => attribute(n, k) !== undefined && attribute(n, k) !== '0',
          ) ||
          n.children.some((c) => ['lnSpc', 'spcBef', 'spcAft', 'tabLst'].includes(c.local))
        )
          context.builder.add(
            'PARAGRAPH_SPACING',
            'approximation',
            atNode(address, p),
            'Office paragraph indents, tabs and spacing use the native text layout.',
            true,
          );
      }
  }
  if (aligns.size > 1 || [...aligns].some((v) => !['l', 'ctr', 'r'].includes(v)))
    context.builder.add(
      'PARAGRAPH_ALIGNMENT',
      'approximation',
      address,
      'Different paragraph alignments use the first paragraph alignment.',
      true,
    );
  context.builder.add(
    'TEXT_LAYOUT',
    'approximation',
    address,
    'Text remains editable. Native wrapping and line metrics can differ from Office; inspect the preview.',
    true,
  );
  return { text: runs.map((r) => r.text).join(''), runs, typography };
}
