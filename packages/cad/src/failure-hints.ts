/**
 * #13: a shape-evaluation failure as a typed reason, the elements it is about (stable IDs) and a
 * concrete hint, for the feature tree and for headless callers alike. Known classes:
 *
 * - `loft-section-start`: a loft fails and a section's loop starts on the other side from its
 *   neighbour's (closed splines especially), so the kernel cannot pair the sections.
 * - `loft-sections`: a loft fails for another reason (shape or spacing of the sections).
 * - `profile-crossing`: two elements of a sketch region cross or touch away from a shared end.
 * - `spline-self-crossing`: a spline crosses itself.
 * - `mirrored-part`: the failure is on a body built from a mirror (or a mirror copy), i.e. only
 *   on the reflected side.
 *
 * Pure: reads the document only.
 */
import {
  sketchElement,
  sketchElementPoints,
  sketchRegion,
  upstreamFeatures,
  type CadDocument,
  type CadFeature,
  type CadSketch,
  type CadSketchRegion,
} from '@editor-platform/cad-core';

export type CadFailureReason =
  | 'loft-section-start'
  | 'loft-sections'
  | 'profile-crossing'
  | 'spline-self-crossing'
  | 'mirrored-part';
export interface CadFailureHint {
  reason: CadFailureReason;
  /** The elements the hint is about: sketch element IDs, or `sections[i]` of a loft. */
  elements: string[];
  hint: string;
}
type Pt = [number, number];

/** A loop's points in order from its start, along each element's direction in the loop. */
function loopPoints(s: CadSketch, ids: string[]): Pt[] | undefined {
  const els = ids.map((id) => sketchElement(s, id));
  if (els.some((e) => !e)) return;
  const out: Pt[] = [];
  let end: string | undefined;
  for (const [i, e] of els.entries()) {
    let pts = sketchElementPoints(e!) as Pt[];
    const ends = (e as { ends: string[] }).ends;
    if (ends.length === 2) {
      const next = els[i + 1] as { ends?: string[] } | undefined;
      const forward =
        end !== undefined ? ends[0] === end : !next?.ends || next.ends.includes(ends[1]!);
      if (!forward) pts = [...pts].reverse();
      end = forward ? ends[1] : ends[0];
    }
    out.push(...pts);
  }
  return out;
}
const angleOf = (pts: Pt[]) => {
  const c = pts.reduce<Pt>((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  return Math.atan2(pts[0]![1] - c[1], pts[0]![0] - c[0]);
};
/** How far apart (radians, about the loop's centre) a section's start may be from its neighbour's. */
export const LOFT_START_TOLERANCE = Math.PI / 4;

/** `v` rotated by the unit quaternion `q` = [x, y, z, w]. */
function rotate(q: [number, number, number, number], v: [number, number, number]) {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0]! + (y * t[2]! - z * t[1]!),
    v[1] + w * t[1]! + (z * t[0]! - x * t[2]!),
    v[2] + w * t[2]! + (x * t[1]! - y * t[0]!),
  ] as [number, number, number];
}

function loftHint(doc: CadDocument, f: Extract<CadFeature, { type: 'loft' }>): CadFailureHint {
  // Each section's start direction (from its loop's centre) in world space: local UV angles of
  // sketches on differently oriented planes are not comparable. A sketch on a face has no frame
  // here, so no start diagnosis is made for it.
  const starts = f.args.sections.map((sec) => {
    if (!('sketchId' in sec)) return undefined;
    const s = doc.sketches.find((x) => x.id === sec.sketchId);
    if (!s || !('orientation' in s.plane)) return undefined;
    const pts = loopPoints(s, sec.region.outer);
    if (!pts?.length) return undefined;
    const a = angleOf(pts);
    return rotate(s.plane.orientation, [Math.cos(a), Math.sin(a), 0]);
  });
  const off: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const [a, b] = [starts[i - 1], starts[i]];
    if (!a || !b) continue;
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
    if (Math.acos(Math.max(-1, Math.min(1, cos))) > LOFT_START_TOLERANCE) off.push(i);
  }
  if (off.length) {
    const names = off.map((i) => `sections[${i}]`);
    return {
      reason: 'loft-section-start',
      elements: names,
      hint: `断面 ${off.map((i) => `${i + 1} 番目`).join('・')}の輪の始点が、前の断面と反対の側にあります。各断面の輪を同じ向き・同じ側の点から始まるようにそろえてください（閉じたsplineは最初の制御点の位置で始点が決まります）。`,
    };
  }
  return {
    reason: 'loft-sections',
    elements: f.args.sections.map((_, i) => `sections[${i}]`),
    hint: '隣り合う断面の形や大きさの差を小さくするか、断面の間隔を広げるか、断面の数を減らしてください。',
  };
}

