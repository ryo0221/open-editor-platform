import { describe, expect, it } from 'vitest';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { cadClearance, jointRangeSamples } from './clearance';
import { f02Plate, fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import { checkCadInterferenceAlong, type CadInterferenceMesh } from './interference';
import { solveJoints } from './joints';
import { emptyCad, position, type CadDocument, type Quaternion } from './model';
import { applyCadOperation } from './operations';

/** The F02 plate (80 × 50 × 5 mm from its origin) as a closed box mesh. */
function plateMesh(bodyId: string): CadInterferenceMesh[] {
  const lo = [0, 0, 0];
  const hi = [80, 50, 5];
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const n = 8;
      const base = positions.length / 3;
      for (let i = 0; i <= n; i++)
        for (let j = 0; j <= n; j++) {
          const p = [0, 0, 0];
          p[axis] = side ? hi[axis]! : lo[axis]!;
          p[u] = lo[u]! + ((hi[u]! - lo[u]!) * i) / n;
          p[v] = lo[v]! + ((hi[v]! - lo[v]!) * j) / n;
          positions.push(...p);
        }
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const a = base + i * (n + 1) + j;
          const b = a + n + 1;
          if (side) indices.push(a, b, b + 1, a, b + 1, a + 1);
          else indices.push(a, b + 1, b, a, a + 1, b + 1);
        }
    }
  return [
    {
      bodyId,
      origin: [0, 0, 0],
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    },
  ];
}

/**
 * A base plate and a lid 20 mm above it, the lid on a hinge along y at x 0, z 20 (0–30°): a
 * positive angle swings its far end down into the base.
 */
function lidOnHinge() {
  const plate = f02Plate();
  const pv = fixtureVersion('plate', 'v1', plate);
  const hinge: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  let doc = emptyCad(fixtureKernel);
  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: [fixturePart('p', 'Plate', pv)],
    components: [fixtureComponent('base', 'p'), fixtureComponent('lid', 'p', [0, 0, 20])],
  });
  doc = applyCadOperation(doc, {
    type: 'insertJoint',
    joint: {
      id: 'hinge',
      name: 'Hinge',
      type: 'revolute',
      parent: {
        componentPath: ['base'],
        ref: { origin: true },
        flip: false,
        offset: { translation: position(0, 0, 20), rotation: hinge },
      },
      child: {
        componentId: 'lid',
        connector: {
          componentPath: [],
          ref: { origin: true },
          flip: false,
          offset: { translation: position(0, 0, 0), rotation: hinge },
        },
      },
      values: { angle: { literalRad: 0 } },
      limits: [{ of: 'angle', min: 0, max: Math.PI / 6 }],
    },
  });
  const closure = new Map<string, CadDocument>([[pv.contentHash, pv.content]]);
  const lookup = (h: string) => closure.get(h);
  const { joints, mismatch } = solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
  expect(mismatch).toEqual([]);
  const mesh = plateMesh(plate.bodies[0]!.id);
  return { doc, lookup, joints, mesh };
}
const deg = Math.PI / 180;

