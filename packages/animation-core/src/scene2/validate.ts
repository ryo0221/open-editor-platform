import { canonicalEqual, deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { requireAnimation as check, type SourceRef } from '../model';
import { ownJson, tick } from '../validate';
import { readAnimationV1 } from '../v1';
import { frameTick } from '../time';
import { inspectAnimationAsset2 } from './assets';
import type { AnimationContent2, Composition2, Layer2, Property2, VectorPath2 } from './model';
import { registerAnimationSourceVersion2 } from './source-resolution';
import { assertAnimationExpansion2 } from './expansion';
export { sourceIdentity2, resolveComposition2 } from './source-resolution';

export const transformProperties2 = [
  'x',
  'y',
  'anchorX',
  'anchorY',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
] as const;
export const color2 = (v: unknown): v is string =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(v);
function fields(
  value: unknown,
  names: string[],
  address: string,
): asserts value is Record<string, unknown> {
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name)),
    'fields',
    address,
  );
}
function list(value: unknown, limit: number, address: string): asserts value is unknown[] {
  check(Array.isArray(value) && value.length <= limit, 'list-limit', address);
}
function number(
  value: unknown,
  min: number,
  max: number,
  address: string,
): asserts value is number {
  check(
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    'range',
    address,
  );
}
function text(value: unknown, max: number, address: string): asserts value is string {
  check(typeof value === 'string' && value.length <= max, 'text', address);
  check(
    Array.from(value).every((char) => {
      const code = char.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 32 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    }),
    'xml-text',
    address,
  );
}
function id(value: unknown): asserts value is string {
  check(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value),
    'id',
    String(value),
  );
}
/** Host identities are opaque strings; native element IDs have their own stricter grammar. */
export function sourceRef2(value: unknown): asserts value is SourceRef {
  fields(value, ['artifactId', 'versionId', 'compositionId', 'contentHash'], 'source');
  for (const name of ['artifactId', 'versionId', 'compositionId'])
    check(
      typeof value[name] === 'string' && value[name].trim().length > 0 && value[name].length <= 200,
      'animation-source',
      name,
    );
  check(
    typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash),
    'animation-source-hash',
    'source',
  );
}
export function validateVectorPath2(value: unknown): asserts value is VectorPath2 {
  list(value, 512, 'path');
  check(value.length > 0, 'empty-path', 'path');
  for (let i = 0; i < value.length; i++) {
    const segment = value[i];
    check(Array.isArray(segment), 'path-segment', String(i));
    const count = { M: 3, L: 3, C: 7, Q: 5, Z: 1 }[segment[0] as string];
    check(
      count && segment.length === count && (i !== 0 || segment[0] === 'M'),
      'path-segment',
      String(i),
    );
    for (const n of segment.slice(1)) number(n, -1000000, 1000000, 'path-coordinate');
  }
}
export function propertyKind2(layer: Layer2, property: Property2): 'number' | 'color' | 'text' {
  if (transformProperties2.includes(property as (typeof transformProperties2)[number]))
    return 'number';
  if (property === 'text') {
    check(layer.type === 'text', 'property-target', layer.id);
    return 'text';
  }
  if (property === 'fill') {
    check(['rect', 'path', 'text'].includes(layer.type), 'property-target', layer.id);
    return 'color';
  }
  if (property === 'stroke' || property === 'strokeWidth') {
    check(layer.type === 'rect' || layer.type === 'path', 'property-target', layer.id);
    return property === 'stroke' ? 'color' : 'number';
  }
  check(false, 'property', String(property));
}
export function validateProperty2(layer: Layer2, property: Property2, value: unknown) {
  const kind = propertyKind2(layer, property);
  if (kind === 'text') {
    // Text without a pinned font is a provisional system-font display (ADR 012);
    // only static frame export asks for the pinned font.
    text(value, 20000, layer.id);
  } else if (kind === 'color') check(color2(value), 'color', layer.id);
  else
    number(
      value,
      property === 'opacity' || property === 'strokeWidth' ? 0 : -1000000,
      property === 'opacity' ? 1 : property === 'strokeWidth' ? 1024 : 1000000,
      layer.id,
    );
}
/** Most-recently-used memo bounded by entry count and by the string characters its
 * values retain, so a long-lived process cannot keep many maximum-size inputs alive.
 * Entries are trusted only after the caller compares their complete inputs. */
