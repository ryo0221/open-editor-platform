import {
  attribute,
  child,
  descendants,
  namespaces as ns,
  ImportError,
  type XmlNode,
  type OfficeSourceAddress,
  type ImportReportBuilder,
} from '@editor-platform/office-import-core';
import { numeric } from './geometry';
export interface ThemeContext {
  theme?: XmlNode;
  colors: Record<string, string>;
  colorMap: Record<string, string>;
  font: string;
  builder: ImportReportBuilder;
}
export function makeTheme(
  theme: XmlNode | undefined,
  master: XmlNode | undefined,
  override: XmlNode | undefined,
  builder: ImportReportBuilder,
): ThemeContext {
  const colors: Record<string, string> = {};
  for (const slot of descendants(theme, 'clrScheme', ns.a)[0]?.children ?? []) {
    const c = slot.children[0];
    const value = attribute(c, 'lastClr') ?? attribute(c, 'val');
    if (value && /^[0-9a-f]{6}$/i.test(value)) colors[slot.local] = value;
  }
  const colorMap: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
  for (const a of (child(override, 'overrideClrMapping', ns.a) ?? child(master, 'clrMap', ns.p))
    ?.attributes ?? [])
    if (!a.uri) colorMap[a.local] = a.value;
  return { theme, colors, colorMap, font: 'Noto Sans CJK JP', builder };
}
const colorElements = ['srgbClr', 'schemeClr', 'sysClr', 'scrgbClr', 'prstClr', 'hslClr'];
/** The six-digit base color of a color element before modifiers. */
function baseColor(c: XmlNode, context: ThemeContext, phColor: string | undefined) {
  if (c.local === 'srgbClr') return attribute(c, 'val');
  if (c.local === 'sysClr') return attribute(c, 'lastClr');
  if (c.local !== 'schemeClr') return undefined;
  const key = attribute(c, 'val') ?? '';
  return key === 'phClr' ? phColor : context.colors[context.colorMap[key] ?? key];
}
export function resolveColor(
  container: XmlNode | undefined,
  context: ThemeContext,
  address: OfficeSourceAddress,
  phColor?: string,
): string | undefined {
  const c = container?.children.find((n) => n.uri === ns.a && colorElements.includes(n.local));
  if (!c) return undefined;
  const value = baseColor(c, context, phColor);
  if (!value || !/^[0-9a-f]{6}$/i.test(value))
    throw new ImportError('UNRESOLVED_COLOR', `${address.part}${c.path}: color is unavailable`);
  let rgb = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)),
    alpha = 1;
  for (const mod of c.children) {
    const v = numeric(mod, 'val', 100000) / 100000;
    if (mod.uri !== ns.a)
      context.builder.unsupported(
        'COLOR_EXTENSION',
        { part: mod.part, path: mod.path },
        'Unsupported color extension requires explicit exclusion.',
      );
    else if (mod.local === 'tint') rgb = rgb.map((v0) => v0 + (255 - v0) * (1 - v));
    else if (mod.local === 'shade') rgb = rgb.map((v0) => v0 * v);
    else if (mod.local === 'alpha') alpha = v;
    else if (mod.local === 'alphaMod') alpha *= v;
    else if (mod.local === 'alphaOff') alpha += v;
    else
      context.builder.add(
        'COLOR_TRANSFORM',
        'approximation',
        { part: mod.part, path: mod.path },
        `Color transform ${mod.local} is omitted; preview uses the resolved base color.`,
        true,
      );
  }
  const hex = rgb
    .map((v) =>
      Math.min(255, Math.max(0, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
  return alpha === 1
    ? `#${hex}`
    : `rgba(${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')},${Math.max(0, Math.min(1, alpha))})`;
}
export function fillFrom(
  properties: XmlNode | undefined,
  context: ThemeContext,
  address: OfficeSourceAddress,
  fallback = 'none',
  phColor?: string,
): string {
  if (child(properties, 'noFill', ns.a)) return 'none';
  const solid = child(properties, 'solidFill', ns.a);
  if (solid) return resolveColor(solid, context, address, phColor) ?? fallback;
  for (const name of ['gradFill', 'pattFill', 'blipFill', 'grpFill'])
    if (child(properties, name, ns.a))
      context.builder.unsupported(
        'FILL_UNSUPPORTED',
        { part: child(properties, name, ns.a)!.part, path: child(properties, name, ns.a)!.path },
        `${name} cannot be represented as a native solid fill. Exclusion removes this fill.`,
      );
  return fallback;
}
