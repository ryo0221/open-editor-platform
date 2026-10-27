import { canonicalJson } from '@editor-platform/artifact-core';
import { defaultGraphPosition, graphLimits, type GraphDocument, type Position } from './model';
import { type GraphIntent, type GraphSectionBounds } from './commands';

export interface GraphArrangeSize {
  width: number;
  height: number;
}
export interface GraphArrangeOptions {
  /** Drawn node size; the Surface passes its measured boxes. Defaults to 200×70. */
  nodeSize?: (id: string) => GraphArrangeSize;
  /** Top-left corner of the arranged drawing. */
  origin?: Position;
}

/** Spacing in logical px. A Section's name sits in its top band. */
const gap = { column: 120, row: 48, band: 160 },
  wrap = { width: 24_000, height: 12_000 },
  pad = { side: 30, top: 56, bottom: 30 },
  minSection = { width: 200, height: 120 };

type Item = { kind: 'node' | 'section'; id: string };
type Placed = Item & { width: number; height: number; children?: { item: Placed; at: Position }[] };

/**
 * Lays out every container (the drawing and each Section) on its own: its member nodes and
 * child Sections go into columns by the direction of the connections between them, and each
 * Section grows to hold its contents. Membership never changes, only positions and frames.
 * Returns one batch of `move-node` and `resize-section` intents for what moved, so a single
 * Undo restores the previous drawing. Pure and deterministic for the same document.
 */
export function arrangeGraph(
  graph: GraphDocument,
  options: GraphArrangeOptions = {},
): GraphIntent[] {
  const nodeSize = options.nodeSize ?? (() => ({ width: 200, height: 70 })),
    origin = options.origin ?? { x: 40, y: 40 };
  const sectionIds = new Set(graph.sections.map((s) => s.id));
  const parentOf = new Map<string, string | undefined>(
    graph.sections.map((s) => [s.id, s.parentId]),
  );
  const containerOf = (item: Item) =>
    item.kind === 'node'
      ? graph.nodes.find((n) => n.id === item.id)?.sectionId
      : parentOf.get(item.id);
  const itemsIn = (container: string | undefined): Item[] => [
    ...graph.sections
      .filter((s) => s.parentId === container)
      .map((s) => ({ kind: 'section' as const, id: s.id })),
    ...graph.nodes
      .filter((n) => n.sectionId === container)
      .map((n) => ({ kind: 'node' as const, id: n.id })),
  ];
  /** The item directly inside `container` that holds this node, if the node is inside it. */
  const holderIn = (nodeId: string, container: string | undefined): Item | undefined => {
    let item: Item = { kind: 'node', id: nodeId };
    for (let i = 0; i <= graphLimits.sectionDepth + 1; i++) {
      const up = containerOf(item);
      if (up === container) return item;
      if (up === undefined || !sectionIds.has(up)) return undefined;
      item = { kind: 'section', id: up };
    }
    return undefined;
  };
  const key = (item: Item) => `${item.kind}:${item.id}`;

  /** Longest-path columns over the connections between a container's items; cycles are cut. */
  const columns = (container: string | undefined, items: Item[]) => {
    const next = new Map<string, Set<string>>(items.map((i) => [key(i), new Set()]));
    for (const edge of graph.edges) {
      const a = holderIn(edge.from, container),
        b = holderIn(edge.to, container);
      if (a && b && key(a) !== key(b)) next.get(key(a))!.add(key(b));
    }
    // Drop the connections that close a cycle, found by walking forward in item order, so a
    // loop back to an earlier step does not pull that step after its own successors.
    const state = new Map<string, 'open' | 'done'>();
    const walk = (k: string) => {
      state.set(k, 'open');
      for (const t of [...next.get(k)!])
        if (state.get(t) === 'open') next.get(k)!.delete(t);
        else if (!state.has(t)) walk(t);
      state.set(k, 'done');
    };
    for (const i of items) if (!state.has(key(i))) walk(key(i));
    // Ranks grow along connections, so a target's column is after its sources'.
    const rank = new Map<string, number>();
    const visit = (k: string): number => {
      if (rank.has(k)) return rank.get(k)!;
      let r = 0;
      for (const [from, targets] of next) if (targets.has(k)) r = Math.max(r, visit(from) + 1);
      rank.set(k, r);
      return r;
    };
    for (const i of items) visit(key(i));
    const out: Item[][] = [];
    for (const i of items) (out[rank.get(key(i))!] ??= []).push(i);
    return out.filter(Boolean);
  };

  const place = (item: Item, depth: number): Placed => {
    if (item.kind === 'node') return { ...item, ...nodeSize(item.id) };
    if (depth > graphLimits.sectionDepth) throw new Error('Sections can nest at most 8 levels');
    const inner = layoutContainer(item.id, depth + 1);
    return {
      ...item,
      width: Math.max(minSection.width, inner.width + 2 * pad.side),
      height: Math.max(minSection.height, inner.height + pad.top + pad.bottom),
      children: inner.children.map((c) => ({
        item: c.item,
        at: { x: c.at.x + pad.side, y: c.at.y + pad.top },
      })),
    };
  };
  const layoutContainer = (container: string | undefined, depth: number) => {
    const children: { item: Placed; at: Position }[] = [];
    let x = 0,
      top = 0,
      band = 0,
      width = 0;
    // Long columns and wide drawings wrap, so large graphs stay inside the coordinate limit.
    const putColumn = (placed: Placed[]) => {
      const columnWidth = Math.max(...placed.map((p) => p.width));
      if (x > 0 && x + columnWidth > wrap.width) {
        top += band + gap.band;
        x = 0;
        band = 0;
      }
      let y = 0;
      for (const p of placed) {
        children.push({ item: p, at: { x, y: top + y } });
        y += p.height + gap.row;
      }
      band = Math.max(band, y - gap.row);
      width = Math.max(width, x + columnWidth);
      x += columnWidth + gap.column;
    };
    for (const column of columns(container, itemsIn(container))) {
      let part: Placed[] = [],
        height = 0;
      for (const p of column.map((i) => place(i, depth))) {
        if (part.length && height + p.height > wrap.height) {
          putColumn(part);
          part = [];
          height = 0;
        }
        part.push(p);
        height += p.height + gap.row;
      }
      if (part.length) putColumn(part);
    }
    return { children, width, height: top + band };
  };

  const positions = new Map<string, Position>(),
    frames = new Map<string, GraphSectionBounds>();
  const record = (p: Placed, at: Position) => {
    if (p.kind === 'node') positions.set(p.id, at);
    else {
      frames.set(p.id, { x: at.x, y: at.y, width: p.width, height: p.height });
      for (const c of p.children ?? []) record(c.item, { x: at.x + c.at.x, y: at.y + c.at.y });
    }
  };
  for (const c of layoutContainer(undefined, 1).children)
    record(c.item, { x: origin.x + c.at.x, y: origin.y + c.at.y });

  const intents: GraphIntent[] = [];
  graph.nodes.forEach((n, index) => {
    const to = positions.get(n.id);
    const saved = graph.presentation.nodes[n.id] ?? defaultGraphPosition(index);
    if (to && (saved.x !== to.x || saved.y !== to.y))
      intents.push({ type: 'move-node', id: n.id, position: to });
  });
  for (const s of graph.sections) {
    const to = frames.get(s.id)!,
      { x, y, width, height } = graph.presentation.sections[s.id];
    if (canonicalJson({ x, y, width, height }) !== canonicalJson(to))
      intents.push({ type: 'resize-section', id: s.id, bounds: to });
  }
  return intents;
}