class Memo<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;
  constructor(private limit = 32 * 1024 * 1024) {}
  get(key: string) {
    return this.entries.get(key)?.value;
  }
  set(key: string, value: T, weight: number) {
    this.delete(key);
    if (weight > this.limit) return;
    for (const old of this.entries.keys()) {
      if (this.entries.size < 256 && this.weight + weight <= this.limit) break;
      this.delete(old);
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
  }
  private delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.weight -= entry.weight;
  }
}
/** Retained string characters plus a per-node allowance for a JSON tree. */
function retainedWeight(value: unknown): number {
  if (typeof value === 'string') return value.length + 16;
  if (!value || typeof value !== 'object') return 16;
  let total = 16;
  for (const entry of Object.values(value)) total += retainedWeight(entry);
  return total;
}
// Base64 decoding and SHA-256 dominate admission of image/font assets. Equal strings
// give equal results, so repeated reads of one snapshot skip them.
const inspectedAssets = new Memo<{
  base64: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
}>();
function inspectAsset(asset: AnimationContent2['assets'][number]) {
  const cached = inspectedAssets.get(asset.contentHash);
  if (cached?.base64 === asset.base64 && cached.mediaType === asset.mediaType) return cached;
  const { bytes, width, height } = inspectAnimationAsset2(asset),
    value = {
      base64: asset.base64,
      mediaType: asset.mediaType,
      bytes: bytes.length,
      width,
      height,
    };
  inspectedAssets.set(asset.contentHash, value, asset.base64.length);
  return value;
}
const copyAdmitted = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyAdmitted);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) result[key] = copyAdmitted(entry);
  return result;
};
// Retained sources are compared structurally with the last admitted copy for their
// expected hash, so large shared strings are compared rather than re-serialized.
const admittedSources = new Memo<AnimationContent2>();
function sourceHash(content: AnimationContent2, expected: string) {
  const cached = admittedSources.get(expected);
  if (cached && canonicalEqual(cached, content)) return expected;
  const hash = reuseHash(content);
  if (hash === expected)
    admittedSources.set(
      expected,
      deepFreeze(copyAdmitted(content) as AnimationContent2),
      retainedWeight(content),
    );
  return hash;
}
// Inputs whose whole tree was certified immutable by deepFreeze before admission.
const admitted = new WeakSet<object>();
/** Bounded owning reader for schema 2, including every portable retained source/asset.
 * Returns a mutable copy. Deep-frozen snapshots are validated once per identity. */
export function readAnimation2(input: unknown): AnimationContent2 {
  if (input && typeof input === 'object' && admitted.has(input))
    return copyAdmitted(input) as AnimationContent2;
  const root = validateAnimation2(input);
  if (isDeepFrozen(input)) admitted.add(input as object);
  return root;
}
/** Read-only variant for comparisons and results that are never mutated. Returns the
 * input itself when it is an admitted immutable snapshot, otherwise a frozen copy. */
