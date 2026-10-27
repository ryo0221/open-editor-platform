import { describe, expect, it } from 'vitest';
import {
  cadAssemblyLimits,
  composePoses,
  expandAssembly,
  poseMatrix,
  quaternionAngle,
  rotateVector,
  type CadSolvedPose,
  occurrenceAccess,
} from './assembly';
import { fixtureComponent, fixturePart, fixtureVersion, r2bParts } from './assembly-fixtures';
import { assertCadOperation } from './commands';
import { compareCad } from './diff';
import { f02Plate, fixtureKernel } from './fixtures';
import { emptyCad, mm, type CadDocument } from './model';
import { applyCadOperation, cadContentHash } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed input built by hand
type Loose = Record<string, any>;
const changed = (doc: CadDocument, change: (d: Loose) => void) => {
  const out = structuredClone(doc) as Loose;
  change(out);
  return out;
};
const near = (a: number[], b: number[], eps = 1e-9) =>
  a.every((x, i) => Math.abs(x - b[i]!) <= eps);

describe('assembly format (R2b-1, CAD46)', () => {
  it('admits saved versions placed by fixed components, with their solved poses', () => {
    const { assembly } = r2bParts();
    expect(codes(assembly)).toEqual([]);
    expect(assembly.parts.map((p) => p.id)).toEqual(['part-plate', 'part-shaft', 'part-pair']);
    expect(Object.keys(assembly.solvedPoses).sort()).toEqual(
      ['c-pair', 'c-plate-1', 'c-plate-2', 'c-shaft'].sort(),
    );
    expect(assembly.solvedPoses['c-plate-2']).toEqual({
      translationMm: [0, 100, 0],
      rotation: [0, 0, 0, 1],
    });
    // A part-only document carries the empty fields; there is no other schema to read.
    expect(codes(f02Plate())).toEqual([]);
    expect(codes(changed(f02Plate(), (d) => delete d.solvedPoses))).toContain(
      'missing-field@$.solvedPoses',
    );
  });

  it('refuses malformed parts and components with the path that is wrong', () => {
    const { assembly } = r2bParts();
    const cases: [(d: Loose) => void, string][] = [
      [(d) => (d.parts[0].source.kind = 'draft'), 'part-source-kind@$.parts[0].source'],
      [
        (d) => (d.parts[0].source.contentHash = 'abc'),
        'part-source-hash@$.parts[0].source.contentHash',
      ],
      [(d) => (d.parts[0].source.versionId = ''), 'part-source@$.parts[0].source.versionId'],
      [(d) => (d.parts[0].source.latest = true), 'unknown-field@$.parts[0].source.latest'],
      [
        (d) => (d.parts[1].source = { ...d.parts[0].source }),
        'part-source-duplicate@$.parts[1].source',
      ],
      [
        (d) =>
          (d.parts[0].hint.boundsMm = [
            [1, 0, 0],
            [0, 1, 1],
          ]),
        'part-hint@$.parts[0].hint.boundsMm',
      ],
      [(d) => (d.components[0].partId = 'nope'), 'component-part@$.components[0].partId'],
      [(d) => (d.components[0].bom = 'maybe'), 'component-bom@$.components[0].bom'],
      [(d) => (d.components[0].placement = null), 'component-unplaced@$.components[0].placement'],
      [
        (d) => (d.components[0].placement.rotation = [0, 0, 0, 2]),
        'quaternion-norm@$.components[0].placement.rotation',
      ],
      [(d) => (d.components[0].id = 'c-plate-2'), 'duplicate-id@$.components[1].id'],
      [(d) => (d.joints = [{}]), 'missing-field@$.joints[0].id'],
      [(d) => (d.componentPatterns = [1]), 'component-pattern@$.componentPatterns[0]'],
      [(d) => (d.componentPatterns = [{}]), 'missing-field@$.componentPatterns[0].id'],
      [(d) => (d.partProperties.partNumber = 'a\u0000'), 'name@$.partProperties.partNumber'],
      [(d) => delete d.solvedPoses['c-shaft'], 'pose-missing@$.solvedPoses.c-shaft'],
      [(d) => (d.solvedPoses.ghost = d.solvedPoses['c-shaft']), 'pose-unknown@$.solvedPoses.ghost'],
      [(d) => (d.solvedPoses['c-shaft'] = null), 'solved-poses@$.solvedPoses.c-shaft'],
      [(d) => (d.solvedPoses['c-shaft'] = 1), 'solved-poses@$.solvedPoses.c-shaft'],
      [(d) => (d.solvedPoses['c-shaft'] = []), 'solved-poses@$.solvedPoses.c-shaft'],
    ];
    for (const [change, code] of cases) expect(codes(changed(assembly, change))).toContain(code);
    // A definition no component uses is not kept.
    expect(
      codes(
        changed(
          assembly,
          (d) => (d.components = d.components.filter((c: Loose) => c.partId !== 'part-shaft')),
        ),
      ),
    ).toContain('part-unreferenced@$.parts[1]');
  });

  it('refuses a stored pose that is not its placement, at the residual boundary', () => {
    const { assembly } = r2bParts();
    const shifted = (dx: number) =>
      changed(assembly, (d) => (d.solvedPoses['c-shaft'].translationMm[0] += dx));
    expect(codes(shifted(0.9e-6))).toEqual([]);
    expect(codes(shifted(1.1e-6))).toContain('assembly-pose-mismatch@$.solvedPoses.c-shaft');
    const turned = (rad: number) =>
      changed(assembly, (d) => {
        d.solvedPoses['c-shaft'].rotation = [0, 0, Math.sin(rad / 2), Math.cos(rad / 2)];
      });
    expect(codes(turned(0.9e-9))).toEqual([]);
    expect(codes(turned(1.1e-9))).toContain('assembly-pose-mismatch@$.solvedPoses.c-shaft');
    // Every pose moved by the same amount is still refused: each is checked against its placement.
    const all = changed(assembly, (d) => {
      for (const p of Object.values(d.solvedPoses) as Loose[]) p.translationMm[2] += 1;
    });
    expect(codes(all).filter((c) => c.startsWith('assembly-pose-mismatch'))).toHaveLength(4);
  });

  it('checks the part and component limits at, and just past, the boundary', () => {
    const plate = fixtureVersion('plate', 'v1', f02Plate());
    const many = (n: number) => {
      const d = emptyCad(fixtureKernel);
      d.parts = [fixturePart('p', 'Plate', plate)];
      d.components = Array.from({ length: n }, (_, i) => fixtureComponent(`c${i}`, 'p'));
      d.solvedPoses = Object.fromEntries(
        d.components.map((c) => [c.id, { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] }]),
      );
      return d;
    };
    expect(codes(many(cadAssemblyLimits.components))).toEqual([]);
    expect(codes(many(cadAssemblyLimits.components + 1))).toContain(
      'limit-components@$.components',
    );
    const parts = (n: number) => {
      const d = emptyCad(fixtureKernel);
      d.parts = Array.from({ length: n }, (_, i) =>
        fixturePart(`p${i}`, 'Plate', { ...plate, versionId: `v${i}` }),
      );
      d.components = d.parts.map((p, i) => fixtureComponent(`c${i}`, p.id));
      d.solvedPoses = Object.fromEntries(
        d.components.map((c) => [c.id, { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] }]),
      );
      return d;
    };
    expect(codes(parts(cadAssemblyLimits.parts))).toEqual([]);
    expect(codes(parts(cadAssemblyLimits.parts + 1))).toContain('limit-parts@$.parts');
  });
});

