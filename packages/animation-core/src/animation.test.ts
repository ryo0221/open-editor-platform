import { describe, it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { contentHash, canonicalJson } from '@editor-platform/artifact-core';
import { animationFixture } from './fixtures';
import {
  validateAnimation,
  prepareAnimation,
  evaluateAnimation,
  frameTick,
  mapNestedTick,
  identityTransform,
  replaceTrack,
  type AnimationContent,
  type PrototypeAnimationContent,
  type TimeMapping,
  type SourceRef,
} from './index';

const pose = async (content: AnimationContent, tick: number) =>
  evaluateAnimation(await prepareAnimation(content), 'root', tick).rectangles[0];
describe('Animation provisional Core gate', () => {
  it('roundtrips stable ids and canonical native hash', async () => {
    const source = animationFixture();
    const result = validateAnimation(JSON.parse(JSON.stringify(source)));
    expect(result).toEqual(source);
    expect(await contentHash(result)).toBe(await contentHash(source));
  });
  it('returns golden start, midpoint and terminal poses independent of seek order', async () => {
    const source = animationFixture(),
      saved = canonicalJson(source),
      prepared = await prepareAnimation(source);
    for (const tick of [240000, 120000, 0, 60000, 120000, 0]) {
      const scene = evaluateAnimation(prepared, 'root', tick);
      expect(scene.rectangles).toEqual([
        {
          instancePath: ['root', 'box'],
          layerId: 'box',
          matrix: [1, 0, 0, 1, 10 + tick / 2400, 0],
          opacity: 1,
          width: 20,
          height: 10,
          fill: '#ff0000',
        },
      ]);
    }
    const random = evaluateAnimation(prepared, 'root', 170000);
    evaluateAnimation(prepared, 'root', 0);
    expect(evaluateAnimation(prepared, 'root', 170000)).toEqual(random);
    expect(random.rectangles[0].matrix[4]).toBeCloseTo(80.83333333333333, 10);
    expect(canonicalJson(source)).toBe(saved);
  });
  it('owns the input across async prepare and scene mutation', async () => {
    const source = animationFixture(),
      pending = prepareAnimation(source);
    source.compositions[0].layers[0].transform.y = 999;
    const prepared = await pending,
      scene = evaluateAnimation(prepared, 'root', 0);
    scene.rectangles[0].matrix[5] = 888;
    expect(evaluateAnimation(prepared, 'root', 0).rectangles[0].matrix[5]).toBe(0);
    expect(() => evaluateAnimation({ ...prepared }, 'root', 0)).toThrow('unprepared');
  });
  it('holds before/after keys and jumps exactly at outgoing hold endpoint', async () => {
    const c = animationFixture(),
      keys = c.compositions[0].tracks[0].keys;
    keys[0].tick = 100;
    keys[0].easing = { type: 'hold' };
    keys[1].tick = 200;
    for (const tick of [0, 100, 199]) expect((await pose(c, tick)).matrix[4]).toBe(10);
    for (const tick of [200, 240000]) expect((await pose(c, tick)).matrix[4]).toBe(110);
  });
  it('solves Bezier x rather than treating elapsed as its parameter', async () => {
    const c = animationFixture();
    c.compositions[0].tracks[0].keys[0].easing = { type: 'bezier', x1: 0, y1: 0, x2: 1, y2: 1 };
    expect((await pose(c, 60000)).matrix[4]).toBeCloseTo(35, 10);
    c.compositions[0].tracks[0].keys[0].easing = { type: 'bezier', x1: 0, y1: 1, x2: 0, y2: 1 };
    // x(t)=t^3: elapsed 1/8 -> t=1/2 -> y=7/8.
    expect((await pose(c, 30000)).matrix[4]).toBeCloseTo(97.5, 10);
  });
  it('maps fractional fps exactly, refuses fractional tick grids and overflow', () => {
    for (const fps of [24, 25, 30, 50, 60])
      expect(frameTick(fps, 240000, { numerator: fps, denominator: 1 })).toBe(240000);
    expect(frameTick(1, 240000, { numerator: 24000, denominator: 1001 })).toBe(10010);
    expect(frameTick(1, 240000, { numerator: 60000, denominator: 1001 })).toBe(4004);
    expect(() => frameTick(1, 240000, { numerator: 29, denominator: 1 })).toThrow('frame-grid');
    expect(() =>
      frameTick(Number.MAX_SAFE_INTEGER, 240000, { numerator: 1, denominator: 1 }),
    ).toThrow('overflow');
  });
  it('maps trim/rate/timebase with exact floor, loop, hold and hide boundaries', () => {
    const t: TimeMapping = {
      sourceIn: 10,
      sourceOut: 20,
      rate: { numerator: 3, denominator: 2 },
      after: 'loop',
    };
    expect(mapNestedTick(1, 240000, 48000, t)).toBe(10);
    expect(mapNestedTick(33, 240000, 48000, t)).toBe(19);
    expect(mapNestedTick(34, 240000, 48000, t)).toBe(10);
    expect(mapNestedTick(34, 240000, 48000, { ...t, after: 'hold' })).toBe(19);
    expect(mapNestedTick(34, 240000, 48000, { ...t, after: 'hide' })).toBeNull();
    const big = Number.MAX_SAFE_INTEGER;
    expect(
      mapNestedTick(big, 240000, 240000, {
        ...t,
        rate: { numerator: 999983, denominator: 999979 },
      }),
    ).toBe(10 + Number(((BigInt(big) * 999983n) / 999979n) % 10n));
  });
  it('composes parents, anchors, rotation, reflection and opacity without double offsets', async () => {
    const c = animationFixture(),
      comp = c.compositions[0];
    comp.tracks = [];
    comp.layers[0].parentId = 'parent';
    comp.layers[0].transform = {
      ...identityTransform(),
      x: 5,
      anchorX: 1,
      scaleX: -1,
      opacity: 0.5,
    };
    comp.layers.push({
      id: 'parent',
      parentId: null,
      type: 'group',
      start: 0,
      end: 240000,
      transform: { ...identityTransform(), x: 10, rotation: 90, opacity: 0.5 },
    });
    const scene = await pose(c, 0);
    expect(scene.matrix[4]).toBeCloseTo(10);
    expect(scene.matrix[5]).toBeCloseTo(6);
    expect(scene.opacity).toBe(0.25);
    comp.layers[1].end = 100;
    expect(evaluateAnimation(await prepareAnimation(c), 'root', 100).rectangles).toEqual([]);
  });
  it('keeps unwrapped rotation interpolation', async () => {
    const c = animationFixture(),
      t = c.compositions[0].tracks[0];
    t.property = 'rotation';
    t.keys[0].value = 350;
    t.keys[1].value = 370;
    expect((await pose(c, 120000)).matrix[0]).toBeCloseTo(1);
    t.keys[1].value = 10;
    expect((await pose(c, 120000)).matrix[0]).toBeCloseTo(-1);
  });
  it.each([
    [
      'duplicate id',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].layers.push(structuredClone(c.compositions[0].layers[0]));
      },
    ],
    [
      'duplicate target',
      (c: PrototypeAnimationContent) => {
        const t = structuredClone(c.compositions[0].tracks[0]);
        t.id = 'other';
        c.compositions[0].tracks.push(t);
      },
    ],
    [
      'duplicate time',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].tracks[0].keys[1].tick = 0;
      },
    ],
    [
      'NaN',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].layers[0].transform.x = NaN;
      },
    ],
    [
      'missing parent',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].layers[0].parentId = 'absent';
      },
    ],
    [
      'opacity',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].tracks[0].property = 'opacity';
      },
    ],
    [
      'unknown property',
      (c: PrototypeAnimationContent) => {
        Object.assign(c.compositions[0].tracks[0], { property: '__proto__' });
      },
    ],
    [
      'unknown field',
      (c: PrototypeAnimationContent) => {
        Object.assign(c, { publicInputs: [] });
      },
    ],
    [
      'unknown schema',
      (c: PrototypeAnimationContent) => {
        Object.assign(c, { schemaVersion: 2 });
      },
    ],
    [
      'unbounded easing',
      (c: PrototypeAnimationContent) => {
        c.compositions[0].tracks[0].keys[0].easing = {
          type: 'bezier',
          x1: -1,
          y1: 0,
          x2: 1,
          y2: 1,
        };
      },
    ],
  ])('rejects %s without mutation', (_name, modify) => {
    const c = animationFixture();
    modify(c);
    const before = structuredClone(c);
    expect(() => validateAnimation(c)).toThrow();
    expect(c).toEqual(before);
  });
  it('never invokes getters/toJSON and rejects sparse arrays', () => {
    let called = false;
    const input = {
      get schemaVersion() {
        called = true;
        return 'x';
      },
    };
    expect(() => validateAnimation(input)).toThrow('json-descriptor');
    expect(called).toBe(false);
    const c = animationFixture();
    Object.assign(c, {
      toJSON() {
        called = true;
      },
    });
    expect(() => validateAnimation(c)).toThrow();
    expect(called).toBe(false);
    const sparse = animationFixture();
    sparse.compositions.length = 3;
    expect(() => validateAnimation(sparse)).toThrow('array');
  });
  it('rejects local cycle and key/layer limit', () => {
    const c = animationFixture();
    c.compositions[0].layers.push({
      id: 'nest',
      parentId: null,
      start: 0,
      end: 240000,
      type: 'composition',
      transform: identityTransform(),
      source: { type: 'local', compositionId: 'root' },
      time: {
        sourceIn: 0,
        sourceOut: 240000,
        rate: { numerator: 1, denominator: 1 },
        after: 'loop',
      },
    });
    expect(() => validateAnimation(c)).toThrow('composition-cycle-depth');
    const large = animationFixture();
    large.compositions[0].layers = Array.from({ length: 1001 }, (_, i) => ({
      ...large.compositions[0].layers[0],
      id: `layer${i}`,
    }));
    expect(() => validateAnimation(large)).toThrow('list-limit');
  });
  it('validates exact retained source, trim, missing/hash mismatch and unknown schema', async () => {
    const child = animationFixture(),
      ref: SourceRef = {
        artifactId: 'source',
        versionId: 'version-1',
        contentHash: await contentHash(child),
        compositionId: 'root',
      };
    const parent = animationFixture();
    parent.compositions[0].tracks = [];
    parent.compositions[0].layers = [
      {
        id: 'nested',
        parentId: null,
        start: 0,
        end: 240000,
        type: 'composition',
        transform: { ...identityTransform(), x: 7 },
        source: { type: 'exact', ref },
        time: {
          sourceIn: 0,
          sourceOut: 240000,
          rate: { numerator: 1, denominator: 1 },
          after: 'loop',
        },
      },
    ];
    const retained = [{ ref, content: child }];
    const prepared = await prepareAnimation(parent, retained);
    expect(evaluateAnimation(prepared, 'root', 120000).rectangles[0].matrix[4]).toBe(67);
    expect(evaluateAnimation(prepared, 'root', 240000).rectangles[0].matrix[4]).toBe(17);
    await expect(prepareAnimation(parent)).rejects.toThrow('missing-source');
    const changed = structuredClone(child);
    changed.compositions[0].width = 20;
    await expect(prepareAnimation(parent, [{ ref, content: changed }])).rejects.toThrow(
      'hash-mismatch',
    );
    await expect(prepareAnimation(parent, [{ ref, content: {} }])).rejects.toThrow();
    const nested = parent.compositions[0].layers[0];
    if (nested.type !== 'composition') throw new Error('fixture');
    nested.time.sourceOut = 240001;
    await expect(prepareAnimation(parent, retained)).rejects.toThrow('source-trim');
  });
  it('rejects source cycles before hashing and all retained bad content', async () => {
    const c = animationFixture(),
      ref: SourceRef = {
        artifactId: 'a',
        versionId: 'v',
        contentHash: 'a'.repeat(64),
        compositionId: 'root',
      };
    c.compositions[0].layers.push({
      id: 'cycle',
      type: 'composition',
      parentId: null,
      start: 0,
      end: 240000,
      transform: identityTransform(),
      source: { type: 'exact', ref },
      time: {
        sourceIn: 0,
        sourceOut: 240000,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    });
    await expect(prepareAnimation(c, [{ ref, content: c }])).rejects.toThrow('source-cycle');
    await expect(prepareAnimation(animationFixture(), [{ ref, content: {} }])).rejects.toThrow();
  });
  it('verifies asset bytes and owns bytes before await; no decoding claim', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const c = animationFixture();
    c.assets = [{ id: 'image', contentHash: hash, byteLength: 3, mediaType: 'image/png' }];
    await expect(prepareAnimation(c)).rejects.toThrow('missing-asset');
    await expect(
      prepareAnimation(c, [], [{ contentHash: hash, bytes: new Uint8Array([0, 2, 3]) }]),
    ).rejects.toThrow('asset-hash');
    const pending = prepareAnimation(c, [], [{ contentHash: hash, bytes }]);
    bytes[0] = 0;
    await expect(pending).resolves.toBeDefined();
  });
  it('uses one existing Session Undo, rejects revoked, stale and invalid atomically', () => {
    const c = animationFixture(),
      session = new EditorSession<AnimationContent>(c),
      updated = structuredClone(c.compositions[0].tracks[0]);
    updated.keys[1].value = 210;
    let allowed = true;
    const scope = { canEdit: () => allowed };
    const command = replaceTrack(c, 'root', updated, scope);
    session.execute(command);
    expect(session.content.compositions[0].tracks[0].keys[1].value).toBe(210);
    session.undo();
    expect(session.content).toEqual(c);
    session.redo();
    expect(session.content.compositions[0].tracks[0].keys[1].value).toBe(210);
    const before = session.content;
    expect(() => session.execute(command)).toThrow('stale');
    expect(session.content).toEqual(before);
    allowed = false;
    expect(() => replaceTrack(before, 'root', updated, scope).apply(before)).toThrow('read-only');
    allowed = true;
    updated.keys[1].tick = 0;
    expect(() => session.execute(replaceTrack(before, 'root', updated, scope))).toThrow('key-time');
    expect(session.content).toEqual(before);
  });
  it('rejects invalid sampling rather than silently clamps', async () => {
    const p = await prepareAnimation(animationFixture());
    for (const t of [-1, 0.5, 240001, Infinity])
      expect(() => evaluateAnimation(p, 'root', t)).toThrow();
    expect(() => evaluateAnimation(p, 'missing', 0)).toThrow('sample-range');
  });
});