export function readFrozenAnimation2(input: unknown): AnimationContent2 {
  if (input && typeof input === 'object' && admitted.has(input)) return input as AnimationContent2;
  const root = validateAnimation2(input);
  if (isDeepFrozen(input)) {
    admitted.add(input as object);
    return input as AnimationContent2;
  }
  admitted.add(deepFreeze(root));
  return root;
}
function validateAnimation2(input: unknown): AnimationContent2 {
  const root = ownJson(input) as AnimationContent2;
  let sourceCount = 0,
    allKeys = 0,
    allPathCommands = 0,
    assetBytes = 0,
    decodedPixels = 0;
  const records: {
    ref: AnimationContent2['sources'][number]['ref'];
    content: AnimationContent2;
  }[] = [];
  const identities = new Map<string, string>();
  const clipCounts = new Map<Layer2, number>();
  function validateNode(content: AnimationContent2, depth: number) {
    check(depth <= 16, 'source-depth', 'sources');
    fields(
      content,
      [
        'schemaVersion',
        'ticksPerSecond',
        'rootCompositionId',
        'compositions',
        'assets',
        'publicInputs',
        'sources',
        'provenance',
      ],
      'animation2',
    );
    check(
      content.schemaVersion === 2 && content.ticksPerSecond === 240000,
      'expected-v2',
      'schemaVersion',
    );
    list(content.compositions, 100, 'compositions');
    list(content.assets, 100, 'assets');
    list(content.publicInputs, 1000, 'publicInputs');
    list(content.sources, 100, 'sources');
    list(content.provenance, 100, 'provenance');
    const ids = new Set<string>();
    const unique = (v: unknown) => {
      id(v);
      check(!ids.has(v), 'duplicate-id', v);
      ids.add(v);
    };
    const assets = new Map(content.assets.map((asset) => [asset.id, asset]));
    for (const asset of content.assets) {
      fields(
        asset,
        ['id', 'contentHash', 'mediaType', 'base64', 'attribution', 'license'],
        'asset',
      );
      unique(asset.id);
      text(asset.attribution, 2000, 'asset-attribution');
      text(asset.license, 20000, 'asset-license');
      check(
        asset.attribution.trim() &&
          asset.license.trim() &&
          ['image/png', 'image/jpeg', 'font/otf', 'font/ttf', 'font/woff2'].includes(
            asset.mediaType,
          ),
        'asset-metadata',
        asset.id,
      );
      const inspected = inspectAsset(asset);
      assetBytes += inspected.bytes;
      decodedPixels += inspected.width * inspected.height;
      check(
        assetBytes <= 4 * 1024 * 1024 && decodedPixels <= 32 * 1024 * 1024,
        'asset-aggregate',
        asset.id,
      );
    }
    for (const c of content.compositions) {
      fields(
        c,
        ['id', 'name', 'width', 'height', 'duration', 'frameRate', 'layers', 'tracks'],
        'composition',
      );
      unique(c.id);
      text(c.name, 200, c.id);
      list(c.layers, 1000, 'layers');
      list(c.tracks, 20000, 'tracks');
      const layers = new Map(c.layers.map((l) => [l.id, l]));
      for (const layer of c.layers) {
        const extra = {
          rect: ['width', 'height', 'fill', 'stroke', 'strokeWidth'],
          path: ['path', 'fill', 'stroke', 'strokeWidth'],
          text: [
            'text',
            'runs',
            'width',
            'height',
            'fontAssetId',
            'fontSize',
            'lineHeight',
            'fill',
          ],
          image: ['assetId', 'width', 'height'],
          group: [],
          composition: ['source', 'time'],
        }[layer.type];
        check(extra, 'unsupported-layer', 'layer');
        fields(
          layer,
          [
            'id',
            'name',
            'parentId',
            'start',
            'end',
            'transform',
            'visible',
            'locked',
            'clipId',
            'maskOnly',
            'motion',
            'type',
            ...extra,
          ],
          'layer',
        );
        unique(layer.id);
        text(layer.name, 200, layer.id);
        for (const flag of [layer.visible, layer.locked, layer.maskOnly])
          check(typeof flag === 'boolean', 'boolean', layer.id);
        if (layer.parentId !== null)
          check(layers.get(layer.parentId)?.type === 'group', 'parent-type', layer.id);
        if (layer.clipId !== null) {
          const clip = layers.get(layer.clipId);
          check(
            clip && clip.id !== layer.id && ['rect', 'path'].includes(clip.type),
            'clip-target',
            layer.id,
          );
        }
        if (layer.type === 'rect' || layer.type === 'image') {
          number(layer.width, 0, 16384, layer.id);
          number(layer.height, 0, 16384, layer.id);
        }
        if (layer.type === 'rect' || layer.type === 'path' || layer.type === 'text')
          check(color2(layer.fill), 'color', layer.id);
        if (layer.type === 'rect' || layer.type === 'path') {
          check(color2(layer.stroke), 'color', layer.id);
          number(layer.strokeWidth, 0, 1024, layer.id);
        }
        if (layer.type === 'path') {
          validateVectorPath2(layer.path);
          allPathCommands += layer.path.length;
        }
        if (layer.type === 'image')
          check(
            assets.get(layer.assetId)?.mediaType.startsWith('image/'),
            'missing-image',
            layer.id,
          );
        if (layer.type === 'text') {
          text(layer.text, 20000, layer.id);
          validateProperty2(layer, 'text', layer.text);
          number(layer.width, 1, 16384, layer.id);
          number(layer.height, 1, 16384, layer.id);
          list(layer.runs, 20000, 'text-runs');
          for (const run of layer.runs) {
            check(
              run &&
                typeof run === 'object' &&
                Object.keys(run).every((key) => ['text', 'style'].includes(key)),
              'text-run',
              layer.id,
            );
            text(run.text, 20000, layer.id);
            if (run.style !== undefined) {
              check(
                run.style && typeof run.style === 'object' && !Array.isArray(run.style),
                'text-style',
                layer.id,
              );
              for (const [key, value] of Object.entries(run.style)) {
                if (['bold', 'italic', 'underline', 'strike'].includes(key))
                  check(typeof value === 'boolean', 'text-style', key);
                else if (key === 'fontSize') number(value, 1, 1024, key);
                else if (key === 'color') check(color2(value), 'color', key);
                else check(false, 'unsupported-text-style', key);
              }
            }
          }
          check(
            !layer.runs.length || layer.runs.map((run) => run.text).join('') === layer.text,
            'text-runs',
            layer.id,
          );
          number(layer.fontSize, 1, 1024, layer.id);
          number(layer.lineHeight, 0.5, 4, layer.id);
          check(
            layer.fontAssetId === null ||
              assets.get(layer.fontAssetId)?.mediaType.startsWith('font/'),
            'missing-font',
            layer.id,
          );
        }
        if (layer.motion !== null) {
          fields(layer.motion, ['path', 'start', 'end', 'orient'], 'motion');
          validateVectorPath2(layer.motion.path);
          check(
            layer.motion.path.some((command) => command[0] !== 'M'),
            'empty-motion-path',
            layer.id,
          );
          allPathCommands += layer.motion.path.length;
          tick(layer.motion.start);
          tick(layer.motion.end);
          check(
            layer.motion.start < layer.motion.end &&
              layer.motion.end <= c.duration &&
              typeof layer.motion.orient === 'boolean',
            'motion-range',
            layer.id,
          );
        }
        check(allPathCommands <= 20000, 'path-command-limit', 'content');
        if (layer.type === 'composition') {
          const s = layer.source;
          check(s && (s.type === 'local' || s.type === 'exact'), 'source', layer.id);
          fields(s, s.type === 'local' ? ['type', 'compositionId'] : ['type', 'ref'], 'source');
          if (s.type === 'local') id(s.compositionId);
          else sourceRef2(s.ref);
          fields(layer.time, ['sourceIn', 'sourceOut', 'rate', 'after'], 'time');
          tick(layer.time.sourceIn);
          tick(layer.time.sourceOut);
          check(
            layer.time.sourceIn < layer.time.sourceOut &&
              ['hold', 'loop', 'hide'].includes(layer.time.after),
            'nested-time',
            layer.id,
          );
          fields(layer.time.rate, ['numerator', 'denominator'], 'rate');
          for (const n of Object.values(layer.time.rate)) {
            number(n, 1, 1000000, 'rate');
            check(Number.isSafeInteger(n), 'integer', 'rate');
          }
        }
      }
      const targets = new Set<string>();
      for (const track of c.tracks) {
        fields(track, ['id', 'layerId', 'property', 'keys'], 'track');
        unique(track.id);
        list(track.keys, 20000, 'keys');
        check(track.keys.length, 'empty-track', track.id);
        allKeys += track.keys.length;
        check(allKeys <= 20000, 'key-limit', 'content');
        const layer = layers.get(track.layerId);
        check(layer, 'target', track.id);
        const target = track.layerId + '/' + track.property;
        check(!targets.has(target), 'duplicate-target', target);
        targets.add(target);
        check(
          !layer.motion ||
            (!['x', 'y'].includes(track.property) &&
              !(layer.motion.orient && track.property === 'rotation')),
          'motion-track-conflict',
          track.id,
        );
        let before = -1;
        for (const key of track.keys) {
          fields(key, ['id', 'tick', 'value', 'easing'], 'key');
          unique(key.id);
          tick(key.tick);
          check(key.tick > before && key.tick <= c.duration, 'key-time', key.id);
          before = key.tick;
          validateProperty2(layer, track.property, key.value);
          check(
            key.easing && ['hold', 'linear', 'bezier'].includes(key.easing.type),
            'easing',
            key.id,
          );
          fields(
            key.easing,
            key.easing.type === 'bezier' ? ['type', 'x1', 'y1', 'x2', 'y2'] : ['type'],
            'easing',
          );
          if (key.easing.type === 'bezier')
            for (const n of [key.easing.x1, key.easing.y1, key.easing.x2, key.easing.y2])
              number(n, 0, 1, key.id);
          if (track.property === 'text')
            check(key.easing.type === 'hold', 'discrete-easing', key.id);
        }
      }
      // Reuse the original validated integer-time/transform/parent-cycle contract.
      readAnimationV1({
        schemaVersion: 1,
        ticksPerSecond: 240000,
        rootCompositionId: c.id,
        assets: [],
        compositions: [
          {
            id: c.id,
            width: c.width,
            height: c.height,
            duration: c.duration,
            frameRate: c.frameRate,
            layers: c.layers.map((l) => ({
              id: l.id,
              parentId: l.parentId,
              start: l.start,
              end: l.end,
              transform: l.transform,
              type: 'group',
            })),
            tracks: [],
          },
        ],
      });
      const clipDepths = new Map<string, number>(),
        visiting = new Set<string>();
      const walkClip = (layer: Layer2): number => {
        const cached = clipDepths.get(layer.id);
        if (cached !== undefined) return cached;
        check(!visiting.has(layer.id), 'clip-cycle', layer.id);
        visiting.add(layer.id);
        let depth = 0;
        for (const key of [layer.parentId, layer.clipId])
          if (key !== null) depth = Math.max(depth, 1 + walkClip(layers.get(key)!));
        check(depth <= 32, 'clip-depth', layer.id);
        const parent = layer.parentId ? layers.get(layer.parentId)! : undefined,
          mask = layer.clipId ? layers.get(layer.clipId)! : undefined,
          count = (parent ? clipCounts.get(parent)! : 0) + (mask ? clipCounts.get(mask)! + 1 : 0);
        check(count <= 32, 'clip-expansion', layer.id);
        clipCounts.set(layer, count);
        visiting.delete(layer.id);
        clipDepths.set(layer.id, depth);
        return depth;
      };
      for (const layer of c.layers) walkClip(layer);
    }
    check(
      content.compositions.some((c) => c.id === content.rootCompositionId),
      'root',
      'rootCompositionId',
    );
    const boundTargets = new Set<string>();
    for (const input of content.publicInputs) {
      fields(input, ['id', 'name', 'kind', 'default', 'min', 'max', 'target'], 'public-input');
      unique(input.id);
      text(input.name, 200, input.id);
      fields(input.target, ['compositionId', 'layerId', 'property'], 'input-target');
      const c = content.compositions.find((c) => c.id === input.target.compositionId),
        l = c?.layers.find((l) => l.id === input.target.layerId);
      check(c && l, 'input-target', input.id);
      check(propertyKind2(l, input.target.property) === input.kind, 'input-type', input.id);
      validateProperty2(l, input.target.property, input.default);
      number(input.min, -1000000, 1000000, input.id);
      number(input.max, input.min, 1000000, input.id);
      if (input.kind === 'number')
        check(
          typeof input.default === 'number' &&
            input.default >= input.min &&
            input.default <= input.max,
          'input-range',
          input.id,
        );
      check(
        !c.tracks.some((t) => t.layerId === l.id && t.property === input.target.property),
        'input-track-conflict',
        input.id,
      );
      check(
        !l.motion ||
          (!['x', 'y'].includes(input.target.property) &&
            !(l.motion.orient && input.target.property === 'rotation')),
        'input-motion-conflict',
        input.id,
      );
      const target = JSON.stringify(input.target);
      check(!boundTargets.has(target), 'duplicate-input-target', input.id);
      boundTargets.add(target);
    }
    for (const entry of content.provenance) {
      fields(entry, ['source', 'mapping', 'losses'], 'provenance');
      sourceRef2(entry.source);
      list(entry.mapping, 1000, 'mapping');
      list(entry.losses, 1000, 'losses');
      for (const m of entry.mapping) {
        fields(m, ['sourceId', 'layerId'], 'mapping');
        check(typeof m.sourceId === 'string' && m.sourceId.length <= 2000, 'source-id', 'mapping');
        id(m.layerId);
      }
      for (const loss of entry.losses) text(loss, 2000, 'loss');
    }
    for (const entry of content.sources) {
      fields(entry, ['ref', 'content'], 'retained-source');
      sourceRef2(entry.ref);
      sourceCount++;
      check(sourceCount <= 100, 'source-limit', 'sources');
      registerAnimationSourceVersion2(identities, entry.ref);
      records.push(entry);
      validateNode(entry.content, depth + 1);
    }
  }
  validateNode(root, 0);
  assertAnimationExpansion2([root, ...records.map((entry) => entry.content)], clipCounts);
  for (const entry of records) {
    check(
      entry.content.compositions.some((c) => c.id === entry.ref.compositionId),
      'missing-composition',
      'source',
    );
    check(
      sourceHash(entry.content, entry.ref.contentHash) === entry.ref.contentHash,
      'source-hash',
      entry.ref.artifactId,
    );
  }
  return root;
}
export function createAnimation2(): AnimationContent2 {
  return {
    schemaVersion: 2,
    ticksPerSecond: 240000,
    rootCompositionId: 'root',
    compositions: [
      {
        id: 'root',
        name: 'Main',
        width: 640,
        height: 360,
        duration: 960000,
        frameRate: { numerator: 30, denominator: 1 },
        layers: [],
        tracks: [],
      },
    ],
    assets: [],
    sources: [],
    publicInputs: [],
    provenance: [],
  };
}
const nonAscii = (value: unknown) =>
  typeof value === 'string' && Array.from(value).some((char) => char.codePointAt(0)! > 127);
