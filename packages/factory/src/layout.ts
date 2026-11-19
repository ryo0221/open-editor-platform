import type { FactoryDocument, FactoryPlacement } from '@editor-platform/factory-core';

/** Size of an object's box on the plan, in mm. */
export const factoryBox = { w: 2800, h: 1200 } as const;
const columnMm = 4000;
const rowMm = 2400;

/**
 * Where each object stands on the plan: its own `at`, or (without one) a column by its longest
 * chain of links from a source and a row in that column. Loops are cut where they close.
 */
export function factoryAutoLayout(doc: FactoryDocument): Map<string, FactoryPlacement> {
  const out = new Map<string, FactoryPlacement>();
  const next = new Map<string, string[]>();
  for (const l of doc.links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const ins = new Set(doc.links.map((l) => l.to));
  const visit = (id: string, d: number) => {
    if (visiting.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    visiting.add(id);
    for (const n of next.get(id) ?? []) visit(n, d + 1);
    visiting.delete(id);
  };
  for (const o of doc.objects) if (o.kind === 'source' || !ins.has(o.id)) visit(o.id, 0);
  for (const o of doc.objects) if (!depth.has(o.id)) visit(o.id, 0);
  const rows = new Map<number, number>();
  for (const o of doc.objects) {
    if (o.at) {
      out.set(o.id, o.at);
      continue;
    }
    const d = depth.get(o.id) ?? 0;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    out.set(o.id, { x: d * columnMm, y: -r * rowMm });
  }
  return out;
}

/** The plan's extent around every box, in mm, with a margin. */
export function factoryPlanBounds(
  layout: Map<string, FactoryPlacement>,
  /** FT3c: path points, kept in view too. */
  points: readonly { x: number; y: number }[] = [],
) {
  // Extrema by a loop: a building can give far more points than a call takes arguments.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const take = (p: { x: number; y: number }) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const p of layout.values()) take(p);
  for (const p of points) take(p);
  const m = 1500;
  if (!Number.isFinite(x0)) return { minX: -m, minY: -m, maxX: 8000, maxY: 4000 };
  return {
    minX: x0 - factoryBox.w / 2 - m,
    maxX: x1 + factoryBox.w / 2 + m,
    minY: y0 - factoryBox.h / 2 - m,
    maxY: y1 + factoryBox.h / 2 + m,
  };
}
