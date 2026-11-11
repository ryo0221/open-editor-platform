import { describe, expect, it } from 'vitest';
import { assertCadOperation } from './commands';
import { compareCad } from './diff';
import {
  cadInterferenceLimits,
  checkCadInterference,
  checkCadInterferenceAlong,
  prepareMeshes,
  type CadInterferenceAllowance,
  type CadInterferenceMesh,
} from './interference';
import { parameterValues } from './graph';
import { solveJoints } from './joints';
import { mr2ArmWingsForms } from './mecha-fixtures';
import type { CadDocument } from './model';
import { applyCadOperation, type CadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const run = (doc: CadDocument, op: CadOperation) => {
  assertCadOperation(op);
  return applyCadOperation(doc, op);
};
const refused = (doc: CadDocument, op: CadOperation) => {
  try {
    run(doc, op);
  } catch (e) {
    return (e as Error).message;
  }
  return 'applied';
};
/**
 * A plate as the kernel meshes it: a closed box 90 × 10 × 5 mm from its origin, each face cut
 * into cells of about 2.5 mm (an allowance region judges the crossing triangles' vertices).
 */
function plate(): CadInterferenceMesh[] {
  const lo = [-5, -5, 0];
  const hi = [85, 5, 5];
  const cell = 2.5;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const nu = Math.ceil((hi[u]! - lo[u]!) / cell);
      const nv = Math.ceil((hi[v]! - lo[v]!) / cell);
      const base = positions.length / 3;
      for (let i = 0; i <= nu; i++)
        for (let j = 0; j <= nv; j++) {
          const p = [0, 0, 0];
          p[axis] = side ? hi[axis]! : lo[axis]!;
          p[u] = lo[u]! + ((hi[u]! - lo[u]!) * i) / nu;
          p[v] = lo[v]! + ((hi[v]! - lo[v]!) * j) / nv;
          // Relative to the mesh origin (1, 0, 0), as the kernel gives positions.
          positions.push(p[0]! - 1, p[1]!, p[2]!);
        }
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          const a = base + i * (nv + 1) + j;
          const b = a + nv + 1;
          if (side) indices.push(a, b, b + 1, a, b + 1, a + 1);
          else indices.push(a, b + 1, b, a, a + 1, b + 1);
        }
    }
  return [
    {
      bodyId: 'plate',
      origin: [1, 0, 0],
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    },
  ];
}
function setup() {
  const f = mr2ArmWingsForms();
  const doc = f.assembly;
  const lookup = (h: string) => f.closure.get(h);
  const { joints } = solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
  const mesh = plate();
  const check = (d: CadDocument, more: { form?: number; meshes?: boolean } = {}) =>
    checkCadInterference({
      doc: d,
      lookup,
      meshesOf: () => (more.meshes === false ? undefined : mesh),
      joints,
      ...(more.form === undefined ? {} : { form: d.configurations![more.form]! }),
    });
  const along = (d: CadDocument, samples: Parameters<typeof checkCadInterferenceAlong>[1]) =>
    checkCadInterferenceAlong({ doc: d, lookup, meshesOf: () => mesh, joints }, samples);
  return { doc, check, along };
}
const pairs = (r: ReturnType<ReturnType<typeof setup>['check']>) =>
  r.status === 'ok' ? r.findings.map((f) => `${f.a.join('/')}–${f.b.join('/')}:${f.kind}`) : r.code;
const allow = (
  id: string,
  a: string,
  b: string,
  region: CadInterferenceAllowance['region'] = { kind: 'pair' },
): CadOperation => ({
  type: 'insertInterferenceAllowance',
  allowance: { id, a: [a], b: [b], region },
});