describe('a joint’s range and the clearance between components (CR7c, TS-1814)', () => {
  it('steps a joint value through its limits and finds the first value that overlaps', () => {
    const { doc, lookup, joints, mesh } = lidOnHinge();
    const range = jointRangeSamples(doc, 'hinge', 'angle', 7);
    if ('code' in range) throw new Error(range.code);
    expect(range.values.map((v) => Math.round(v / deg))).toEqual([0, 5, 10, 15, 20, 25, 30]);
    const r = checkCadInterferenceAlong(
      { doc, lookup, meshesOf: () => mesh, joints },
      range.samples,
    );
    if (r.status !== 'ok') throw new Error(r.code);
    // The far end reaches the base's top (z 5) past asin(15 / 80) ≈ 10.8°.
    expect(r.hits.map((h) => Math.round(range.values[h.tick]! / deg))).toEqual([15, 20, 25, 30]);
    expect(r.hits[0]!.findings.map((f) => [f.a, f.b])).toEqual([[['base'], ['lid']]]);
    // Refusals: a value the joint does not have, no limits, too few or many steps.
    expect(jointRangeSamples(doc, 'hinge', 'distance', 7)).toEqual({ code: 'range-value' });
    expect(jointRangeSamples(doc, 'hinge', 'angle', 1)).toEqual({ code: 'range-steps' });
    expect(jointRangeSamples(doc, 'hinge', 'angle', 65)).toEqual({ code: 'range-steps' });
    expect(jointRangeSamples(doc, 'gone', 'angle', 7)).toEqual({ code: 'target-missing' });
    // An inactive mount candidate (MR7) moves nothing: refused.
    const mounted = {
      ...doc,
      mounts: [
        { id: 'm', name: 'm', component: 'lid', joints: ['other', 'hinge'], active: 'other' },
      ],
    };
    expect(jointRangeSamples(mounted, 'hinge', 'angle', 7)).toEqual({ code: 'joint-inactive' });
    const free = { joints: doc.joints.map((j) => ({ ...j, limits: [] })) };
    expect(jointRangeSamples(free, 'hinge', 'angle', 7)).toEqual({ code: 'range-no-limits' });
  });

  it('measures the clearance between two components and where it runs', () => {
    const { doc, lookup, joints, mesh } = lidOnHinge();
    const input = { doc, lookup, meshesOf: () => mesh, joints };
    const r = cadClearance(input, ['base'], ['lid']);
    if (r.status !== 'ok') throw new Error(r.code);
    // The lid's underside at z 20, the base's top at z 5.
    expect(r.distanceMm).toBeCloseTo(15, 4);
    expect(r.a[2]).toBeCloseTo(5, 4);
    expect(r.b[2]).toBeCloseTo(20, 4);
    // At 10° the far end is 20 − 80 sin 10° above z 0… the corner (80, y, 20) turned: z 20 − 80
    // sin 10°, less the base's top 5.
    const at = cadClearance(
      { ...input, values: new Map([['hinge', { angle: 10 * deg }]]) },
      ['base'],
      ['lid'],
    );
    if (at.status !== 'ok') throw new Error(at.code);
    expect(at.distanceMm).toBeCloseTo(20 - 80 * Math.sin(10 * deg) - 5, 3);
    // Overlapping at 20°: 0.
    const into = cadClearance(
      { ...input, values: new Map([['hinge', { angle: 20 * deg }]]) },
      ['base'],
      ['lid'],
    );
    expect(into.status === 'ok' && into.distanceMm).toBe(0);
    // Without a part's meshes, or the same component twice: refused.
    expect(cadClearance({ ...input, meshesOf: () => undefined }, ['base'], ['lid'])).toEqual({
      status: 'refused',
      code: 'clearance-meshes-missing',
      missing: [['base'], ['lid']],
    });
    expect(cadClearance(input, ['base'], ['base'])).toEqual({
      status: 'refused',
      code: 'clearance-same',
    });
    // At joint values, every joint must solve (no mixed pose), and a coupled value is refused.
    const hinge = { angle: 10 * deg };
    expect(
      cadClearance(
        {
          ...input,
          joints: { ...joints, hinge: { ...joints.hinge!, status: 'broken' } } as typeof joints,
          values: new Map([['hinge', hinge]]),
        },
        ['base'],
        ['lid'],
      ),
    ).toEqual({ status: 'refused', code: 'part-joint-broken' });
    const coupled = {
      ...doc,
      joints: doc.joints.map((j) => ({
        ...j,
        couplings: [
          { of: 'angle' as const, from: { joint: 'x', of: 'angle' as const }, ratio: 1, offset: 0 },
        ],
      })),
    };
    expect(
      cadClearance(
        { ...input, doc: coupled, values: new Map([['hinge', hinge]]) },
        ['base'],
        ['lid'],
      ),
    ).toEqual({ status: 'refused', code: 'range-coupled' });
    const mounted = {
      ...doc,
      mounts: [
        { id: 'm', name: 'm', component: 'lid', joints: ['other', 'hinge'], active: 'other' },
      ],
    };
    expect(
      cadClearance(
        { ...input, doc: mounted, values: new Map([['hinge', hinge]]) },
        ['base'],
        ['lid'],
      ),
    ).toEqual({ status: 'refused', code: 'joint-inactive' });
  });

  it('measures from this document’s own bodies (a car’s skin) to a placed part', () => {
    const plate = f02Plate();
    const pv = fixtureVersion('plate', 'v1', plate);
    const doc = applyCadOperation(plate, {
      type: 'insertComponents',
      parts: [fixturePart('p', 'Plate', pv)],
      components: [fixtureComponent('lid', 'p', [0, 0, 20])],
    });
    const mesh = plateMesh(plate.bodies[0]!.id);
    const input = { doc, lookup: () => pv.content, meshesOf: () => mesh };
    expect(cadClearance(input, [], ['lid'])).toEqual({
      status: 'refused',
      code: 'clearance-meshes-missing',
      missing: [[]],
    });
    const r = cadClearance({ ...input, ownMeshes: mesh }, ['lid'], []);
    expect(r.status === 'ok' && r.distanceMm).toBeCloseTo(15, 4);
    const empty = lidOnHinge();
    expect(
      cadClearance(
        { doc: empty.doc, lookup: empty.lookup, meshesOf: () => empty.mesh },
        [],
        ['lid'],
      ),
    ).toEqual({ status: 'refused', code: 'clearance-empty' });
  });
});