/** The first pair of elements of `region` that cross or touch away from a shared end, and where. */
export function regionCrossing(
  s: CadSketch,
  region: CadSketchRegion,
): { a: string; b: string; at: Pt } | undefined {
  const r = sketchRegion(s, region);
  if (!('code' in r) || (r.code !== 'region-self-intersection' && r.code !== 'region-overlap'))
    return;
  const ids = [region.outer, ...region.holes].flat();
  // End points by the IDs the element exposes (`ends`), so a spline's ends (its first and last
  // poles) count as shared joins like a line's.
  const polys = ids.map((id) => {
    const e = sketchElement(s, id);
    return {
      id,
      pts: e ? (sketchElementPoints(e) as Pt[]) : [],
      ends: ((e as { ends?: string[] } | undefined)?.ends ?? []).filter((k) => s.solved[k]),
    };
  });
  const endPts = (p: (typeof polys)[number]) => p.ends.map((k) => s.solved[k] as Pt);
  for (let i = 0; i < polys.length; i++)
    for (let j = i + 1; j < polys.length; j++) {
      const shared = endPts(polys[i]!).filter((p) =>
        endPts(polys[j]!).some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6),
      );
      const hit = polylineHit(polys[i]!.pts, polys[j]!.pts, shared);
      if (hit) return { a: polys[i]!.id, b: polys[j]!.id, at: hit };
    }
}
function polylineHit(p: Pt[], q: Pt[], shared: Pt[]): Pt | undefined {
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++) {
      const x = segmentHit(p[i - 1]!, p[i]!, q[j - 1]!, q[j]!);
      if (x && !shared.some((s) => Math.hypot(s[0] - x[0], s[1] - x[1]) < 1e-3)) return x;
    }
}
function segmentHit(a: Pt, b: Pt, c: Pt, d: Pt): Pt | undefined {
  const r: Pt = [b[0] - a[0], b[1] - a[1]],
    s: Pt = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9
    ? [a[0] + t * r[0], a[1] + t * r[1]]
    : undefined;
}
const mm = (x: number) => (Math.round(x * 10) / 10).toString();

/** The sketch regions a feature reads (profile, sections, region). */
function regionsOf(f: CadFeature): { sketchId: string; region: CadSketchRegion }[] {
  const out: { sketchId: string; region: CadSketchRegion }[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (typeof o.sketchId === 'string' && o.region && typeof o.region === 'object')
      out.push({ sketchId: o.sketchId, region: o.region as CadSketchRegion });
    else for (const x of Object.values(o)) visit(x);
  };
  visit(f.args);
  return out;
}

/**
 * The typed reason, elements and hint for a failure at `elementId` (a feature or a sketch), or
 * undefined when the failure is none of the known classes.
 */
export function cadFailureHint(
  doc: CadDocument,
  code: string,
  elementId?: string,
): CadFailureHint | undefined {
  const base = code.replace(/^cad-invalid:/, '').split(/[:@]/)[0]!;
  // A refused edit names no element: the validator's path (`@features[i]…`) says which one.
  const indexIn = (list: string) => {
    const i = new RegExp(`@(?:\\$\\.)?${list}\\[(\\d+)\\]`).exec(code)?.[1];
    return i === undefined ? undefined : Number(i);
  };
  const fi = indexIn('features'),
    si = indexIn('sketches');
  const feature =
    doc.features.find((f) => f.id === elementId) ??
    (elementId === undefined && fi !== undefined ? doc.features[fi] : undefined);
  const sketch =
    doc.sketches.find((s) => s.id === elementId) ??
    (elementId === undefined && si !== undefined ? doc.sketches[si] : undefined);
  if (feature?.type === 'loft' && (base === 'kernel-exception' || base.startsWith('loft')))
    return loftHint(doc, feature);
  if (base === 'sketch-self-intersection') {
    const at = /entities\[(\d+)\]/.exec(code)?.[1];
    const s =
      sketch ??
      doc.sketches.find((x) => feature && regionsOf(feature).some((r) => r.sketchId === x.id));
    const id = at !== undefined ? s?.entities[Number(at)]?.id : undefined;
    return {
      reason: 'spline-self-crossing',
      elements: id ? [id] : [],
      hint: `スプライン${id ? ` ${id}` : ''}が自分と交わっています。交わっている所の近くの制御点を、線が交差しない側へ動かしてください。`,
    };
  }
  if (base === 'region-self-intersection' || base === 'region-overlap') {
    const pairs = feature ? regionsOf(feature) : [];
    for (const { sketchId, region } of pairs) {
      const s = doc.sketches.find((x) => x.id === sketchId);
      const hit = s && regionCrossing(s, region);
      if (hit)
        return {
          reason: 'profile-crossing',
          elements: [hit.a, hit.b],
          hint: `スケッチ「${s!.name ?? s!.id}」の ${hit.a} が ${hit.b} と (${mm(hit.at[0])}, ${mm(hit.at[1])}) mm 付近で交わっています。どちらかの端点を動かして交わらないようにするか、交わる所で線を分けて別の輪にしてください。`,
        };
    }
    return {
      reason: 'profile-crossing',
      elements: [],
      hint: 'スケッチの輪の中で交わっている線を探し、交わらないように端点を動かしてください。',
    };
  }
  if (feature) {
    // The failing mirror itself, else the mirror nearest upstream (the last one before it).
    const isMirror = (f: CadFeature) => f.type === 'mirror' || f.type === 'mirrorCopy';
    const chain = upstreamFeatures(doc.features, [feature.id]);
    const mirror = isMirror(feature)
      ? feature
      : [...doc.features]
          .reverse()
          .find((f) => f.id !== feature.id && chain.has(f.id) && isMirror(f));
    if (mirror)
      return {
        reason: 'mirrored-part',
        elements: [mirror.id],
        hint: `鏡写し「${mirror.name ?? mirror.id}」（${mirror.id}）で作った側の形で失敗しています。元の側は作れているので、鏡写しの面の近くの形（面に接する・面をまたぐ部分）を見直すか、鏡写しの前の形で操作してから鏡写しにしてください。`,
      };
  }
  return undefined;
}