describe('MR3 interference in an assembly (TS-1708)', () => {
  it('checks the current pose and a form’s, joined parts included', () => {
    const { doc, check } = setup();
    // Standing, the bent elbow and wrist push each plate into the next.
    expect(pairs(check(doc))).toEqual(['c-upper–c-fore:intersect', 'c-fore–c-hand:intersect']);
    // In Flight the arm lies straight, yet each plate still reaches into the next one's end.
    const flight = check(doc, { form: 1 });
    expect(pairs(flight)).toEqual(['c-upper–c-fore:intersect', 'c-fore–c-hand:intersect']);
    // The form is checked in its own poses (the overlaps differ from the bent arm's); the
    // document's stay as they are.
    const depths = (r: ReturnType<typeof check>) =>
      r.status === 'ok' ? r.findings.map((f) => f.depthMm) : [];
    expect(Math.abs(depths(check(doc))[0]! - depths(flight)[0]!)).toBeGreaterThan(0.1);
    expect(doc.solvedPoses).toEqual(mr2ArmWingsForms().assembly.solvedPoses);
  });
  it('applies a joint sphere around the elbow and a pair allowance, and only those', () => {
    const { doc, check } = setup();
    const elbow = run(
      doc,
      allow('allow-elbow', 'c-fore', 'c-upper', {
        kind: 'joint-sphere',
        joint: 'j-elbow',
        radiusMm: 15,
      }),
    );
    expect(pairs(check(elbow))).toEqual(['c-fore–c-hand:intersect']);
    // The sphere goes with the elbow into a form's poses (the shoulder turns the whole arm).
    expect(pairs(check(elbow, { form: 1 }))).toEqual(['c-fore–c-hand:intersect']);
    // Too small a sphere leaves crossing triangles outside it: still reported.
    const small = run(
      doc,
      allow('allow-elbow', 'c-upper', 'c-fore', {
        kind: 'joint-sphere',
        joint: 'j-elbow',
        radiusMm: 2,
      }),
    );
    expect(pairs(check(small))).toEqual(['c-upper–c-fore:intersect', 'c-fore–c-hand:intersect']);
    const both = run(elbow, allow('allow-hand', 'c-hand', 'c-fore'));
    expect(pairs(check(both))).toEqual([]);
    expect(compareCad(elbow, both).map((c) => `${c.kind}:${c.path}:${c.elementId}`)).toEqual([
      'added:interferenceAllowances:allow-hand',
    ]);
  });
  it('lists parts without meshes as unchecked and allowances that name nothing as stale', () => {
    const { doc, check } = setup();
    const r = check(doc, { meshes: false });
    // The assembly's own plate too, never reported clear.
    expect(r.status === 'ok' && [r.findings, r.unchecked]).toEqual([
      [],
      [[], ['c-upper'], ['c-fore'], ['c-hand'], ['c-wing-l'], ['c-wing-r']],
    ]);
    const own = checkCadInterference({
      doc,
      lookup: (h) => mr2ArmWingsForms().closure.get(h),
      meshesOf: () => plate(),
      ownMeshes: plate(),
      joints: {},
    });
    expect(own.status === 'ok' && own.unchecked).toEqual([]);
    // An empty mesh list for a part with active bodies (a failed evaluation) is not clear.
    const empty = checkCadInterference({
      doc,
      lookup: (h) => mr2ArmWingsForms().closure.get(h),
      meshesOf: () => [],
      ownMeshes: plate(),
      joints: {},
    });
    expect(empty.status === 'ok' && empty.unchecked.length).toBe(5);
    // Meshes for some active bodies only (a partial evaluation): the part is not clear either.
    const upper = mr2ArmWingsForms().closure.get(doc.parts[0]!.source.contentHash)!;
    const twoBodies = { ...upper, bodies: [...upper.bodies, { ...upper.bodies[0]!, id: 'more' }] };
    const partial = checkCadInterference({
      doc,
      lookup: (h) =>
        h === doc.parts[0]!.source.contentHash ? twoBodies : mr2ArmWingsForms().closure.get(h),
      meshesOf: () => plate(),
      ownMeshes: plate(),
      joints: {},
    });
    expect(partial.status === 'ok' && partial.unchecked.length).toBeGreaterThan(0);
    const stale = structuredClone(doc);
    stale.interferenceAllowances = [
      { id: 'allow-gone', a: ['c-gone'], b: ['c-fore'], region: { kind: 'pair' } },
      {
        id: 'allow-no-joint',
        a: ['c-upper'],
        b: ['c-fore'],
        region: { kind: 'joint-sphere', joint: 'j-gone', radiusMm: 15 },
      },
    ];
    expect(codes(stale)).toEqual([]);
    const s = check(stale);
    expect(s.status === 'ok' && s.stale).toEqual(['allow-gone', 'allow-no-joint']);
    expect(pairs(s)).toEqual(['c-upper–c-fore:intersect', 'c-fore–c-hand:intersect']);
  });
  it('refuses a stale form instead of checking a mixed pose (Codex #1007)', () => {
    const { doc, check } = setup();
    const stale = structuredClone(doc);
    const form = stale.configurations![1]!;
    delete form.values[Object.keys(form.values)[0]!];
    expect(pairs(check(stale, { form: 1 }))).toBe('configuration-stale');
  });
  it('refuses a form whose joints do not solve, a coupled follower included (Codex #1007)', () => {
    const { doc } = setup();
    const f = mr2ArmWingsForms();
    const form = doc.configurations![1]!;
    const lookup = (h: string) => f.closure.get(h);
    const { joints } = solveJoints(
      doc,
      parameterValues(doc),
      lookup,
      () => undefined,
      () => true,
    );
    const check = (id: string, solution: unknown) =>
      checkCadInterference({
        doc,
        lookup,
        meshesOf: () => plate(),
        joints: { ...joints, [id]: solution } as never,
        form,
      });
    const named = Object.keys(form.values)[0]!;
    expect(pairs(check(named, { status: 'unavailable' }))).toBe('joint-part-unavailable');
    expect(pairs(check(named, { status: 'broken', problems: [] }))).toBe('part-joint-broken');
    // The right wing follows the left one and has no values of its own in the form.
    expect(form.values['j-wing-r']).toBeUndefined();
    expect(pairs(check('j-wing-r', { status: 'unavailable' }))).toBe('joint-part-unavailable');
    expect(pairs(check('j-wing-r', joints['j-wing-r']))).not.toBe('joint-part-unavailable');
  });
  it('accepts a pattern copy step longer than an ID in an allowance path (Codex #1007)', () => {
    const { doc } = setup();
    const d = structuredClone(doc);
    d.interferenceAllowances = [
      {
        id: 'allow-copy',
        a: [`copy:${'p'.repeat(128)}:2`],
        b: ['c-fore'],
        region: { kind: 'pair' },
      },
    ];
    expect(codes(d)).not.toContain('interference-allowance-path');
  });
  it('uses only solved joints for spheres (Codex #1007)', () => {
    const { doc } = setup();
    const f = mr2ArmWingsForms();
    const elbow = run(
      doc,
      allow('allow-elbow', 'c-fore', 'c-upper', {
        kind: 'joint-sphere',
        joint: 'j-elbow',
        radiusMm: 15,
      }),
    );
    const { joints } = solveJoints(
      elbow,
      parameterValues(elbow),
      (h) => f.closure.get(h),
      () => undefined,
      () => true,
    );
    const solved = joints['j-elbow'] as Extract<(typeof joints)[string], { status: 'solved' }>;
    const r = checkCadInterference({
      doc: elbow,
      lookup: (h) => f.closure.get(h),
      meshesOf: () => plate(),
      joints: { ...joints, 'j-elbow': { status: 'unavailable', parent: solved.parent } },
    });
    expect(r.status === 'ok' && r.stale).toEqual(['allow-elbow']);
  });
  it('keeps a part’s separate bodies as separate volumes (Codex #1007)', () => {
    // Two nested solid boxes in one part must not cancel as a cavity: a part inside both is
    // contained.
    const { doc } = setup();
    const f = mr2ArmWingsForms();
    const hash = doc.parts[0]!.source.contentHash;
    const part = f.closure.get(hash)!;
    const twoBodies = {
      ...part,
      bodies: [...part.bodies, { ...part.bodies[0]!, id: 'inner' }],
    };
    const outer = plate();
    const inner = plate().map((m) => ({
      ...m,
      bodyId: 'inner',
      positions: Float32Array.from(m.positions, (v, i) => (i % 3 === 0 ? v : v * 0.8)),
    }));
    const r = checkCadInterference({
      doc,
      lookup: (h) => (h === hash ? twoBodies : f.closure.get(h)),
      meshesOf: (h) => (h === hash ? [...outer, ...inner] : plate()),
      joints: {},
    });
    // Its own two bodies are not a pair; the pairs it reports are with other components.
    expect(r.status === 'ok' && r.findings.every((x) => x.a.join() !== x.b.join())).toBe(true);
    expect(r.status === 'ok' && r.findings.length).toBeGreaterThan(0);
  });
  it('checks each body once, standard over coarse, and never a shape before a failure (Codex #1007)', () => {
    const { doc } = setup();
    const f = mr2ArmWingsForms();
    const lookup = (h: string) => f.closure.get(h);
    const run = (meshes: CadInterferenceMesh[]) =>
      checkCadInterference({ doc, lookup, meshesOf: () => meshes, ownMeshes: plate(), joints: {} });
    const plain = run(plate());
    // The kernel's coarse alternatives follow the standard meshes: the same report.
    const withCoarse = run([...plate(), ...plate().map((m) => ({ ...m, lod: 'coarse' as const }))]);
    expect(pairs(withCoarse)).toEqual(pairs(plain));
    expect(pairs(plain).length).toBeGreaterThan(0);
    // Coarse meshes alone still stand for the body.
    expect(pairs(run(plate().map((m) => ({ ...m, lod: 'coarse' as const }))))).toEqual(
      pairs(plain),
    );
    // A shape before a failed feature is display only: every part is unchecked, nothing found.
    const failed = run(plate().map((m) => ({ ...m, beforeFailure: 'upper-box' })));
    expect(failed.status === 'ok' && [failed.findings, failed.unchecked.length]).toEqual([[], 5]);
  });
  it('prepares a mesh list once for every occurrence and recheck (Codex #1007)', () => {
    const meshes = plate();
    const first = prepareMeshes(meshes, undefined);
    expect(prepareMeshes(meshes, undefined)).toBe(first);
    expect(first.byBody.get('plate')![0]!.positions[0]).toBe(meshes[0]!.positions[0]! + 1);
  });
  it('edits allowances as one edit each and refuses duplicates and malformed ones', () => {
    const { doc } = setup();
    const one = run(doc, allow('allow-a', 'c-upper', 'c-fore'));
    expect(refused(one, allow('allow-b', 'c-fore', 'c-upper'))).toBe(
      'interference-allowance-duplicate',
    );
    const gone = run(one, { type: 'removeInterferenceAllowance', id: 'allow-a' });
    expect(Object.hasOwn(gone, 'interferenceAllowances')).toBe(false);
    expect(refused(gone, { type: 'removeInterferenceAllowance', id: 'allow-a' })).toBe(
      'target-missing',
    );
    const bad = (x: unknown) => {
      const d = structuredClone(doc) as unknown as Record<string, unknown>;
      d.interferenceAllowances = x;
      return codes(d);
    };
    expect(bad([])).toContain('interference-allowances');
    expect(bad([{ id: 'x', a: ['c-upper'], b: ['c-upper'], region: { kind: 'pair' } }])).toContain(
      'interference-allowance-same',
    );
    expect(bad([{ id: 'x', a: [' c'], b: ['c-upper'], region: { kind: 'pair' } }])).toContain(
      'interference-allowance-path',
    );
    expect(
      bad([
        {
          id: 'x',
          a: ['c-fore'],
          b: ['c-upper'],
          region: { kind: 'joint-sphere', joint: 'j-elbow', radiusMm: 0 },
        },
      ]),
    ).toContain('interference-allowance-radius');
    expect(bad([{ id: 'x', a: ['c-fore'], b: ['c-upper'], region: { kind: 'box' } }])).toContain(
      'interference-allowance-region',
    );
    expect(
      bad([{ id: 'j-elbow', a: ['c-fore'], b: ['c-upper'], region: { kind: 'pair' } }]),
    ).toContain('duplicate-id');
    const many = Array.from({ length: cadInterferenceLimits.allowances + 1 }, (_, i) => ({
      id: `x${i}`,
      a: ['c-fore'],
      b: [`c-${i}`],
      region: { kind: 'pair' },
    }));
    expect(bad(many)).toContain('limit-interference-allowances');
  });
});

