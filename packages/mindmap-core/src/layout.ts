// Where each visible node is drawn. Pure: the screen, SVG export and references use the same
// positions. Positions are computed from the tree and never stored.
import {
  MINDMAP_MARK_NAMES,
  type MindmapContent,
  type MindmapMark,
  type MindmapNode,
} from './model';

/** One mark badge inside a box: `x` from the text's left edge, `row` under the text. */
export interface MindmapBadge {
  mark: MindmapMark;
  x: number;
  row: number;
  width: number;
}

export interface MindmapBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  /** -1 left of the root (radial), 1 otherwise. */
  side: -1 | 1;
  /** The text broken into the lines drawn. */
  lines: string[];
  badges: MindmapBadge[];
  parentId?: string;
  /** Whether the node has children that are hidden because it is folded. */
  folded: boolean;
}

export interface MindmapPlacement {
  boxes: MindmapBox[];
  width: number;
  height: number;
}

export const MINDMAP_BOX = {
  minWidth: 72,
  maxWidth: 220,
  padX: 12,
  padY: 8,
  lineHeight: 20,
  badgeTop: 4,
  badgeHeight: 16,
  badgeGap: 3,
  badgePad: 5,
  columnGap: 56,
  rowGap: 14,
  margin: 24,
} as const;

/** A rough advance width at 14 px: narrow for ASCII, full for CJK and others. */
const advance = (c: string) => (c.codePointAt(0)! < 0x2e80 ? (/[A-Z]/.test(c) ? 9.5 : 8) : 15);

/** The node text broken into lines that fit the widest box. */
export function mindmapTextLines(text: string): string[] {
  const max = MINDMAP_BOX.maxWidth - MINDMAP_BOX.padX * 2;
  const lines: string[] = [];
  let line = '',
    width = 0;
  for (const c of text || '（無題）') {
    const w = advance(c);
    if (width + w > max && line) {
      lines.push(line);
      line = '';
      width = 0;
    }
    line += c;
    width += w;
  }
  lines.push(line);
  return lines;
}

/** The width of one mark badge (11 px text with 5 px padding on each side). */
const badgeWidth = (mark: MindmapMark) =>
  Math.ceil([...MINDMAP_MARK_NAMES[mark]].length * 12 + MINDMAP_BOX.badgePad * 2);

function measure(n: MindmapNode) {
  const lines = mindmapTextLines(n.text);
  const textWidth = Math.max(...lines.map((l) => [...l].reduce((s, c) => s + advance(c), 0)));
  const marks = n.marks ?? [];
  const badgeRow = marks.reduce((s, m) => s + badgeWidth(m) + MINDMAP_BOX.badgeGap, 0);
  const width = Math.min(
    MINDMAP_BOX.maxWidth,
    Math.max(MINDMAP_BOX.minWidth, Math.ceil(Math.max(textWidth, badgeRow)) + MINDMAP_BOX.padX * 2),
  );
  // Badges wrap like the editor's flex row.
  const inner = width - MINDMAP_BOX.padX * 2;
  const badges: MindmapBadge[] = [];
  let x = 0,
    row = 0;
  for (const mark of marks) {
    const w = badgeWidth(mark);
    if (x && x + w > inner) {
      x = 0;
      row++;
    }
    badges.push({ mark, x, row, width: w });
    x += w + MINDMAP_BOX.badgeGap;
  }
  const rows = marks.length ? row + 1 : 0;
  const height =
    lines.length * MINDMAP_BOX.lineHeight +
    MINDMAP_BOX.padY * 2 +
    (rows
      ? MINDMAP_BOX.badgeTop + rows * MINDMAP_BOX.badgeHeight + (rows - 1) * MINDMAP_BOX.badgeGap
      : 0);
  return { lines, width, height, badges };
}

/**
 * Lays the map out. `folded` overrides the stored `collapsed` per node (a view-only fold);
 * nodes under a folded node are not placed.
 */
