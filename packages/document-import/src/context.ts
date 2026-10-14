import {
  attribute,
  child,
  children,
  namespaces as ns,
  ImportError,
  type XmlNode,
  type OfficePackage,
  type ImportReportBuilder,
  type ImportMapping,
} from '@editor-platform/office-import-core';
export const wc = (n: XmlNode | undefined, name: string) => child(n, name, ns.w);
export const ws = (n: XmlNode | undefined, name: string) => children(n, name, ns.w);
export const wa = (n: XmlNode | undefined, name: string) => attribute(n, name, ns.w);
export const value = (n: XmlNode | undefined, name: string) => wa(wc(n, name), 'val');
export const address = (n: XmlNode) => ({ part: n.part, path: n.path });
export const enabled = (n: XmlNode | undefined) =>
  !!n && !['0', 'false', 'off'].includes(wa(n, 'val') ?? '1');
export function integer(text: string | undefined, fallback?: number): number {
  if (text === undefined && fallback !== undefined) return fallback;
  if (!text || !/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new ImportError('INVALID_NUMBER', `Invalid Word numeric value: ${text}`);
  return Number(text);
}
export interface DocumentImportContext {
  pkg: OfficePackage;
  builder: ImportReportBuilder;
  mapping: ImportMapping[];
  id(prefix?: string): string;
}
export function unknownChildren(
  node: XmlNode,
  known: readonly string[],
  context: DocumentImportContext,
) {
  for (const c of node.children)
    if (c.uri !== ns.w || !known.includes(c.local))
      context.builder.unsupported(
        'UNKNOWN_WORD_CAPABILITY',
        address(c),
        `Unsupported ${c.local} in ${node.local}. Explicit exclusion removes this feature.`,
      );
}
/** Merge effective property nodes while retaining the source address of every property. */
export function propertyMap(nodes: (XmlNode | undefined)[]): Map<string, XmlNode> {
  const result = new Map<string, XmlNode>();
  for (const n of nodes)
    for (const c of n?.children ?? []) {
      const key = `${c.uri}#${c.local}`,
        previous = result.get(key);
      if (previous && c.uri === ns.w && ['numPr', 'ind', 'spacing', 'tabs'].includes(c.local)) {
        const attributes = new Map(previous.attributes.map((a) => [`${a.uri}#${a.local}`, a]));
        for (const a of c.attributes) attributes.set(`${a.uri}#${a.local}`, a);
        const children = new Map(previous.children.map((n) => [`${n.uri}#${n.local}`, n]));
        for (const n of c.children) children.set(`${n.uri}#${n.local}`, n);
        result.set(key, {
          ...c,
          attributes: [...attributes.values()],
          children: [...children.values()],
        });
      } else result.set(key, c);
    }
  return result;
}
export const property = (map: Map<string, XmlNode>, name: string) => map.get(`${ns.w}#${name}`);
