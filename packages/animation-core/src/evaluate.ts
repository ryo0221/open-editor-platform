import {
  requireAnimation as check,
  type Transform,
  type AnimationContent,
  type Composition,
} from './model';
import { preparedState, resolveLayer, type PreparedAnimation } from './prepare';
import { tick as validateTick } from './validate';
import { sampleKeys, mapNestedTick } from './time';
export type Matrix = [number, number, number, number, number, number];
export interface SceneRect {
  instancePath: string[];
  layerId: string;
  matrix: Matrix;
  opacity: number;
  width: number;
  height: number;
  fill: string;
}
export interface EvaluatedScene {
  schemaVersion: 'animation-scene-prototype-0' | 'animation-rectangle-scene-1';
  evaluatorVersion: PreparedAnimation['evaluatorVersion'];
  contentHash: string;
  compositionId: string;
  tick: number;
  width: number;
  height: number;
  rectangles: SceneRect[];
}
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
function multiply(a: Matrix, b: Matrix): Matrix {
  const m: Matrix = [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  check(m.every(Number.isFinite), 'transform-overflow', 'scene');
  return m;
}
function transform(t: Transform): Matrix {
  const r = (t.rotation * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const a = c * t.scaleX,
    b = s * t.scaleX,
    d = c * t.scaleY,
    e = -s * t.scaleY;
  return [a, b, e, d, t.x - a * t.anchorX - e * t.anchorY, t.y - b * t.anchorX - d * t.anchorY];
}
export function evaluateAnimation(
  prepared: PreparedAnimation,
  compositionId: string,
  tick: number,
): EvaluatedScene {
  const state = preparedState(prepared);
  validateTick(tick);
  const root = state.root.compositions.find((c) => c.id === compositionId);
  check(root && tick <= root.duration, 'sample-range', compositionId);
  const rectangles: SceneRect[] = [];
  const visit = (
    content: AnimationContent,
    c: Composition,
    t: number,
    base: Matrix,
    opacity: number,
    path: string[],
  ) => {
    const poses = new Map(c.layers.map((l) => [l.id, { ...l.transform }]));
    for (const track of c.tracks)
      poses.get(track.layerId)![track.property] = sampleKeys(track.keys, t);
    const active = (start: number, end: number) =>
      t >= start && (t < end || (t === c.duration && end === c.duration));
    const worlds = new Map<string, { matrix: Matrix; opacity: number; active: boolean }>();
    const world = (id: string): { matrix: Matrix; opacity: number; active: boolean } => {
      if (worlds.has(id)) return worlds.get(id)!;
      const l = c.layers.find((l) => l.id === id)!;
      const p = l.parentId ? world(l.parentId) : { matrix: base, opacity, active: true };
      const pose = poses.get(id)!;
      const result = {
        matrix: multiply(p.matrix, transform(pose)),
        opacity: p.opacity * pose.opacity,
        active: p.active && active(l.start, l.end),
      };
      worlds.set(id, result);
      return result;
    };
    for (const l of c.layers) {
      const w = world(l.id);
      if (!w.active) continue;
      if (l.type === 'rect')
        rectangles.push({
          instancePath: [...path, l.id],
          layerId: l.id,
          matrix: w.matrix,
          opacity: w.opacity,
          width: l.width,
          height: l.height,
          fill: l.fill,
        });
      if (l.type === 'composition') {
        const child = resolveLayer(state, content, l);
        const mapped = mapNestedTick(
          t - l.start,
          content.ticksPerSecond,
          child.content.ticksPerSecond,
          l.time,
        );
        if (mapped !== null)
          visit(child.content, child.composition, mapped, w.matrix, w.opacity, [...path, l.id]);
      }
    }
  };
  visit(state.root, root, tick, identity(), 1, [compositionId]);
  return {
    schemaVersion:
      state.root.schemaVersion === 1
        ? 'animation-rectangle-scene-1'
        : 'animation-scene-prototype-0',
    evaluatorVersion: prepared.evaluatorVersion,
    contentHash: prepared.contentHash,
    compositionId,
    tick,
    width: root.width,
    height: root.height,
    rectangles,
  };
}