/** True when this text layer has no pinned font and its own text, a text key, its
 * declared input default or a supplied consumer input has non-ASCII characters, so the
 * viewer's system font shows it as a provisional display. */
export function animationLayerSystemFont2(
  content: AnimationContent2,
  compositionId: string,
  layerId: string,
  inputs: readonly { inputId: string; value: number | string }[] = [],
): boolean {
  const c = content.compositions.find((c) => c.id === compositionId),
    layer = c?.layers.find((l) => l.id === layerId);
  if (!c || layer?.type !== 'text' || layer.fontAssetId !== null) return false;
  return (
    nonAscii(layer.text) ||
    c.tracks.some(
      (t) =>
        t.layerId === layerId && t.property === 'text' && t.keys.some((k) => nonAscii(k.value)),
    ) ||
    content.publicInputs.some(
      (input) =>
        input.kind === 'text' &&
        input.target.compositionId === compositionId &&
        input.target.layerId === layerId &&
        (nonAscii(input.default) ||
          inputs.some((v) => v.inputId === input.id && nonAscii(v.value))),
    )
  );
}
/** Some text anywhere in the content, retained exact sources included, shows in the
 * system font (see animationLayerSystemFont2). */
export function animationSystemFontText2(
  content: AnimationContent2,
  inputs: readonly { inputId: string; value: number | string }[] = [],
): boolean {
  return (
    content.compositions.some((c) =>
      c.layers.some((l) => animationLayerSystemFont2(content, c.id, l.id, inputs)),
    ) || content.sources.some((source) => animationSystemFontText2(source.content))
  );
}
export function frameStep2(c: Composition2) {
  return frameTick(1, 240000, c.frameRate);
}
