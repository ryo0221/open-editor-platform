import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppWindow,
  Box,
  BrickWall,
  Columns3,
  DoorOpen,
  Grid3x3,
  Map as MapIcon,
  Minus,
  Package,
  Scissors,
  MousePointer2,
  Spline,
  RectangleHorizontal,
  Square,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react';
import { distance } from '@editor-platform/bim-core';
import { IconButton, isTextInput } from '@editor-platform/editor-ui';
import type { BimController, BimState } from './controller';
import {
  bimBulgeThrough,
  bimEdgePoints,
  bimLoopOfEdges,
  bimSnap,
  bimSnapRadius,
  bimToolPoints,
  bimWallAt,
  draftBeam,
  draftColumn,
  draftGrid,
  draftHosted,
  draftPart,
  draftRegion,
  draftSectionView,
  draftWall,
  type BimDraftTool,
  type BimSnap,
} from './drafting';
import type { BimDraftMarks } from './viewport';

export const bimToolInfo: Record<BimDraftTool, { label: string; icon: LucideIcon; hint: string }> =
  {
    select: { label: 'Select', icon: MousePointer2, hint: '' },
    wall: {
      label: 'Wall',
      icon: BrickWall,
      hint: 'Wall: click the start, then each corner. Double-click or Esc ends the run.',
    },
    slab: {
      label: 'Slab',
      icon: Square,
      hint: 'Slab: click each corner; click the first corner or double-click to close.',
    },
    space: {
      label: 'Space',
      icon: SquareDashed,
      hint: 'Space: click each corner; click the first corner or double-click to close.',
    },
    column: { label: 'Column', icon: Columns3, hint: 'Column: click where it stands.' },
    beam: { label: 'Beam', icon: Minus, hint: 'Beam: click its two ends.' },
    door: { label: 'Door', icon: DoorOpen, hint: 'Door: click on a wall.' },
    window: { label: 'Window', icon: AppWindow, hint: 'Window: click on a wall.' },
    opening: { label: 'Opening', icon: RectangleHorizontal, hint: 'Opening: click on a wall.' },
    part: {
      label: 'Part',
      icon: Package,
      hint: 'Part: click where it stands. It is the part type chosen in Types, or the first.',
    },
    grid: {
      label: 'Grid axis',
      icon: Grid3x3,
      hint: 'Grid axis: click its two ends. Along x it is lettered, along y numbered.',
    },
    section: {
      label: 'Section',
      icon: Scissors,
      hint: 'Section: click the two ends of its line. It looks to the left of the line; open it in Drawings.',
    },
  };

/** OH-U2: the tools that draw arcs when Arc is on, and how. */
export const bimArcTools: ReadonlySet<BimDraftTool> = new Set(['wall', 'slab', 'space']);
export const bimArcHint = 'Arc: after each corner, click the next corner, then a point on the arc.';

/** Clicks this close in time at one point are one double-click, not two placements. */
const doubleClickMs = 500;

/** Narrow screens (the Editor layout's narrow width) keep drawing closed (CAD65). */
const narrowQuery = '(max-width: 800px)';
export function useNarrow() {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(narrowQuery);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => window.matchMedia(narrowQuery).matches,
  );
}

/** Why drawing is closed, or undefined when it is open. */
export function drawingRefusal(state: BimState, narrow: boolean) {
  if (state.readOnly) return 'Read only';
  if (narrow) return 'Drawing needs a wider screen; view, select and edit values here';
  if (!state.level) return 'Add a level first';
  return undefined;
}

/**
 * The drawing in progress on the active level: the points clicked so far and the pointer, each
 * snapped. A finished drawing becomes one operation, applied as one command.
 */
