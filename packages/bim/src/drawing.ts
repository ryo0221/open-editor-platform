import {
  bimContentHash,
  bimCutClass,
  bimCutLoops,
  bimDrawingLimits,
  bimDrawingMesh,
  bimDrawingPrimitives,
  bimDrawingSvg,
  bimDrawingSymbols,
  bimBoxSide,
  bimDrawnByKernel,
  bimElementBox,
  bimGeometry,
  bimLocalPlane,
  bimOutsideFrame,
  bimPlacedPoint,
  bimPlaneInRange,
  bimViewFrame,
  deriveBim,
  type BimBox,
  type BimPlacement,
  type BimDocument,
  type BimDrawing,
  type BimDrawingItem,
  type BimView,
  type Vec2,
} from '@editor-platform/bim-core';
import {
  geometryOrder,
  type GeometryOp,
  type GeometryVec3,
  type GeometryRequest,
} from '@editor-platform/geometry-core';
import type { BimKernel } from './evaluate';
import type { BimPartStatus } from './parts';
import { bimKernelLimits } from './port';

/**
 * A view's drawing (docs/cad/r2c-architecture.md, 平面図と断面図; R2c-U7, R2c-5): each element
 * the view draws is cut exactly by the kernel (`section`), what lies beyond the cut is projected
 * with hidden lines removed (`projection` of one compound, so one element hides another), at the
 * fixed drawing tessellation (`bimDrawingMesh`), and the symbols and annotations come from
 * `bimDrawingSymbols`. The drawing is derived data: it never changes the document.
 */

/** Elements per kernel job for the cuts, as the evaluator batches solids. */
const batch = 64;

export type BimDrawingResult =
  | { status: 'ok'; drawing: BimDrawing }
  | { status: 'error'; code: string };

