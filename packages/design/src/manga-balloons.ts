import { transaction, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { transformElements, updateElement, type DesignContent, type DesignElement } from './model';

/**
 * #21 Balloons and the regions they must not cover.
 *
 * A balloon is a speech balloon group (`mangaRole: 'balloon'`, or a group named "Speech balloon"
 * from before the role existed). A keep-out region is any element in the panel marked
 * `mangaRole: 'keep-out'` — usually a rectangle drawn over a face or a figure. Bounds are world
 * coordinates, as everywhere in a design.
 */
export const isMangaBalloon = (e: DesignElement) =>
  e.mangaRole === 'balloon' ||
  (e.mangaRole === undefined && e.type === 'group' && e.name === 'Speech balloon');
export const isMangaKeepOut = (e: DesignElement) => e.mangaRole === 'keep-out';

export interface MangaBalloonOverlap {
  balloonId: string;
  keepOutId: string;
  panelId: string;
  /** Area covered, in world units², and as a share of the keep-out region. */
  area: number;
  share: number;
}

const overlapArea = (a: Bounds, b: Bounds) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The world box an element covers as drawn: its bounds turned by its rotation (degrees, about the
 * centre), so a turned face or figure is avoided where it shows (Codex on #28).
 */
export function mangaCoverBox(e: Pick<DesignElement, 'bounds' | 'rotation'>): Bounds {
  const b = e.bounds;
  const turn = (((e.rotation ?? 0) % 360) * Math.PI) / 180;
  if (!turn) return b;
  const cos = Math.abs(Math.cos(turn)),
    sin = Math.abs(Math.sin(turn));
  const width = b.width * cos + b.height * sin,
    height = b.width * sin + b.height * cos;
  const cx = b.x + b.width / 2,
    cy = b.y + b.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

function panelIds(d: DesignContent) {
  return new Set((d.pagination?.pages ?? []).flatMap((p) => p.panelIds));
}
/** The panel an element sits in (nearest panel ancestor), or undefined. */
export function mangaPanelOf(d: DesignContent, id: string): string | undefined {
  const panels = panelIds(d);
  const index = new Map(d.elements.map((e) => [e.id, e]));
  for (
    let e = index.get(id), n = 0;
    e && n < 256;
    e = e.parentId ? index.get(e.parentId) : undefined, n++
  )
    if (panels.has(e.id) && e.id !== id) return e.id;
  return undefined;
}
const inPanel = (d: DesignContent, panelId: string, pick: (e: DesignElement) => boolean) =>
  d.elements.filter((e) => pick(e) && mangaPanelOf(d, e.id) === panelId);

/** Every balloon that covers part of a keep-out region of its own panel. */
export function mangaBalloonOverlaps(d: DesignContent): MangaBalloonOverlap[] {
  const out: MangaBalloonOverlap[] = [];
  for (const balloon of d.elements.filter(isMangaBalloon)) {
    const panelId = mangaPanelOf(d, balloon.id);
    if (!panelId) continue;
    const cover = mangaCoverBox(balloon);
    for (const k of inPanel(d, panelId, isMangaKeepOut)) {
      const box = mangaCoverBox(k);
      const area = overlapArea(cover, box);
      if (area > 0)
        out.push({
          balloonId: balloon.id,
          keepOutId: k.id,
          panelId,
          area,
          share: area / Math.max(1, box.width * box.height),
        });
    }
  }
  return out;
}

function inside(points: { x: number; y: number }[], p: { x: number; y: number }) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      hit = !hit;
  }
  return hit;
}

/**
 * Where a balloon of `size` fits in the panel without covering a keep-out region or another
 * balloon. Positions closest to where reading starts come first: the top right for right-to-left
 * works, the top left otherwise. A turned balloon (`rotation`, degrees) is placed by the box it
 * covers as drawn; the bounds returned are its stored bounds, which keep that rotation. Beside
 * an even grid, the positions touching each obstacle's and the panel's edges are tried, so a gap
 * just wide enough is found. Undefined when no position is free.
 */
export function mangaBalloonPlacement(
  d: DesignContent,
  panelId: string,
  stored: { width: number; height: number },
  ignore: readonly string[] = [],
  rotation = 0,
): Bounds | undefined {
  const cover = mangaCoverBox({ bounds: { x: 0, y: 0, ...stored }, rotation });
  const size = { width: cover.width, height: cover.height };
  // The stored bounds of a balloon whose drawn box is at (x, y): the same centre.
  const toStored = (x: number, y: number): Bounds => ({
    x: x + (size.width - stored.width) / 2,
    y: y + (size.height - stored.height) / 2,
    width: stored.width,
    height: stored.height,
  });
  const panel = d.elements.find((e) => e.id === panelId);
  if (!panel) return undefined;
  const b = panel.bounds;
  const margin = Math.max(8, panel.strokeWidth ?? 0);
  const polygon = panel.panelGeometry?.polygon.map((p) => ({
    x: b.x + p.x * b.width,
    y: b.y + p.y * b.height,
  }));
  const blocked = d.elements.filter(
    (e) =>
      !ignore.includes(e.id) &&
      (isMangaKeepOut(e) || isMangaBalloon(e)) &&
      mangaPanelOf(d, e.id) === panelId,
  );
  const free = {
    width: b.width - 2 * margin - size.width,
    height: b.height - 2 * margin - size.height,
  };
  if (free.width < 0 || free.height < 0) return undefined;
  const steps = 16;
  const rtl = d.pagination?.direction !== 'ltr';
  const [x0, y0] = [b.x + margin, b.y + margin];
  const [x1, y1] = [x0 + free.width, y0 + free.height];
  const xs = new Set<number>(),
    ys = new Set<number>();
  for (let i = 0; i <= steps; i++) {
    xs.add(x0 + (free.width * i) / steps);
    ys.add(y0 + (free.height * i) / steps);
  }
  // Touching an obstacle on either side: where a gap just wide enough begins and ends.
  for (const o of blocked.map(mangaCoverBox)) {
    xs.add(o.x + o.width).add(o.x - size.width);
    ys.add(o.y + o.height).add(o.y - size.height);
  }
  const candidates: Bounds[] = [];
  for (const x of xs)
    for (const y of ys)
      if (x >= x0 - 1e-9 && x <= x1 + 1e-9 && y >= y0 - 1e-9 && y <= y1 + 1e-9)
        candidates.push({ x, y, width: size.width, height: size.height });
  // Nearest to the reading start first (a balloon reads best high in the panel, near its start edge)
  const start = { x: rtl ? b.x + b.width : b.x, y: b.y };
  const distance = (c: Bounds) =>
    Math.hypot((rtl ? c.x + c.width : c.x) - start.x, (c.y - start.y) * 1.5);
  candidates.sort((p, q) => distance(p) - distance(q));
  for (const c of candidates) {
    if (blocked.some((e) => overlapArea(c, mangaCoverBox(e)) > 0)) continue;
    if (
      polygon &&
      ![
        { x: c.x, y: c.y },
        { x: c.x + c.width, y: c.y },
        { x: c.x, y: c.y + c.height },
        { x: c.x + c.width, y: c.y + c.height },
      ].every((p) => inside(polygon, p))
    )
      continue;
    return toStored(c.x, c.y);
  }
  return undefined;
}

/** Mark an element as a region balloons must not cover (or clear the mark). */
export const setMangaKeepOut = (id: string, keepOut: boolean): EditorCommand<DesignContent> =>
  updateElement(id, { mangaRole: keepOut ? 'keep-out' : undefined });

/**
 * Move every balloon that covers a keep-out region of its panel to the nearest free position.
 * Balloons that have no free position stay where they are and are returned in `stuck`; balloons
 * that cannot be moved (locked or hidden, or with a locked part) are returned in `locked`.
 */
export function moveMangaBalloonsOffKeepOut(d: DesignContent): {
  command?: EditorCommand<DesignContent>;
  moved: string[];
  stuck: string[];
  locked: string[];
} {
  const overlapping = [...new Set(mangaBalloonOverlaps(d).map((o) => o.balloonId))];
  const moves: EditorCommand<DesignContent>[] = [];
  const moved: string[] = [],
    stuck: string[] = [],
    locked: string[] = [];
  let next = d;
  for (const id of overlapping) {
    const balloon = next.elements.find((e) => e.id === id)!;
    const panelId = mangaPanelOf(next, id)!;
    const descendants = next.elements
      .filter((e) => mangaPanelOf(next, e.id) === panelId && isWithin(next, e.id, id))
      .map((e) => e.id);
    const to = mangaBalloonPlacement(
      next,
      panelId,
      balloon.bounds,
      [id, ...descendants],
      balloon.rotation ?? 0,
    );
    if (!to) {
      stuck.push(id);
      continue;
    }
    const move = transformElements([id], {
      dx: to.x - balloon.bounds.x,
      dy: to.y - balloon.bounds.y,
      dw: 0,
      dh: 0,
    });
    try {
      next = move.apply(next);
    } catch {
      // A locked or hidden balloon (or part of one) stays where it is; the others still move.
      locked.push(id);
      continue;
    }
    moves.push(move);
    moved.push(id);
  }
  return {
    ...(moves.length ? { command: transaction('Move balloons off faces and figures', moves) } : {}),
    moved,
    stuck,
    locked,
  };
}
function isWithin(d: DesignContent, id: string, ancestor: string) {
  const index = new Map(d.elements.map((e) => [e.id, e]));
  for (let e = index.get(id)?.parentId, n = 0; e && n < 256; e = index.get(e)?.parentId, n++)
    if (e === ancestor) return true;
  return false;
}
