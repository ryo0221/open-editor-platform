import { type GraphNode } from './model';
import { type GraphProfile } from './profile';

/**
 * Built-in node icons as declarative stroke paths on a 24×24 grid. Profiles name an icon; they
 * never supply path data, so a Profile cannot inject markup into the Surface or an export.
 */
const paths = {
  document: 'M6 3h8l4 4v14H6Z M14 3v4h4 M9 12h6 M9 16h6',
  table: 'M4 5h16v14H4Z M4 10h16 M4 15h16 M10 5v14',
  diagram: 'M4 4h6v6H4Z M14 14h6v6h-6Z M10 7h7v7',
  screen: 'M3 4h18v12H3Z M8 20h8 M12 16v4',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
  image: 'M3 5h18v14H3Z M3 16l5-5 4 4 3-3 6 6 M14 9a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  slides: 'M3 4h18 M5 4v11h14V4 M12 15v5 M8 21h8',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M3 20h18',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3Z M9 3v15 M15 6v15',
  cube: 'M12 2l9 5v10l-9 5-9-5V7Z M3 7l9 5 9-5 M12 12v10',
  pages: 'M4 3h16v18H4Z M4 11h16 M12 3v8 M9 11v10',
  video: 'M3 6h13v12H3Z M16 10l5-3v10l-5-3',
  calendar: 'M4 5h16v16H4Z M4 10h16 M8 3v4 M16 3v4',
  list: 'M9 6h11 M9 12h11 M9 18h11 M4 6h1 M4 12h1 M4 18h1',
  folder: 'M3 6h6l2 2h10v11H3Z',
  step: 'M3 6h11l5 6-5 6H3l5-6Z',
  check: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M8 12l3 3 5-6',
  flag: 'M5 21V4 M5 4h12l-2 4 2 4H5',
  person: 'M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M4 21a8 8 0 0 1 16 0',
} as const;
export type GraphNodeIcon = keyof typeof paths;
export const graphNodeIcons = Object.keys(paths) as GraphNodeIcon[];
export const isGraphNodeIcon = (v: unknown): v is GraphNodeIcon =>
  typeof v === 'string' && Object.hasOwn(paths, v);
/** The icon's stroke path on a 24×24 grid, drawn with round caps and no fill. */
export const graphNodeIconPath = (icon: GraphNodeIcon): string => paths[icon];

/**
 * The value-mapped icon first (`ui.icons[attributes[ui.iconBy]]`), then the type default
 * `ui.icon`, else none. Values compare as strings so enum, number and boolean fields all map.
 */
export function resolveGraphNodeIcon(
  profile: GraphProfile,
  node: GraphNode,
): GraphNodeIcon | undefined {
  const ui = profile.nodes[node.type]?.ui;
  if (!ui) return undefined;
  const value = ui.iconBy === undefined ? undefined : node.attributes[ui.iconBy];
  // Own entries only: values such as `constructor` must not reach Object.prototype.
  const key =
    value !== undefined && value !== null && typeof value !== 'object' ? String(value) : undefined;
  const mapped =
    ui.icons && key !== undefined && Object.hasOwn(ui.icons, key) ? ui.icons[key] : undefined;
  return mapped ?? ui.icon;
}