export function layoutMindmap(
  content: MindmapContent,
  folded: ReadonlyMap<string, boolean> = new Map(),
): MindmapPlacement {
  const { nodes, rootId, layout } = content;
  const isFolded = (n: MindmapNode) => folded.get(n.id) ?? n.collapsed ?? false;
  const column = MINDMAP_BOX.maxWidth + MINDMAP_BOX.columnGap;
  const boxes: MindmapBox[] = [];
  const byId = new Map<string, MindmapBox>();

  function place(id: string, depth: number, side: -1 | 1, parentId?: string): MindmapBox {
    const n = nodes[id];
    const { lines, width, height, badges } = measure(n);
    const box: MindmapBox = {
      id,
      x: 0,
      y: 0,
      width,
      height,
      depth,
      side,
      lines,
      badges,
      ...(parentId ? { parentId } : {}),
      folded: n.children.length > 0 && isFolded(n),
    };
    boxes.push(box);
    byId.set(id, box);
    return box;
  }

  if (layout === 'tree') {
    // Top-down: leaves get consecutive columns, a parent sits centred over its children.
    let nextX = 0;
    const rowHeight: number[] = [];
    (function visit(id: string, depth: number, parentId?: string): [number, number] {
      const box = place(id, depth, 1, parentId);
      rowHeight[depth] = Math.max(rowHeight[depth] ?? 0, box.height);
      const kids = box.folded ? [] : nodes[id].children;
      if (!kids.length) {
        box.x = nextX;
        nextX += box.width + MINDMAP_BOX.rowGap * 2;
        return [box.x, box.x + box.width];
      }
      const spans = kids.map((c) => visit(c, depth + 1, id));
      const left = spans[0][0],
        right = spans[spans.length - 1][1];
      box.x = Math.max(left, (left + right) / 2 - box.width / 2);
      nextX = Math.max(nextX, box.x + box.width + MINDMAP_BOX.rowGap * 2);
      return [Math.min(left, box.x), Math.max(right, box.x + box.width)];
    })(rootId, 0);
    const rowTop: number[] = [];
    let y = 0;
    for (let d = 0; d < rowHeight.length; d++) {
      rowTop[d] = y;
      y += rowHeight[d] + MINDMAP_BOX.columnGap;
    }
    for (const box of boxes) box.y = rowTop[box.depth];
  } else {
    // Sideways: each side stacks its leaves; a parent is centred on its children.
    const nextY: Record<-1 | 1, number> = { [-1]: 0, [1]: 0 };
    const visit = (
      id: string,
      depth: number,
      side: -1 | 1,
      parentId?: string,
    ): [number, number] => {
      const box = place(id, depth, side, parentId);
      box.x = side * depth * column;
      const kids = box.folded ? [] : nodes[id].children;
      if (!kids.length) {
        box.y = nextY[side];
        nextY[side] += box.height + MINDMAP_BOX.rowGap;
        return [box.y, box.y + box.height];
      }
      const spans = kids.map((c) => visit(c, depth + 1, side, id));
      const top = spans[0][0],
        bottom = spans[spans.length - 1][1];
      box.y = (top + bottom) / 2 - box.height / 2;
      return [Math.min(top, box.y), Math.max(bottom, box.y + box.height)];
    };
    const root = place(rootId, 0, 1);
    const kids = root.folded ? [] : nodes[rootId].children;
    const sideOf = (id: string, i: number): -1 | 1 =>
      layout === 'radial' && (nodes[id].side === 'left' || (!nodes[id].side && i % 2)) ? -1 : 1;
    const spans: Record<-1 | 1, [number, number][]> = { [-1]: [], [1]: [] };
    kids.forEach((c, i) => {
      const side = sideOf(c, i);
      spans[side].push(visit(c, 1, side, rootId));
    });
    // Centre both sides on the root.
    const middle = (s: [number, number][]) => (s.length ? (s[0][0] + s[s.length - 1][1]) / 2 : 0);
    const shift: Record<-1 | 1, number> = { [-1]: 0, [1]: 0 };
    const centre = Math.max(middle(spans[1]), middle(spans[-1]));
    shift[1] = centre - middle(spans[1]);
    shift[-1] = centre - middle(spans[-1]);
    for (const box of boxes) if (box !== root) box.y += shift[box.side];
    root.y = centre - root.height / 2;
    // Left-side boxes end at their column's right edge, so they line up towards the root.
    for (const box of boxes)
      if (box.side === -1) box.x = box.x + column - box.width - MINDMAP_BOX.columnGap;
  }

  const minX = Math.min(...boxes.map((b) => b.x)),
    minY = Math.min(...boxes.map((b) => b.y));
  for (const box of boxes) {
    box.x = Math.round(box.x - minX + MINDMAP_BOX.margin);
    box.y = Math.round(box.y - minY + MINDMAP_BOX.margin);
  }
  const width = Math.max(...boxes.map((b) => b.x + b.width)) + MINDMAP_BOX.margin;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) + MINDMAP_BOX.margin;
  return { boxes, width, height };
}

/** The line from a parent box to a child box, as SVG path data. */
export function mindmapEdgePath(parent: MindmapBox, child: MindmapBox, tree: boolean): string {
  if (tree) {
    const x1 = parent.x + parent.width / 2,
      y1 = parent.y + parent.height,
      x2 = child.x + child.width / 2,
      y2 = child.y;
    const my = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}`;
  }
  const left = child.side === -1;
  const x1 = left ? parent.x : parent.x + parent.width,
    y1 = parent.y + parent.height / 2,
    x2 = left ? child.x + child.width : child.x,
    y2 = child.y + child.height / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}