export async function drawBim(
  doc: BimDocument,
  view: BimView,
  kernel: BimKernel,
  options: {
    assets?: Map<string, Uint8Array>;
    /** Placed parts' shapes, by content hash: a sheet's cut is a line, never a filled area. */
    parts?: ReadonlyMap<string, BimPartStatus>;
    signal?: AbortSignal;
  } = {},
): Promise<BimDrawingResult> {
  const derived = deriveBim(doc);
  const geometry = bimGeometry(doc, derived);
  const frame = bimViewFrame(doc, view);
  const assets = options.assets ?? new Map<string, Uint8Array>();
  const nodes: Record<string, GeometryOp> = { ...geometry.graph.nodes };
  const failed: BimDrawing['failed'] = [];

  const shapeOf = (el: BimDocument['elements'][number]) => {
    if (el.kind !== 'part') return undefined;
    const type = doc.types.find((t) => t.id === el.typeId);
    const status = type?.kind === 'part' ? options.parts?.get(type.source.contentHash) : undefined;
    return status?.status === 'available' ? status : undefined;
  };
  /** A part's bodies: a sheet has no inside, so its cut is a line, never a filled area. */
  const bodies = (el: BimDocument['elements'][number]) => shapeOf(el)?.kinds;
  /** A placed part's box: the corners of its shape's bounds, put in place. */
  const partBox = (el: BimDocument['elements'][number], placement?: BimPlacement) => {
    const bounds = shapeOf(el)?.bounds;
    if (!bounds || !placement) return undefined;
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      bimPlacedPoint(
        [bounds[i & 1]![0], bounds[(i >> 1) & 1]![1], bounds[(i >> 2) & 1]![2]],
        placement,
      ),
    );
    return [0, 1].map((m) =>
      [0, 1, 2].map((k) => (m ? Math.max : Math.min)(...corners.map((c) => c[k]!))),
    ) as BimBox;
  };

  // Each drawn element in place, what of it is cut (a part's solids, outlined once where they
  // overlap, and its sheet apart), and the part of it the view sees (between cut and depth).
  // A placed solid is cut and clipped in its own frame, where its shape is within the kernel's
  // coordinate limit, and only then put in place: a view's planes reach it however far it is.
  const drawn: {
    id: string;
    cut: { origin: GeometryVec3; normal: GeometryVec3 };
    cuts: { node: string; sheet: boolean }[];
    seen: string;
    placement?: BimPlacement;
  }[] = [];
  for (const el of doc.elements) {
    if (!bimDrawnByKernel(view, el.kind)) continue;
    const g = geometry.elements.get(el.id);
    if (!g) {
      // Not derived (the evaluation names why); voids have no solid of their own.
      if (derived.shapes.get(el.id)?.kind !== 'void')
        failed.push({ id: el.id, code: 'not-derived' });
      continue;
    }
    // Wholly outside what the view keeps: nothing of it is cut or seen, so the kernel is not
    // asked (a drawing of one storey of a tall building cuts that storey, not the building).
    const box = bimElementBox(doc, derived, el.id) ?? partBox(el, g.placement);
    if (box && bimOutsideFrame(frame, box)) continue;
    const local = <T extends { origin: GeometryVec3; normal: GeometryVec3 }>(plane: T) =>
      bimPlaneInRange(g.placement ? bimLocalPlane(plane, g.placement) : plane);
    let seen = g.node;
    frame.keep.forEach((k, i) => {
      // A plane it lies wholly on the kept side of would keep all of it.
      if (box && bimBoxSide(k, box) === k.keep) return;
      const id = `${el.id}\u0000draw:keep${i}`;
      nodes[id] = { op: 'halfSpace', input: seen, ...local(k) };
      seen = id;
    });
    if (g.placement) {
      const id = `${el.id}\u0000draw:seen`;
      nodes[id] = {
        op: 'transform',
        input: seen,
        rotation: g.placement.rotation,
        translation: g.placement.translation,
      };
      seen = id;
    }
    const kinds = bodies(el);
    // What the cut plane does not reach has no cut.
    const cutNodes =
      box && bimBoxSide(frame.cut, box) !== 'both'
        ? []
        : kinds
          ? (['solid', 'sheet'] as const)
              .filter((k) => kinds.includes(k))
              .map((k) => {
                const id = `${el.id}\u0000draw:${k}`;
                nodes[id] = { op: 'bodies', input: g.node, kind: k };
                return { node: id, sheet: k === 'sheet' };
              })
          : [{ node: g.node, sheet: false }];
    drawn.push({
      id: el.id,
      cut: local(frame.cut),
      cuts: cutNodes,
      seen,
      ...(g.placement ? { placement: g.placement } : {}),
    });
  }

  const run = async (requests: GeometryRequest[], timeoutMs?: number) => {
    const sub: Record<string, GeometryOp> = {};
    for (const r of requests) for (const n of geometryOrder({ nodes }, r.node)) sub[n] = nodes[n]!;
    return kernel.run(
      { nodes: sub },
      requests,
      assets,
      options.signal,
      timeoutMs ? { timeoutMs } : undefined,
    );
  };

  // The cuts, and whether anything of each element is left to see. A job that times out is
  // split, as the evaluator's are, until the element at fault is alone and named.
  const cuts: BimDrawingItem[] = [];
  const visible: string[] = [];
  const queue: (typeof drawn)[] = [];
  for (let i = 0; i < drawn.length; i += batch) queue.push(drawn.slice(i, i + batch));
  while (queue.length) {
    const part = queue.shift()!;
    const out = await run(
      part.flatMap((d) => [
        ...d.cuts.map((c) => ({ node: c.node, section: d.cut })),
        { node: d.seen, measure: true },
      ]),
    );
    if (out.status === 'timeout') {
      if (part.length > 1) {
        const half = Math.ceil(part.length / 2);
        queue.unshift(part.slice(0, half), part.slice(half));
      } else failed.push({ id: part[0]!.id, code: 'element-timeout' });
      continue;
    }
    if (out.status !== 'ok') return { status: 'error', code: kernelCode(out) };
    let at = 0;
    for (const d of part) {
      const results = out.results.slice(at, at + d.cuts.length + 1);
      at += d.cuts.length + 1;
      const seen = results.at(-1)!;
      const bad = results.slice(0, -1).find((r) => r.status !== 'ok');
      if (bad?.status === 'error') {
        failed.push({ id: d.id, code: bad.code });
        continue;
      }
      const filled: Vec2[][] = [];
      const lines: Vec2[][] = [];
      d.cuts.forEach((c, k) => {
        const r = results[k]!;
        const { loops, open } = bimCutLoops(
          r.status === 'ok' ? (r.section ?? []) : [],
          d.placement ? (p) => frame.toView(bimPlacedPoint(p, d.placement!)) : frame.toView,
        );
        // A sheet has no inside: even a closed cut of it is a line (closed by its first point).
        if (c.sheet) lines.push(...loops.map((l) => [...l, l[0]!]), ...open);
        else {
          filled.push(...loops);
          lines.push(...open);
        }
      });
      if (filled.length || lines.length)
        cuts.push({
          type: 'polygon',
          loops: filled,
          ...(lines.length ? { open: lines } : {}),
          cls: bimCutClass(doc, d.id),
          id: d.id,
        });
      // Nothing between the cut and the depth (`empty-result`): not seen. Any other failure of
      // the clip leaves the element out of what is seen, so it is named.
      if (seen.status === 'ok') visible.push(d.seen);
      else if (seen.code !== 'empty-result') failed.push({ id: d.id, code: seen.code });
    }
  }

  // What lies beyond the cut, all at once so one element hides another.
  const seenItems: BimDrawingItem[] = [];
  if (visible.length) {
    nodes['draw\u0000seen'] = { op: 'compound', inputs: visible };
    // One job for all of it (one element hides another), so it has the projection's limit.
    const out = await run(
      [
        {
          node: 'draw\u0000seen',
          projection: { direction: frame.direction, up: frame.up, ...bimDrawingMesh },
        },
      ],
      bimKernelLimits.projectionTimeoutMs,
    );
    if (out.status !== 'ok') return { status: 'error', code: kernelCode(out) };
    const r = out.results[0]!;
    if (r.status !== 'ok') return { status: 'error', code: r.code };
    seenItems.push({ type: 'segments', points: [...(r.projection?.visible ?? [])], cls: 'seen' });
  }

  const drawing: BimDrawing = {
    viewId: view.id,
    kind: view.kind,
    name: view.name,
    scale: view.scale,
    // Beyond first, then the cuts over it, then symbols and annotations on top.
    items: [...seenItems, ...cuts, ...bimDrawingSymbols(doc, view, derived)],
    failed: failed.sort((a, b) => a.id.localeCompare(b.id)),
  };
  if (bimDrawingPrimitives(drawing) > bimDrawingLimits.primitives)
    return { status: 'error', code: 'drawing-too-large' };
  // Its SVG must fit too: written once here, so an export never meets a drawing it cannot write.
  try {
    bimDrawingSvg(drawing);
  } catch {
    return { status: 'error', code: 'drawing-too-large' };
  }
  return { status: 'ok', drawing };
}

