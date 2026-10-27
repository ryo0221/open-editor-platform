import { sampleBezier3Coordinate } from '@editor-platform/geometry-core/bezier';
import { deepFreeze } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { requireAnimation as check, type Easing, type Transform } from '../model';
import { sampleKeys } from '../time';
import { ownJson, tick as validateTick } from '../validate';
import { readAnimation2, validateProperty2 } from './validate';
import { resolveComposition2 } from './source-resolution';
import { animationSvgPathData2, animationSvgTextData2 } from './svg-data';
import {
  EVALUATOR2,
  MAX_ANIMATION_EXPANDED_SVG_DATA2,
  type AnimationContent2,
  type Composition2,
  type Key2,
  type Layer2,
  type Matrix2,
  type Scene2,
  type SceneClip2,
  type Track2,
  type VectorPath2,
} from './model';
export interface PreparedAnimation2 {
  readonly evaluatorVersion: typeof EVALUATOR2;
  readonly contentHash: string;
}
const states = new WeakMap<PreparedAnimation2, AnimationContent2>();
export function prepareAnimation2(input: unknown): PreparedAnimation2 {
  const content = deepFreeze(readAnimation2(input));
  const token = Object.freeze({ evaluatorVersion: EVALUATOR2, contentHash: reuseHash(content) });
  states.set(token, content);
  return token;
}
/** Frozen native snapshot for trusted resource adapters; unprepared tokens are refused. */
export function preparedAnimationContent2(token: PreparedAnimation2): AnimationContent2 {
  const content = states.get(token);
  check(content, 'unprepared', 'animation2');
  return content;
}
export type AnimationInputValues2 = readonly { inputId: string; value: number | string }[];
export function validateAnimationInputs2(
  content: AnimationContent2,
  values: AnimationInputValues2,
) {
  values = ownJson(values) as AnimationInputValues2;
  check(Array.isArray(values) && values.length <= 1000, 'inputs', 'values');
  const seen = new Set<string>();
  for (const value of values) {
    check(
      value &&
        typeof value === 'object' &&
        Object.keys(value).sort().join(',') === 'inputId,value' &&
        !seen.has(value.inputId),
      'input-shape',
      'value',
    );
    seen.add(value.inputId);
    const input = content.publicInputs.find((i) => i.id === value.inputId);
    check(input, 'unknown-input', value.inputId);
    const layer = content.compositions
      .find((c) => c.id === input.target.compositionId)!
      .layers.find((l) => l.id === input.target.layerId)!;
    validateProperty2(layer, input.target.property, value.value);
    if (input.kind === 'number')
      check(
        typeof value.value === 'number' && value.value >= input.min && value.value <= input.max,
        'input-range',
        input.id,
      );
  }
  return values;
}
export const identityMatrix2 = (): Matrix2 => [1, 0, 0, 1, 0, 0];
export function multiplyMatrix2(a: Matrix2, b: Matrix2): Matrix2 {
  const m: Matrix2 = [
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
export function transformMatrix2(t: Transform): Matrix2 {
  const r = (t.rotation * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r),
    a = c * t.scaleX,
    b = s * t.scaleX,
    d = c * t.scaleY,
    e = -s * t.scaleY;
  return [a, b, e, d, t.x - a * t.anchorX - e * t.anchorY, t.y - b * t.anchorX - d * t.anchorY];
}
export function inverseMatrix2(m: Matrix2): Matrix2 {
  const determinant = m[0] * m[3] - m[1] * m[2];
  check(Math.abs(determinant) > 1e-12, 'singular-transform', 'matrix');
  return [
    m[3] / determinant,
    -m[1] / determinant,
    -m[2] / determinant,
    m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant,
    (m[1] * m[4] - m[0] * m[5]) / determinant,
  ];
}
export function interpolateColor2(a: string, b: string, t: number) {
  const read = (color: string) =>
    [1, 3, 5]
      .map((p) => parseInt(color.slice(p, p + 2), 16) / 255)
      .concat(color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1);
  const first = read(a),
    last = read(b),
    alpha = first[3] + (last[3] - first[3]) * t;
  const linear = (n: number) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  const gamma = (n: number) => (n <= 0.0031308 ? 12.92 * n : 1.055 * n ** (1 / 2.4) - 0.055);
  const hex = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, '0');
  return (
    '#' +
    [0, 1, 2]
      .map((i) =>
        hex(
          alpha === 0
            ? 0
            : gamma(
                (linear(first[i]) * first[3] * (1 - t) + linear(last[i]) * last[3] * t) / alpha,
              ),
        ),
      )
      .join('') +
    hex(alpha)
  );
}
function ease(e: Easing, t: number) {
  return sampleKeys(
    [
      { id: 'a', tick: 0, value: 0, easing: e },
      { id: 'b', tick: 1000000000, value: 1, easing: { type: 'hold' } },
    ],
    t * 1000000000,
  );
}
function sample(keys: Key2[], tick: number): number | string {
  if (tick <= keys[0].tick) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1],
      b = keys[i];
    if (tick === b.tick) return b.value;
    if (tick < b.tick) {
      const ratio = ease(a.easing, (tick - a.tick) / (b.tick - a.tick));
      if (typeof a.value === 'number' && typeof b.value === 'number')
        return a.value + (b.value - a.value) * ratio;
      if (a.easing.type === 'hold') return a.value;
      return interpolateColor2(String(a.value), String(b.value), ratio);
    }
  }
  return keys[keys.length - 1].value;
}
/** Sample a validated native track even when its layer emits no drawable scene item. */
export function sampleAnimationTrack2(track: Track2, tick: number): number | string {
  validateTick(tick);
  check(track.keys.length > 0, 'empty-track', track.id);
  return sample(track.keys, tick);
}
type Segment = { from: [number, number]; points: number[]; type: 'L' | 'C' | 'Q' };
const segmentsCache = new WeakMap<VectorPath2, Segment[]>();
/** Segment-uniform Bezier parameterization; speed is controlled by key timing, not hidden arc-length resampling. */
export function pointOnAnimationPath2(path: VectorPath2, progress: number) {
  let segments = segmentsCache.get(path);
  if (!segments) {
    segments = [];
    let current: [number, number] = [0, 0],
      start: [number, number] = [0, 0];
    for (const command of path) {
      if (command[0] === 'M') {
        current = [command[1], command[2]];
        start = current;
      } else {
        const type = command[0] === 'Z' ? 'L' : command[0];
        const points = command[0] === 'Z' ? [...start] : (command.slice(1) as number[]);
        segments.push({ type, from: current, points });
        current = [points.at(-2)!, points.at(-1)!];
      }
    }
    if (Object.isFrozen(path) && path.every(Object.isFrozen)) segmentsCache.set(path, segments);
  }
  check(segments.length, 'empty-motion-path', 'motion');
  const value = Math.min(1, Math.max(0, progress)) * segments.length,
    index = Math.min(segments.length - 1, Math.floor(value)),
    t = value - index;
  const segment = segments[index],
    p = segment.points,
    from = segment.from;
  const coordinate = (axis: number, t: number) => {
    const a = from[axis],
      b = p[axis];
    if (segment.type === 'L') return { value: a + (b - a) * t, delta: b - a };
    const c = p[axis + 2];
    if (segment.type === 'Q')
      return {
        value: (1 - t) ** 2 * a + 2 * (1 - t) * t * b + t * t * c,
        delta: 2 * (1 - t) * (b - a) + 2 * t * (c - b),
      };
    return sampleBezier3Coordinate([a, b, c, p[axis + 4]], t);
  };
  const x = coordinate(0, t),
    y = coordinate(1, t);
  let dx = x.delta,
    dy = y.delta;
  if (dx === 0 && dy === 0) {
    if (t === 0 || t === 1) {
      const controls = [
        from,
        ...Array.from({ length: p.length / 2 }, (_, i) => [p[i * 2], p[i * 2 + 1]]),
      ];
      const endpoint = t === 0 ? controls[0] : controls.at(-1)!;
      for (const point of t === 0 ? controls.slice(1) : controls.slice(0, -1).reverse()) {
        dx = t === 0 ? point[0] - endpoint[0] : endpoint[0] - point[0];
        dy = t === 0 ? point[1] - endpoint[1] : endpoint[1] - point[1];
        if (dx !== 0 || dy !== 0) break;
      }
    } else {
      dx = coordinate(0, Math.min(1, t + 1e-6)).value - x.value;
      dy = coordinate(1, Math.min(1, t + 1e-6)).value - y.value;
    }
  }
  return { x: x.value, y: y.value, rotation: (Math.atan2(dy, dx) * 180) / Math.PI };
}
export function nestedTick2(
  elapsed: number,
  time: Extract<Layer2, { type: 'composition' }>['time'],
): number | null {
  validateTick(elapsed);
  const offset = (BigInt(elapsed) * BigInt(time.rate.numerator)) / BigInt(time.rate.denominator),
    length = BigInt(time.sourceOut - time.sourceIn);
  if (offset < length) return time.sourceIn + Number(offset);
  return time.after === 'hide'
    ? null
    : time.after === 'hold'
      ? time.sourceOut
      : time.sourceIn + Number(offset % length);
}
export function rectanglePath2(width: number, height: number): VectorPath2 {
  return [['M', 0, 0], ['L', width, 0], ['L', width, height], ['L', 0, height], ['Z']];
}
export function evaluateAnimation2(
  token: PreparedAnimation2,
  compositionId: string,
  tick: number,
  inputs: AnimationInputValues2 = [],
): Scene2 {
  const root = preparedAnimationContent2(token);
  validateTick(tick);
  inputs = validateAnimationInputs2(root, inputs);
  const composition = root.compositions.find((c) => c.id === compositionId);
  check(composition && tick <= composition.duration, 'sample-range', compositionId);
  const items: Scene2['items'] = [],
    layerPoses: Scene2['layerPoses'] = [],
    owners = new Map<AnimationContent2, string>();
  let textCharacters = 0,
    pathCommands = 0,
    svgData = 0;
  const visit = (
    content: AnimationContent2,
    c: Composition2,
    t: number,
    base: Matrix2,
    opacity: number,
    clips: SceneClip2[],
    path: string[],
    values: AnimationInputValues2,
    ownerHash: string,
  ) => {
    owners.set(content, ownerHash);
    const layers = new Map(c.layers.map((l) => [l.id, { ...l, transform: { ...l.transform } }]));
    for (const input of content.publicInputs)
      if (input.target.compositionId === c.id) {
        const l = layers.get(input.target.layerId)!,
          value = values.find((v) => v.inputId === input.id)?.value ?? input.default;
        if (l.type === 'text' && input.target.property === 'text' && l.text !== value) l.runs = [];
        if (input.target.property in l.transform)
          (l.transform as unknown as Record<string, number | string>)[input.target.property] =
            value;
        else (l as unknown as Record<string, number | string>)[input.target.property] = value;
      }
    for (const track of c.tracks) {
      const l = layers.get(track.layerId)!,
        value = sampleAnimationTrack2(track, t);
      if (l.type === 'text' && track.property === 'text' && l.text !== value) l.runs = [];
      if (track.property in l.transform)
        (l.transform as unknown as Record<string, number | string>)[track.property] = value;
      else (l as unknown as Record<string, number | string>)[track.property] = value;
    }
    for (const l of layers.values())
      if (l.motion) {
        const m = l.motion,
          p = pointOnAnimationPath2(m.path, (t - m.start) / (m.end - m.start));
        l.transform.x += p.x;
        l.transform.y += p.y;
        if (m.orient) l.transform.rotation += p.rotation;
      }
    type World = { matrix: Matrix2; opacity: number; clips: SceneClip2[]; active: boolean };
    const worlds = new Map<string, World>(),
      clipShapes = new Map<string, SceneClip2>();
    const world = (id: string): World => {
      const cached = worlds.get(id);
      if (cached) return cached;
      const l = layers.get(id)!,
        parent = l.parentId ? world(l.parentId) : { matrix: base, opacity, clips, active: true };
      const w: World = {
        matrix: multiplyMatrix2(parent.matrix, transformMatrix2(l.transform)),
        opacity: parent.opacity * l.transform.opacity,
        clips: [...parent.clips],
        active:
          parent.active &&
          l.visible &&
          t >= l.start &&
          (t < l.end || (t === c.duration && l.end === c.duration)),
      };
      if (l.clipId) {
        const clip = layers.get(l.clipId)!,
          mask = world(clip.id);
        w.active &&= mask.active;
        let shape = clipShapes.get(clip.id);
        if (!shape) {
          shape = {
            path:
              clip.type === 'path'
                ? clip.path
                : rectanglePath2(
                    (clip as Extract<Layer2, { type: 'rect' }>).width,
                    (clip as Extract<Layer2, { type: 'rect' }>).height,
                  ),
            matrix: mask.matrix,
          };
          clipShapes.set(clip.id, shape);
        }
        check(w.clips.length + mask.clips.length < 512, 'clip-expansion', l.id);
        w.clips.push(...mask.clips, shape);
      }
      worlds.set(id, w);
      return w;
    };
    for (const l of layers.values()) {
      const w = world(l.id);
      if (path.length === 1)
        layerPoses.push({
          id: l.id,
          matrix: w.matrix,
          parentMatrix: l.parentId ? world(l.parentId).matrix : base,
        });
      if (!w.active || l.maskOnly) continue;
      if (l.type === 'group') continue;
      if (l.type === 'composition') {
        const child = resolveComposition2(content, l),
          mapped = nestedTick2(t - l.start, l.time);
        if (mapped !== null)
          visit(
            child.content,
            child.composition,
            mapped,
            w.matrix,
            w.opacity,
            w.clips,
            [...path, l.id],
            child.content === content ? values : [],
            l.source.type === 'exact' ? l.source.ref.contentHash : ownerHash,
          );
      } else {
        textCharacters += l.type === 'text' ? l.text.length : 0;
        pathCommands += l.type === 'path' ? l.path.length : 0;
        svgData +=
          l.type === 'path'
            ? animationSvgPathData2(l.path).length
            : l.type === 'text'
              ? animationSvgTextData2(l).length
              : 0;
        check(
          textCharacters <= 200000 &&
            pathCommands <= 200000 &&
            svgData <= MAX_ANIMATION_EXPANDED_SVG_DATA2,
          'scene-expansion',
          compositionId,
        );
        const assetId = l.type === 'image' ? l.assetId : l.type === 'text' ? l.fontAssetId : null;
        items.push({
          id: l.id,
          instancePath: [...path, l.id],
          layer: l,
          matrix: w.matrix,
          opacity: w.opacity,
          clips: w.clips,
          ...(assetId ? { asset: content.assets.find((a) => a.id === assetId)! } : {}),
        });
      }
    }
  };
  visit(
    root,
    composition,
    tick,
    identityMatrix2(),
    1,
    [],
    [compositionId],
    inputs,
    token.contentHash,
  );
  return {
    version: 'animation-scene-2',
    contentHash: token.contentHash,
    compositionId,
    tick,
    width: composition.width,
    height: composition.height,
    items,
    layerPoses,
    provenance: [...owners]
      .filter(([owner]) => owner.provenance.length > 0)
      .map(([owner, ownerHash]) => ({
        ownerHash,
        records: owner.provenance,
      })),
  };
}