describe('MR5 interference along a motion (TS-1714)', () => {
  const rad = (d: number) => (d * Math.PI) / 180;
  it('checks each sampled time in its own poses and reports the times that overlap', () => {
    const { doc, along } = setup();
    // The elbow and wrist allowed as they bend in normal use (a sphere at the elbow).
    const d = run(
      run(
        doc,
        allow('allow-elbow', 'c-fore', 'c-upper', {
          kind: 'joint-sphere',
          joint: 'j-elbow',
          radiusMm: 15,
        }),
      ),
      allow('allow-hand', 'c-hand', 'c-fore'),
    );
    // Folding the elbow from 0° to 150° in steps of 10°: only past 130° does the forearm fold
    // onto the upper arm beyond the sphere. Shuffled samples are checked in time order.
    const samples = Array.from({ length: 16 }, (_, i) => ({
      tick: i * 1000,
      values: new Map([['j-elbow', { angle: rad(i * 10) }]]),
    })).reverse();
    const r = along(d, samples);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.samples).toBe(16);
    expect(
      r.hits.map((h) => [
        h.tick,
        pairs({ ...r, status: 'ok', findings: h.findings, pairs: 0, triangles: 0 }),
      ]),
    ).toEqual([
      [14000, ['c-upper–c-fore:intersect']],
      [15000, ['c-upper–c-fore:intersect']],
    ]);
    expect(r.hits[1]!.findings[0]!.depthMm).toBeGreaterThan(r.hits[0]!.findings[0]!.depthMm);
    // The document's own poses stay as they are.
    expect(d.solvedPoses).toEqual(doc.solvedPoses);
  });
  it('refuses no samples, too many, and a time whose joints do not solve', () => {
    const { doc, along } = setup();
    const at = (tick: number) => ({ tick, values: new Map() });
    expect(along(doc, [])).toEqual({ status: 'refused', code: 'sweep-samples' });
    expect(
      along(
        doc,
        Array.from({ length: 601 }, (_, i) => at(i)),
      ),
    ).toEqual({
      status: 'refused',
      code: 'sweep-samples',
    });
    const broken = structuredClone(doc);
    broken.joints = broken.joints.map((j) =>
      j.id === 'j-wrist' ? { ...j, child: { ...j.child, componentId: 'c-gone' } } : j,
    );
    const r = checkCadInterferenceAlong(
      {
        doc: broken,
        lookup: () => undefined,
        meshesOf: () => undefined,
        joints: {},
      },
      [at(5)],
    );
    expect(r).toMatchObject({ status: 'refused', tick: 5 });
  });
});
