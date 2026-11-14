/**
 * PMI on screen (docs/cad/pmi.md, 表示と操作): an item's targets as marks on a body's mesh and its
 * presentation lines, shared by a body's PMI (PMI-2..4) and a placed part's (PMI-5b).
 */
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { CadTopologyPick } from './viewport';
import {
  cadPmiTrackedIndex,
  placePmiPoint,
  type CadPmiAsset,
  type CadPmiItem,
  type CadPmiItemState,
  type CadPmiKind,
  type CadPmiPlacement,
  type CadPmiTarget,
  type CadPmiTracking,
  type Vec3,
} from '@editor-platform/cad-core';

/**
 * PMI-2: an item's targets as marks on its body's mesh: the pick table lists the body's faces and
 * edges in the same map order as the asset's indices. A location dimension's second end has its
 * own colour. Vertices are listed, not drawn.
 */
/**
 * The faces and edges an item targets, as pick ids of the body's mesh: by their own index when
 * the body is the import, through the evaluation's tracking after a change (PMI-4a).
 */
export function pmiMarks(mesh: CadMesh, item: CadPmiItem, tracking?: CadPmiTracking) {
  const marks: { pick: CadTopologyPick; color: string }[] = [];
  const add = (targets: CadPmiTarget[], color: string) => {
    for (const t of targets) {
      const i = tracking ? cadPmiTrackedIndex(tracking, t) : t.index - 1;
      if (i === undefined || i < 0) continue;
      if (t.shape === 'face' && i < mesh.topology.faces.length)
        marks.push({
          pick: { bodyId: mesh.bodyId, kind: 'face', id: mesh.faceBase + 1 + i },
          color,
        });
      else if (t.shape === 'edge' && i < mesh.topology.edges.length)
        marks.push({
          pick: { bodyId: mesh.bodyId, kind: 'edge', id: mesh.edgeBase + 1 + i },
          color,
        });
    }
  };
  add(item.targets, pmiTargetColour);
  if (item.kind === 'dimension') add(item.targets2 ?? [], pmiSecondColour);
  return marks;
}
export const pmiTargetColour = '#e8590c';
/** PMI-3a: presentation lines, and the focused item's (in the targets' colour). */
export const pmiLineColour = '#2b8a3e';
/**
 * PMI-3a: the presentation lines of a body's asset as viewport segments, placed where the body is
 * and relative to its mesh origin; the last few results are kept, as a large file's lines are
 * many and the viewport redraws on every selection.
 */
export class PmiLineCache {
  private readonly entries = new Map<string, { segments: Float32Array; color: string }[]>();
  private readonly ids = new WeakMap<object, number>();
  private next = 0;
  private idOf(o: object) {
    let id = this.ids.get(o);
    if (id === undefined) this.ids.set(o, (id = this.next++));
    return id;
  }
  get(
    asset: CadPmiAsset,
    placements: CadPmiPlacement[],
    origin: Vec3,
    focusId: string | undefined,
    viewId?: string,
    /** PMI-4a: after a change of the shape, only the current items are drawn. */
    states?: ReadonlyMap<string, CadPmiItemState>,
  ): { segments: Float32Array; color: string }[] {
    const key = JSON.stringify([
      this.idOf(asset),
      states ? this.idOf(states) : null,
      placements,
      origin,
      focusId ?? null,
      viewId ?? null,
    ]);
    const hit = this.entries.get(key);
    if (hit) return hit;
    // With a view shown, only the ranges (callouts) that view lists; otherwise all lines.
    const segmentsOf = (i: CadPmiItem): number[] => {
      const p = i.presentation;
      if (!p) return [];
      if (viewId === undefined || !p.ranges) return p.segments;
      let from = 0;
      return p.ranges.flatMap((range) => {
        const part = range.views.includes(viewId) ? p.segments.slice(from, range.end) : [];
        from = range.end;
        return part;
      });
    };
    const line = (items: CadPmiItem[]) => {
      const parts = items.map(segmentsOf);
      const n = parts.reduce((k, s) => k + s.length, 0);
      const out = new Float32Array(n);
      let at = 0;
      for (const s of parts) {
        for (let k = 0; k < s.length; k += 3) {
          const p = placePmiPoint(placements, [s[k]!, s[k + 1]!, s[k + 2]!]);
          out[at++] = p[0] - origin[0];
          out[at++] = p[1] - origin[1];
          out[at++] = p[2] - origin[2];
        }
      }
      return out;
    };
    const shown = asset.items.filter(
      (i) =>
        i.presentation &&
        (viewId === undefined || i.views?.includes(viewId)) &&
        (!states || states.get(i.id)?.current === true),
    );
    const focused = shown.filter((i) => i.id === focusId);
    const rest = shown.filter((i) => i.id !== focusId);
    const lines = [
      ...(rest.length ? [{ segments: line(rest), color: pmiLineColour }] : []),
      ...(focused.length ? [{ segments: line(focused), color: pmiTargetColour }] : []),
    ];
    if (this.entries.size >= 8) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, lines);
    return lines;
  }
}
export const pmiSecondColour = '#1c7ed6';
export const pmiKindTitles: Record<CadPmiKind, string> = {
  dimension: 'Dimensions',
  'geometric-tolerance': 'Geometric tolerances',
  datum: 'Datums',
  'datum-target': 'Datum targets',
};
export const targetCount = (item: CadPmiItem) => {
  const all = [...item.targets, ...(item.kind === 'dimension' ? (item.targets2 ?? []) : [])];
  const n = (kind: string, one: string, many: string) => {
    const c = all.filter((t) => t.shape === kind).length;
    return c ? [`${c} ${c === 1 ? one : many}`] : [];
  };
  return [
    ...n('face', 'face', 'faces'),
    ...n('edge', 'edge', 'edges'),
    ...n('vertex', 'vertex', 'vertices'),
  ].join(', ');
};
