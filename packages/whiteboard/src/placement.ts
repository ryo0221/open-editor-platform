import { intersects, type Bounds } from '@editor-platform/editor-core';
import type { WhiteboardContent } from './model';

const step = 24,
  rings = 40;

/**
 * The bounds nearest to the wanted ones that overlap no board node, searched on a
 * 24px grid in rings around them; the wanted bounds when none is free nearby.
 */
export function freeBounds(content: WhiteboardContent, wanted: Bounds): Bounds {
  const taken = content.nodes.map((n) => n.bounds);
  const free = (b: Bounds) => !taken.some((t) => intersects(t, b));
  if (free(wanted)) return wanted;
  for (let r = 1; r <= rings; r++) {
    const ring: Bounds[] = [];
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        if (Math.max(Math.abs(i), Math.abs(j)) === r)
          ring.push({ ...wanted, x: wanted.x + i * step, y: wanted.y + j * step });
    const distance = (b: Bounds) => (b.x - wanted.x) ** 2 + (b.y - wanted.y) ** 2;
    const found = ring.sort((a, b) => distance(a) - distance(b)).find(free);
    if (found) return found;
  }
  return wanted;
}
