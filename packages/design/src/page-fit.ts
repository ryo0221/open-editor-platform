import type { DesignContent } from './model';

/**
 * The page a "Fit page" shows: the page holding the first selected element, else the page whose
 * centre is nearest the given point (the viewport centre). A manga spread fitted whole is a few
 * percent, too small to read, so pages are read one at a time.
 */
export function designPageToFit(
  content: DesignContent,
  selected: string[],
  centre: { x: number; y: number },
): string | undefined {
  const pages = new Set(content.pagination?.pages.map((p) => p.frameId) ?? []);
  if (!pages.size) return undefined;
  const byId = new Map(content.elements.map((e) => [e.id, e]));
  for (const id of selected) {
    const seen = new Set<string>();
    for (
      let e = byId.get(id);
      e && !seen.has(e.id);
      e = e.parentId ? byId.get(e.parentId) : undefined
    ) {
      seen.add(e.id);
      if (pages.has(e.id)) return e.id;
    }
  }
  let best: string | undefined,
    distance = Infinity;
  for (const id of pages) {
    const b = byId.get(id)?.bounds;
    if (!b) continue;
    const d = Math.hypot(b.x + b.width / 2 - centre.x, b.y + b.height / 2 - centre.y);
    if (d < distance) [best, distance] = [id, d];
  }
  return best;
}
