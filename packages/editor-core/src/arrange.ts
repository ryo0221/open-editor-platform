import { assertEditable, descendantIds, type Bounds, type GeometryItem } from './geometry';

/** Only selected roots receive target sizes; descendants follow the domain's resize policy. */
export function matchingSizeBounds(items: GeometryItem[], ids: string[], action: string) {
  const roots = assertEditable(items, ids, true);
  const first = ids.map((id) => roots.find((root) => root.id === id)).find((root) => root);
  const result = new Map<string, Bounds>();
  if (!first) return result;
  for (const root of roots) {
    if (root.id === first.id) continue;
    const bounds = {
      ...root.bounds,
      width: action === 'same-height' ? root.bounds.width : first.bounds.width,
      height: action === 'same-width' ? root.bounds.height : first.bounds.height,
    };
    if (bounds.width !== root.bounds.width || bounds.height !== root.bounds.height)
      result.set(root.id, bounds);
  }
  return result;
}

/** Flat world geometry: reflect each subtree once in its selected root's local axes. */
export function reflectGeometry(
  items: (GeometryItem & { flipX?: boolean; flipY?: boolean })[],
  ids: string[],
  axis: 'x' | 'y',
) {
  const roots = assertEditable(items, ids, true);
  const result = new Map<
    string,
    { bounds: Bounds; rotation: number; flipX: boolean; flipY: boolean }
  >();
  for (const root of roots) {
    const all = descendantIds(items, [root.id]);
    const angle = root.rotation ?? 0,
      radians = (angle * Math.PI) / 180;
    const cos = Math.cos(radians),
      sin = Math.sin(radians);
    const cx = root.bounds.x + root.bounds.width / 2,
      cy = root.bounds.y + root.bounds.height / 2;
    for (const child of items) {
      if (!all.has(child.id)) continue;
      const dx = child.bounds.x + child.bounds.width / 2 - cx;
      const dy = child.bounds.y + child.bounds.height / 2 - cy;
      const x = (dx * cos + dy * sin) * (axis === 'x' ? -1 : 1);
      const y = (-dx * sin + dy * cos) * (axis === 'y' ? -1 : 1);
      result.set(child.id, {
        bounds: {
          ...child.bounds,
          x: cx + x * cos - y * sin - child.bounds.width / 2,
          y: cy + x * sin + y * cos - child.bounds.height / 2,
        },
        rotation: (((2 * angle - (child.rotation ?? 0)) % 360) + 360) % 360,
        flipX: axis === 'x' ? !child.flipX : !!child.flipX,
        flipY: axis === 'y' ? !child.flipY : !!child.flipY,
      });
    }
  }
  return result;
}

/** Reorder sibling slots, preserving selected and unselected relative order. */
export function reorderedSiblingIds(
  items: GeometryItem[],
  ids: string[],
  action: string,
): string[] {
  const roots = assertEditable(items, ids, true);
  const chosen = new Set(roots.map((root) => root.id));
  const siblings = items
    .filter((item) => item.parentId === roots[0]?.parentId)
    .map((item) => item.id);
  if (action === 'front' || action === 'back') {
    const selected = siblings.filter((id) => chosen.has(id)),
      rest = siblings.filter((id) => !chosen.has(id));
    return action === 'front' ? [...rest, ...selected] : [...selected, ...rest];
  }
  if (action === 'forward') {
    for (let i = siblings.length - 2; i >= 0; i--)
      if (chosen.has(siblings[i]) && !chosen.has(siblings[i + 1]))
        [siblings[i], siblings[i + 1]] = [siblings[i + 1], siblings[i]];
  } else {
    for (let i = 1; i < siblings.length; i++)
      if (chosen.has(siblings[i]) && !chosen.has(siblings[i - 1]))
        [siblings[i - 1], siblings[i]] = [siblings[i], siblings[i - 1]];
  }
  return siblings;
}

/** Transient paint traversal, never a persistent shared content model. */
export function hierarchyPaintOrder<T extends { id: string; hidden?: boolean }>(
  items: T[],
  parentOf: (item: T) => string | undefined,
): T[] {
  const children = new Map<string | undefined, T[]>(),
    ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    const id = parentOf(item),
      parent = id && ids.has(id) ? id : undefined;
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  const result: T[] = [],
    visited = new Set<string>();
  const visit = (parent: string | undefined, hidden = false) => {
    for (const item of children.get(parent) ?? []) {
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      result.push(hidden ? { ...item, hidden: true } : item);
      visit(item.id, hidden || item.hidden);
    }
  };
  visit(undefined);
  return result;
}