describe('assembly edits (R2b-1)', () => {
  it('re-solves fixed poses when the parameter a placement reads changes, and deletes with it', () => {
    let doc = r2bParts().assembly;
    doc = applyCadOperation(doc, {
      type: 'insertFeatures',
      parameters: [{ id: 'gap', name: 'gap', type: 'length', value: 30 }],
      features: [],
    });
    doc = applyCadOperation(doc, {
      type: 'setComponentPlacement',
      componentId: 'c-shaft',
      placement: { translation: [mm(0), { parameterId: 'gap' }, mm(0)], rotation: [0, 0, 0, 1] },
    });
    expect(doc.solvedPoses['c-shaft']!.translationMm).toEqual([0, 30, 0]);
    doc = applyCadOperation(doc, { type: 'setParameter', parameterId: 'gap', value: 45 });
    expect(doc.solvedPoses['c-shaft']!.translationMm).toEqual([0, 45, 0]);
    expect(() =>
      applyCadOperation(doc, { type: 'deleteClosure', ids: ['gap'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const cut = applyCadOperation(doc, { type: 'deleteClosure', ids: ['gap'], cascade: true });
    expect(cut.components.map((c) => c.id)).not.toContain('c-shaft');
    // The shaft's definition goes with its last component, so the closure stays exact.
    expect(cut.parts.map((p) => p.id)).toEqual(['part-plate', 'part-pair']);
    expect(codes(cut)).toEqual([]);
  });

  it('deletes and renames components, sets the BOM values, and diffs them by ID', () => {
    const doc = r2bParts().assembly;
    const next = applyCadOperation(
      applyCadOperation(doc, { type: 'rename', targetId: 'c-plate-1', name: 'Base' }),
      { type: 'deleteClosure', ids: ['c-plate-2'], cascade: false },
    );
    expect(next.components.map((c) => c.name)).toEqual(['Base', 'c-shaft', 'c-pair']);
    expect(next.solvedPoses).not.toHaveProperty('c-plate-2');
    const props = applyCadOperation(next, {
      type: 'setPartProperties',
      partNumber: 'ASM-001',
      description: 'Test rig',
    });
    expect(props.partProperties).toEqual({ partNumber: 'ASM-001', description: 'Test rig' });
    const changes = compareCad(doc, next).map((c) => `${c.kind}:${c.path}:${c.elementId}`);
    expect(changes).toContain('removed:components:c-plate-2');
    expect(changes).toContain('changed:components.name:c-plate-1');
    // A BOM-values-only edit is a change too.
    expect(compareCad(next, props)).toEqual([
      expect.objectContaining({ elementId: 'partProperties', kind: 'changed' }),
    ]);
  });

  it('gates operation data and refuses a placement that is not fixed', () => {
    expect(() =>
      assertCadOperation({ type: 'insertComponents', parts: [], components: [] }),
    ).toThrow('operation-schema');
    expect(() =>
      assertCadOperation({ type: 'setComponentPlacement', componentId: 'c', placement: null }),
    ).toThrow('operation-schema');
    expect(() =>
      applyCadOperation(r2bParts().assembly, {
        type: 'setComponentPlacement',
        componentId: 'c-shaft',
        placement: null as never,
      }),
    ).toThrow('component-unplaced');
  });
});

describe('poses and expansion (R2b-1)', () => {
  it('composes poses and writes column-major matrices', () => {
    const quarter: CadSolvedPose = {
      translationMm: [10, 0, 0],
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    };
    expect(near(rotateVector(quarter.rotation, [1, 0, 0]), [0, 1, 0])).toBe(true);
    const child = composePoses(quarter, { translationMm: [5, 0, 0], rotation: [0, 0, 0, 1] });
    expect(near(child.translationMm, [10, 5, 0])).toBe(true);
    expect(quaternionAngle(child.rotation, quarter.rotation)).toBeLessThan(1e-12);
    const m = poseMatrix(quarter);
    expect(near(m, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1])).toBe(true);
  });

  it('expands nested versions with their saved poses, once per version', () => {
    const { assembly, closure, plate, pair } = r2bParts();
    const out = expandAssembly(assembly, (h) => closure.get(h));
    expect(out.occurrences.map((o) => o.path.join('/'))).toEqual([
      'c-plate-1',
      'c-plate-2',
      'c-shaft',
      'c-pair',
      'c-pair/pair-a',
      'c-pair/pair-b',
    ]);
    expect([...out.versions.keys()]).toEqual([
      plate.contentHash,
      out.occurrences[2]!.part.source.contentHash,
      pair.contentHash,
    ]);
    expect(out.depth).toBe(2);
    // pair-b sits 20 mm above pair-a inside the pair, which is turned a quarter about Z at x=200.
    const b = out.occurrences.find((o) => o.path.join('/') === 'c-pair/pair-b')!;
    expect(near(b.pose.translationMm, [200, 0, 20])).toBe(true);
    // A version the closure lacks is listed and its occurrence has no content.
    const partial = expandAssembly(assembly, (h) =>
      h === pair.contentHash ? undefined : closure.get(h),
    );
    expect([...partial.missing]).toEqual([pair.contentHash]);
    expect(partial.occurrences.find((o) => o.path[0] === 'c-pair')?.content).toBeUndefined();
    expect(partial.occurrences).toHaveLength(4);
    // A revoked sub-assembly hides what it places, though the plate is readable elsewhere.
    expect(occurrenceAccess(out.occurrences, (id) => id !== 'pair')).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('stops at the nesting depth limit', () => {
    let doc = f02Plate();
    const closure = new Map<string, CadDocument>();
    for (let level = 0; level <= cadAssemblyLimits.depth; level++) {
      const v = fixtureVersion(`a${level}`, 'v1', doc);
      closure.set(v.contentHash, v.content);
      doc = applyCadOperation(emptyCad(fixtureKernel), {
        type: 'insertComponents',
        parts: [fixturePart('p', 'Inner', v)],
        components: [fixtureComponent('c', 'p')],
      });
    }
    const out = expandAssembly(doc, (h) => closure.get(h));
    expect(out.limit).toBe('limit-assembly-depth');
    expect(out.depth).toBe(cadAssemblyLimits.depth);
    expect(cadContentHash(doc)).toMatch(/^[0-9a-f]{64}$/);
  });
});
