import { shapePath, type ShapeKind } from '@editor-platform/editor-core';
import {
  attribute as attr,
  child,
  children,
  descendants,
  namespaces as ns,
  type XmlNode,
  type OfficeSourceAddress,
} from '@editor-platform/office-import-core';
import { numeric } from './geometry';
export const pchild = (n: XmlNode | undefined, name: string) => child(n, name, ns.p);
export const achild = (n: XmlNode | undefined, name: string) => child(n, name, ns.a);
export const nv = (n: XmlNode) =>
  n.children.find((c) => c.uri === ns.p && c.local.startsWith('nv'));
export const drawingHidden = (n: XmlNode) =>
  ['1', 'true'].includes(attr(pchild(nv(n), 'cNvPr'), 'hidden') ?? '');
export const sourceAddress = (part: string, n: XmlNode): OfficeSourceAddress => ({
  part,
  path: n.path,
  ...(attr(pchild(nv(n), 'cNvPr'), 'id') ? { elementId: attr(pchild(nv(n), 'cNvPr'), 'id') } : {}),
});
export const placeholder = (n: XmlNode) => pchild(pchild(nv(n), 'nvPr'), 'ph');
/** Office booleans that switch a feature off (`show`, `showMasterSp`, ...). */
export const falsy = (value: string | undefined) => ['0', 'false'].includes(value ?? '1');
export function inheritedPlaceholder(n: XmlNode, root: XmlNode | undefined) {
  const ph = placeholder(n);
  if (!ph || !root) return undefined;
  const candidates = descendants(root, 'sp', ns.p).filter((s) => placeholder(s));
  const idx = attr(ph, 'idx'),
    type = attr(ph, 'type') ?? 'obj';
  return (
    candidates.find((s) => idx !== undefined && attr(placeholder(s), 'idx') === idx) ??
    candidates.find((s) => (attr(placeholder(s), 'type') ?? 'obj') === type)
  );
}
export function pick(nodes: (XmlNode | undefined)[], name: string, uri: string) {
  return nodes.map((n) => child(n, name, uri)).find(Boolean);
}
export const fillElements = ['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill'];
export function mergeProperties(nodes: (XmlNode | undefined)[]): XmlNode | undefined {
  const present = nodes.filter((n): n is XmlNode => !!n);
  if (!present.length) return undefined;
  const merged = new Map<string, XmlNode>(),
    attributes = new Map<string, XmlNode['attributes'][number]>();
  for (const n of [...present].reverse()) {
    for (const a of n.attributes) attributes.set(`${a.uri}#${a.local}`, a);
    for (const c of n.children) {
      if (c.uri === ns.a && fillElements.includes(c.local))
        for (const f of fillElements) merged.delete(`${ns.a}#${f}`);
      merged.set(`${c.uri}#${c.local}`, c);
    }
  }
  return { ...present[0], attributes: [...attributes.values()], children: [...merged.values()] };
}
type PathToken = number | string;
/** Finite M/L/Z tokens of a single custom path, scaled to the drawing box; undefined otherwise. */
function customPathTokens(path: XmlNode, width: number, height: number) {
  const w = numeric(path, 'w', width * 9525),
    h = numeric(path, 'h', height * 9525);
  if (w <= 0 || h <= 0) return undefined;
  const tokens: PathToken[] = [];
  for (const c of path.children) {
    if (c.uri !== ns.a) return undefined;
    if (c.local === 'close') tokens.push('Z');
    else if (c.local === 'moveTo' || c.local === 'lnTo') {
      const p = achild(c, 'pt');
      const x = Number(attr(p, 'x')),
        y = Number(attr(p, 'y'));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      tokens.push(c.local === 'moveTo' ? 'M' : 'L', (x / w) * width, (y / h) * height);
    } else return undefined;
  }
  return tokens;
}
const customShapeKinds: ShapeKind[] = [
  'triangle',
  'diamond',
  'arrow-right',
  'arrow-left',
  'arrow-up',
  'arrow-down',
  'arrow-both',
  'line',
  'arrow',
  'double-arrow',
];
function nativePathTokens(kind: ShapeKind, width: number, height: number): PathToken[] {
  let pathString = ['line', 'arrow', 'double-arrow'].includes(kind)
    ? `M0 ${height / 2} L${width} ${height / 2}`
    : shapePath(kind, width, height);
  if (kind === 'arrow' || kind === 'double-arrow')
    pathString += ` M${width - 10} ${height / 2 - 6} L${width} ${height / 2} L${width - 10} ${height / 2 + 6}`;
  if (kind === 'double-arrow')
    pathString += ` M10 ${height / 2 - 6} L0 ${height / 2} L10 ${height / 2 + 6}`;
  return (pathString.match(/[MLZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? []).map((v) =>
    /^[MLZ]$/.test(v) ? v : Number(v),
  );
}
const sameTokens = (expected: PathToken[], tokens: PathToken[]) =>
  expected.length === tokens.length &&
  expected.every((v, i) =>
    typeof v === 'string'
      ? v === tokens[i]
      : typeof tokens[i] === 'number' && Math.abs(v - (tokens[i] as number)) < 0.002,
  );
export function customShape(
  geometry: XmlNode,
  width: number,
  height: number,
): ShapeKind | undefined {
  // Recognize only the exact finite M/L/Z polygons used by our 13 native output shapes.
  const paths = children(achild(geometry, 'pathLst'), 'path', ns.a);
  if (paths.length !== 1) return undefined;
  const tokens = customPathTokens(paths[0], width, height);
  if (!tokens) return undefined;
  return customShapeKinds.find((kind) => sameTokens(nativePathTokens(kind, width, height), tokens));
}
