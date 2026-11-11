import { type Object3D, Raycaster, Vector3 } from 'three';
import { instancePath } from '@editor-platform/geometry-view';

type Bounds = [[number, number, number], [number, number, number]];

/**
 * FU5: the directions to try for a view of a selection: the current one, then round the vertical
 * axis in 30° steps either way from `toward` (the current one when not given) at the current
 * height, nearest first, then the same from 35° and 65° above. Unit vectors from the selection
 * towards the camera.
 */
export function bimViewDirections(current: Vector3, toward?: Vector3): Vector3[] {
  const d = current.clone().normalize();
  const up = Math.asin(Math.max(-1, Math.min(1, d.z)));
  const from = toward && Math.hypot(toward.x, toward.y) > 1e-9 ? toward : d;
  const azimuth = Math.atan2(from.y, from.x);
  const turns = [0];
  for (let k = 1; k <= 5; k++) turns.push(k, -k);
  turns.push(6);
  const out: Vector3[] = [d];
  const add = (a: number, e: number) => {
    const v = new Vector3(Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e));
    if (!out.some((o) => o.distanceToSquared(v) < 1e-9)) out.push(v);
  };
  for (const e of [up, (35 * Math.PI) / 180, (65 * Math.PI) / 180])
    for (const k of turns) add(azimuth + (k * Math.PI) / 6, e);
  return out;
}

/**
 * FU5: how many of the selection's sample points (its box's centre and the corners of the box
 * shrunk halfway to it) a camera `distance` from the centre along `dir` sees: no opaque solid of
 * another element lies between. Transparent solids (spaces, glass) and edges never hide.
 */
export function bimVisibleSamples(
  objects: readonly Object3D[],
  bounds: Bounds,
  dir: Vector3,
  distance: number,
  selected: ReadonlySet<string>,
): number {
  const [lo, hi] = bounds;
  const center = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  const eye = center.clone().addScaledVector(dir, distance);
  const samples = [center];
  for (const x of [lo[0], hi[0]])
    for (const y of [lo[1], hi[1]])
      for (const z of [lo[2], hi[2]])
        samples.push(new Vector3(x, y, z).add(center).multiplyScalar(0.5));
  const ray = new Raycaster();
  let seen = 0;
  for (const p of samples) {
    // From the eye to the point, so the faces met are those drawn towards the camera (solids
    // draw their front faces only, and a face's material can differ from the other side's).
    const to = p.clone().sub(eye);
    const far = to.length();
    if (!(far > 0)) continue;
    ray.set(eye, to.divideScalar(far));
    ray.far = far;
    const hits = ray.intersectObjects(objects as Object3D[], false);
    const hidden = hits.some((h) => {
      if (h.object.type === 'LineSegments' || h.object.type === 'Points') return false;
      const material = (h.object as { material?: { transparent?: boolean } }).material;
      if (material?.transparent) return false;
      const id = instancePath(h)?.[0];
      return id === undefined || !selected.has(id);
    });
    if (!hidden) seen++;
  }
  return seen;
}

/**
 * FU5: the direction to look at a selection from: the current one when nothing hides any of its
 * sample points, else the try that sees the most of them, turning first to the side away from
 * the middle of the building `around` (the outside of a tower), then nearest that.
 */
export function bimClearDirection(
  objects: readonly Object3D[],
  bounds: Bounds,
  current: Vector3,
  distance: number,
  selected: ReadonlySet<string>,
  around?: Bounds,
): Vector3 {
  const [lo, hi] = bounds;
  const outward =
    around &&
    new Vector3(
      lo[0] + hi[0] - around[0][0] - around[1][0],
      lo[1] + hi[1] - around[0][1] - around[1][1],
      0,
    );
  const tries = bimViewDirections(current, outward);
  let best = tries[0]!;
  let most = -1;
  for (const dir of tries) {
    const seen = bimVisibleSamples(objects, bounds, dir, distance, selected);
    if (seen > most) [best, most] = [dir, seen];
    if (seen === 9) break;
  }
  return best;
}
