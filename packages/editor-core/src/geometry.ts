export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function unionBounds(items: Bounds[]): Bounds {
  if (!items.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...items.map((i) => i.x)),
    y = Math.min(...items.map((i) => i.y));
  return {
    x,
    y,
    width: Math.max(...items.map((i) => i.x + i.width)) - x,
    height: Math.max(...items.map((i) => i.y + i.height)) - y,
  };
}
export function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false;
  const b = value as Bounds;
  return (
    ['x', 'y', 'width', 'height'].every(
      (k) => typeof b[k as keyof Bounds] === 'number' && Number.isFinite(b[k as keyof Bounds]),
    ) &&
    b.width >= 1 &&
    b.height >= 1
  );
}
export const escapeXml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export interface Point {
  x: number;
  y: number;
}
export interface TransformDelta {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  rotation?: number;
}
/** Ephemeral geometry projection. Parent IDs and domain content remain adapter-owned. */
export interface GeometryItem {
  id: string;
  bounds: Bounds;
  rotation?: number;
  parentId?: string;
  locked?: boolean;
  hidden?: boolean;
}
export type Alignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export function selectedRoots(items: GeometryItem[], ids: string[]): GeometryItem[] {
  const selected = new Set(ids);
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.filter((i) => {
    if (!selected.has(i.id)) return false;
    let p = i.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (selected.has(p)) return false;
      seen.add(p);
      p = byId.get(p)?.parentId;
    }
    return true;
  });
}
export function descendantIds(items: GeometryItem[], ids: string[]): Set<string> {
  const all = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of items)
      if (i.parentId && all.has(i.parentId) && !all.has(i.id)) {
        all.add(i.id);
        changed = true;
      }
  }
  return all;
}
export function assertEditable(items: GeometryItem[], ids: string[], sameParent = false) {
  const roots = selectedRoots(items, ids),
    all = descendantIds(
      items,
      roots.map((i) => i.id),
    );
  if (items.some((i) => all.has(i.id) && (i.locked || i.hidden)))
    throw new Error('Unlock and show every selected element and child before editing.');
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const root of roots) {
    let parent = root.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (ancestor?.locked || ancestor?.hidden)
        throw new Error('Unlock and show the parent before editing.');
      parent = ancestor?.parentId;
    }
  }
  if (sameParent && new Set(roots.map((i) => i.parentId ?? '')).size > 1)
    throw new Error('Choose elements with the same parent.');
  return roots;
}
export function transformGeometry(
  items: GeometryItem[],
  ids: string[],
  delta: TransformDelta,
): Map<string, { bounds: Bounds; rotation: number }> {
  const roots = assertEditable(items, ids),
    all = descendantIds(
      items,
      roots.map((i) => i.id),
    ),
    box = unionBounds(roots.map((i) => i.bounds));
  const width = Math.max(1, box.width + delta.dw),
    height = Math.max(1, box.height + delta.dh),
    sx = width / box.width,
    sy = height / box.height;
  const rootAngle = roots.length === 1 ? ((roots[0].rotation ?? 0) * Math.PI) / 180 : 0;
  const angle = ((delta.rotation ?? 0) * Math.PI) / 180,
    cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  return new Map(
    items
      .filter((i) => all.has(i.id))
      .map((i) => {
        let b = {
          x: box.x + (i.bounds.x - box.x) * sx + delta.dx,
          y: box.y + (i.bounds.y - box.y) * sy + delta.dy,
          // An item as wide as the selection takes the typed size exactly, not
          // width × (new / old), which drifts by a float step (807 → 499.99…).
          width: i.bounds.width === box.width ? width : Math.max(1, i.bounds.width * sx),
          height: i.bounds.height === box.height ? height : Math.max(1, i.bounds.height * sy),
        };
        if (rootAngle && (delta.dw || delta.dh)) {
          // Resize in a rotated selection's own axes, keeping children in those axes.
          const x = i.bounds.x + i.bounds.width / 2 - cx,
            y = i.bounds.y + i.bounds.height / 2 - cy,
            localX = (x * Math.cos(rootAngle) + y * Math.sin(rootAngle)) * sx,
            localY = (-x * Math.sin(rootAngle) + y * Math.cos(rootAngle)) * sy;
          b.x =
            cx +
            delta.dx +
            delta.dw / 2 +
            localX * Math.cos(rootAngle) -
            localY * Math.sin(rootAngle) -
            b.width / 2;
          b.y =
            cy +
            delta.dy +
            delta.dh / 2 +
            localX * Math.sin(rootAngle) +
            localY * Math.cos(rootAngle) -
            b.height / 2;
        }
        if (angle) {
          const x = i.bounds.x + i.bounds.width / 2 - cx,
            y = i.bounds.y + i.bounds.height / 2 - cy;
          b = {
            ...b,
            x: cx + x * Math.cos(angle) - y * Math.sin(angle) - b.width / 2,
            y: cy + x * Math.sin(angle) + y * Math.cos(angle) - b.height / 2,
          };
        }
        return [
          i.id,
          { bounds: b, rotation: ((i.rotation ?? 0) + (delta.rotation ?? 0) + 360) % 360 },
        ];
      }),
  );
}
export function alignGeometry(
  items: GeometryItem[],
  ids: string[],
  mode: Alignment,
  reference?: Bounds,
): Map<string, Bounds> {
  const roots = assertEditable(items, ids, true),
    box = reference ?? unionBounds(roots.map((i) => i.bounds));
  const result = new Map<string, Bounds>();
  for (const i of roots) {
    const b = i.bounds;
    const dx =
      mode === 'left'
        ? box.x - b.x
        : mode === 'center'
          ? box.x + (box.width - b.width) / 2 - b.x
          : mode === 'right'
            ? box.x + box.width - b.width - b.x
            : 0;
    const dy =
      mode === 'top'
        ? box.y - b.y
        : mode === 'middle'
          ? box.y + (box.height - b.height) / 2 - b.y
          : mode === 'bottom'
            ? box.y + box.height - b.height - b.y
            : 0;
    const all = descendantIds(items, [i.id]);
    for (const child of items)
      if (all.has(child.id))
        result.set(child.id, { ...child.bounds, x: child.bounds.x + dx, y: child.bounds.y + dy });
  }
  return result;
}
export function distributeGeometry(
  items: GeometryItem[],
  ids: string[],
  axis: 'x' | 'y',
  gap?: number,
): Map<string, Bounds> {
  const roots = assertEditable(items, ids, true).sort((a, b) => a.bounds[axis] - b.bounds[axis]);
  if (roots.length < (gap === undefined ? 3 : 2))
    throw new Error('Select at least three elements to distribute, or two for a specified gap.');
  const size = axis === 'x' ? 'width' : 'height';
  const first = roots[0].bounds,
    last = roots.at(-1)!.bounds;
  const distance =
    gap ??
    (last[axis] + last[size] - first[axis] - roots.reduce((s, i) => s + i.bounds[size], 0)) /
      (roots.length - 1);
  const result = new Map<string, Bounds>();
  let cursor = first[axis];
  for (const root of roots) {
    const change = cursor - root.bounds[axis];
    const all = descendantIds(items, [root.id]);
    for (const item of items)
      if (all.has(item.id))
        result.set(item.id, { ...item.bounds, [axis]: item.bounds[axis] + change });
    cursor += root.bounds[size] + distance;
  }
  return result;
}
export function resizedBounds(
  box: Bounds,
  handle: string,
  dx: number,
  dy: number,
  ratio = false,
): Bounds {
  let l = box.x,
    t = box.y,
    r = box.x + box.width,
    b = box.y + box.height;
  if (handle.includes('w')) l = Math.min(r - 1, l + dx);
  if (handle.includes('e')) r = Math.max(l + 1, r + dx);
  if (handle.includes('n')) t = Math.min(b - 1, t + dy);
  if (handle.includes('s')) b = Math.max(t + 1, b + dy);
  if (ratio) {
    const scale = Math.max((r - l) / box.width, (b - t) / box.height);
    if (handle.includes('w')) l = r - box.width * scale;
    else r = l + box.width * scale;
    if (handle.includes('n')) t = b - box.height * scale;
    else b = t + box.height * scale;
  }
  return { x: l, y: t, width: r - l, height: b - t };
}
export function rotatedBounds(bounds: Bounds, rotation = 0): Bounds {
  const a = (rotation * Math.PI) / 180,
    c = Math.abs(Math.cos(a)),
    s = Math.abs(Math.sin(a)),
    width = bounds.width * c + bounds.height * s,
    height = bounds.width * s + bounds.height * c;
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}
/** World pointer delta -> local handle resize -> world center. The opposite edge stays anchored. */
export function resizedRotatedBounds(
  box: Bounds,
  rotation: number,
  handle: string,
  dx: number,
  dy: number,
  ratio = false,
): Bounds {
  const angle = (rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const local = resizedBounds(box, handle, dx * c + dy * s, -dx * s + dy * c, ratio);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  const offsetX = local.x + local.width / 2 - cx,
    offsetY = local.y + local.height / 2 - cy;
  return {
    ...local,
    x: cx + offsetX * c - offsetY * s - local.width / 2,
    y: cy + offsetX * s + offsetY * c - local.height / 2,
  };
}
export function intersects(a: Bounds, b: Bounds) {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
/** Marquee rectangle vs an oriented object box; excludes empty corners of its axis-aligned hull. */
export function intersectsRotated(a: Bounds, b: Bounds, degrees = 0): boolean {
  if (!degrees) return intersects(a, b);
  const angle = (degrees * Math.PI) / 180,
    cos = Math.cos(angle),
    sin = Math.sin(angle);
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 },
    bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  return [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: cos, y: sin },
    { x: -sin, y: cos },
  ].every((axis) => {
    const distance = Math.abs((ac.x - bc.x) * axis.x + (ac.y - bc.y) * axis.y);
    const ar = (a.width / 2) * Math.abs(axis.x) + (a.height / 2) * Math.abs(axis.y);
    const br =
      (b.width / 2) * Math.abs(cos * axis.x + sin * axis.y) +
      (b.height / 2) * Math.abs(-sin * axis.x + cos * axis.y);
    return distance <= ar + br;
  });
}
export function screenToWorld(point: Point, viewport: Point, pan: Point, zoom: number): Point {
  return { x: (point.x - viewport.x - pan.x) / zoom, y: (point.y - viewport.y - pan.y) / zoom };
}
export function snapBounds(
  bounds: Bounds,
  others: Bounds[],
  threshold: number,
  grid = 10,
): { bounds: Bounds; guides: { axis: 'x' | 'y'; value: number }[] } {
  const next = { ...bounds },
    guides: { axis: 'x' | 'y'; value: number }[] = [];
  for (const axis of ['x', 'y'] as const) {
    const size = axis === 'x' ? 'width' : 'height';
    const candidates = others.flatMap((b) => [b[axis], b[axis] + b[size] / 2, b[axis] + b[size]]);
    let best = threshold + 1,
      offset = 0,
      guide = 0;
    for (const value of [
      bounds[axis],
      bounds[axis] + bounds[size] / 2,
      bounds[axis] + bounds[size],
    ])
      for (const target of candidates) {
        const d = target - value;
        if (Math.abs(d) < Math.abs(best)) {
          best = d;
          offset = d;
          guide = target;
        }
      }
    if (Math.abs(best) <= threshold) {
      next[axis] += offset;
      guides.push({ axis, value: guide });
    } else if (grid) next[axis] = Math.round(next[axis] / grid) * grid;
  }
  return { bounds: next, guides };
}