export function useDraft(
  controller: BimController,
  state: BimState,
  tool: BimDraftTool,
  /** The part type to place, when one is chosen. */
  partType?: string,
  /** OH-U2: each new wall or edge is an arc through a third point. */
  arc = false,
) {
  const [points, setPoints] = useState<BimSnap[]>([]);
  // The bulge of the edge from each point to the next (loops), and the next corner of an arc
  // waiting for its point on the arc.
  const [bulges, setBulges] = useState<number[]>([]);
  const [pending, setPending] = useState<BimSnap | undefined>();
  const [hover, setHover] = useState<BimSnap | undefined>();
  // The last one-click placement: the second click of a double-click lands on it again.
  const placed = useRef<{ xy: [number, number]; at: number } | undefined>(undefined);
  const reset = useCallback(() => {
    setPoints([]);
    setBulges([]);
    setPending(undefined);
    setHover(undefined);
  }, []);
  // A new tool or level starts a new drawing; turning Arc off drops a corner waiting for its arc.
  useEffect(reset, [tool, state.level, reset]);
  useEffect(() => setPending(undefined), [arc]);
  useEffect(() => {
    if (tool === 'select') return;
    const onKey = (e: KeyboardEvent) => {
      // Only keys meant for the drawing: nothing focused (a click on the view leaves the body
      // focused) or the view itself. Enter on a toolbar button or a field is that control's.
      const target = e.target;
      if (e.defaultPrevented || isTextInput(target)) return;
      if (
        target !== document.body &&
        !(target instanceof Element && target.closest('.bim-viewport'))
      )
        return;
      if (e.key === 'Escape') reset();
      if (e.key === 'Enter' && bimToolPoints[tool] === 'loop') finish(points, bulges);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const run = (make: () => Parameters<BimController['apply']>[0]) => {
    try {
      return controller.apply(make()) === undefined;
    } catch (error) {
      controller.report({ code: error instanceof Error ? error.message : String(error), ids: [] });
      return false;
    }
  };
  /** Closes a loop; `edges` are the bulges from each corner to the next, the last closing it. */
  const finish = (loop: BimSnap[], edges: number[]) => {
    if (tool !== 'slab' && tool !== 'space') return;
    const level = state.level!;
    // Two corners joined by an arc and closed by a line (or by a second arc) still enclose an
    // area: their arcs are split at their middles, as a loop needs three corners.
    if (loop.length >= 3 || (loop.length === 2 && edges.some((b) => b)))
      run(() =>
        draftRegion(
          state.content,
          level,
          tool,
          bimLoopOfEdges(
            loop.map((p) => p.xy),
            edges,
          ),
        ),
      );
    reset();
  };
  /** The bulge of the arc from `a` to `b` through `m`, or undefined after naming why not. */
  const through = (a: BimSnap, b: BimSnap, m: BimSnap) => {
    try {
      return bimBulgeThrough(a.xy, b.xy, m.xy);
    } catch (error) {
      controller.report({ code: error instanceof Error ? error.message : String(error), ids: [] });
      return undefined;
    }
  };
  const onPlan = (xy: [number, number], kind: 'move' | 'click' | 'double', mmPerPx?: number) => {
    if (tool === 'select' || !state.level) return;
    const doc = state.content;
    const level = state.level;
    const snapMm = bimSnapRadius(mmPerPx);
    const snap = bimSnap(doc, level, xy, { snapMm });
    if (kind === 'move') return setHover(snap);
    const last = points.at(-1);
    if (kind === 'double') {
      if (bimToolPoints[tool] === 'loop') finish(points, bulges);
      else reset();
      return;
    }
    // The clicks of a double-click land on the last point: nothing more to add.
    if (last && distance(last.xy, snap.xy) < 1) return;
    if (pending && distance(pending.xy, snap.xy) < 1) return;
    const arcs = arc && bimArcTools.has(tool);
    if (bimToolPoints[tool] === 'one') {
      const before = placed.current;
      const now = performance.now();
      if (before && now - before.at < doubleClickMs && distance(before.xy, snap.xy) < 1) return;
      placed.current = { xy: snap.xy, at: now };
    }
    switch (tool) {
      case 'column':
        run(() => draftColumn(doc, level, snap));
        return;
      case 'part':
        run(() => draftPart(doc, level, snap, partType));
        return;
      case 'door':
      case 'window':
      case 'opening': {
        const host = bimWallAt(doc, level, xy);
        if (!host) return controller.report({ code: 'no-wall-here', ids: [] });
        run(() => draftHosted(doc, tool, host));
        return;
      }
      case 'grid':
        if (!last) return setPoints([snap]);
        if (run(() => draftGrid(doc, last.xy, snap.xy))) setPoints([]);
        return;
      case 'section':
        if (!last) return setPoints([snap]);
        if (run(() => draftSectionView(doc, last.xy, snap.xy))) setPoints([]);
        return;
      case 'wall':
        if (arcs && last) {
          if (!pending) return setPending(snap);
          const bulge = through(last, pending, snap);
          if (bulge === undefined) return;
          if (run(() => draftWall(doc, level, last, pending, undefined, bulge))) {
            setPoints([pending]);
            setPending(undefined);
          }
          return;
        }
      // falls through
      case 'beam':
        if (!last) return setPoints([snap]);
        if (
          run(() =>
            tool === 'wall' ? draftWall(doc, level, last, snap) : draftBeam(doc, level, last, snap),
          )
        )
          // Walls run on from the end just drawn; a beam is one segment.
          setPoints(tool === 'wall' ? [snap] : []);
        return;
      case 'slab':
      case 'space': {
        const first = points[0];
        const closes = (p: BimSnap) => !!first && distance(first.xy, p.xy) <= snapMm;
        if (arcs && last) {
          // The next corner (the first one closes the loop), then the point on its arc.
          if (!pending) return setPending(closes(snap) && points.length >= 2 ? first : snap);
          const bulge = through(last, pending, snap);
          if (bulge === undefined) return;
          setPending(undefined);
          if (pending === first) return finish(points, [...bulges, bulge]);
          setPoints([...points, pending]);
          setBulges([...bulges, bulge]);
          return;
        }
        // Two corners close too once their edge is an arc (the closing edge is the chord).
        const closable = points.length >= 3 || (points.length === 2 && bulges.some((b) => b));
        if (closable && closes(snap)) return finish(points, bulges);
        setPoints([...points, snap]);
        setBulges(points.length ? [...bulges, 0] : []);
      }
    }
  };
  /** The drawn line: each edge with its arc, then the corner waiting for its arc and the hover. */
  const line = (): [number, number][] => {
    const out: [number, number][] = points.length ? [points[0]!.xy] : [];
    points.forEach((p, i) => {
      if (i) out.push(...bimEdgePoints(points[i - 1]!.xy, p.xy, bulges[i - 1] ?? 0));
    });
    const last = points.at(-1);
    if (last && pending) {
      let bulge = 0;
      try {
        if (hover) bulge = bimBulgeThrough(last.xy, pending.xy, hover.xy);
      } catch {
        // The hover is not on any arc through the two corners: show the chord.
      }
      out.push(...bimEdgePoints(last.xy, pending.xy, bulge));
    } else if (hover) out.push(hover.xy);
    return out;
  };
  const marks: BimDraftMarks | undefined =
    tool === 'select'
      ? undefined
      : {
          points: [...points, ...(pending ? [pending] : [])].map((p) => p.xy),
          ...(hover ? { hover: hover.xy } : {}),
          closed: bimToolPoints[tool] === 'loop',
          line: line(),
        };
  return { onPlan, marks, points: points.length };
}

/** The view switch and, in a plan, the drawing tools. */
export function DraftToolbar({
  plan,
  onPlan,
  tool,
  onTool,
  refusal,
  arc,
  onArc,
}: {
  plan: boolean;
  onPlan(plan: boolean): void;
  tool: BimDraftTool;
  onTool(tool: BimDraftTool): void;
  refusal: string | undefined;
  /** OH-U2: whether the wall, slab and space tools draw arcs. */
  arc: boolean;
  onArc(arc: boolean): void;
}) {
  return (
    <>
      <IconButton icon={Box} label="3D view" aria-pressed={!plan} onClick={() => onPlan(false)} />
      <IconButton icon={MapIcon} label="Plan" aria-pressed={plan} onClick={() => onPlan(true)} />
      {plan &&
        (Object.keys(bimToolInfo) as BimDraftTool[]).map((t) => (
          <IconButton
            key={t}
            icon={bimToolInfo[t].icon}
            label={bimToolInfo[t].label}
            aria-pressed={tool === t}
            disabled={t !== 'select' && !!refusal}
            reason={refusal}
            onClick={() => onTool(t)}
          />
        ))}
      {plan && bimArcTools.has(tool) && (
        <IconButton icon={Spline} label="Arc" aria-pressed={arc} onClick={() => onArc(!arc)} />
      )}
    </>
  );
}