const kernelCode = (out: { status: string; code?: string }) =>
  out.status === 'error' ? out.code! : out.status === 'invalid' ? 'graph-invalid' : out.status;

/**
 * Drawings by content: the same document, view and part shapes give the same drawing, read once
 * (R2c-5: a drawing is derived data, cached by the content hash like an evaluation).
 */
export class BimDrawings {
  private readonly cache = new Map<string, Promise<BimDrawingResult>>();
  constructor(private readonly kernel: BimKernel) {}
  draw(
    doc: BimDocument,
    view: BimView,
    assets: Map<string, Uint8Array> = new Map(),
    parts?: ReadonlyMap<string, BimPartStatus>,
  ) {
    // The shapes read so far, and what kind of bodies each has (it changes how a cut is drawn).
    const shapes = [...assets.keys()].sort().map((h) => {
      const status = parts?.get(h);
      return status?.status === 'available' ? `${h}:${status.kinds.join('+')}` : h;
    });
    const key = [bimContentHash(doc), JSON.stringify(view), shapes.join()].join('\u0000');
    let result = this.cache.get(key);
    if (!result) {
      result = drawBim(doc, view, this.kernel, { assets, parts });
      // A kernel failure is not kept, nor a drawing with an element that timed out: the next
      // draw tries again.
      void result.then(
        (r) =>
          (r.status === 'error' || r.drawing.failed.some((f) => f.code === 'element-timeout')) &&
          this.cache.delete(key),
      );
      this.cache.set(key, result);
      // A small cache: drawings are big.
      if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }
}
