import { describe, expect, it, vi } from 'vitest';
import {
  cadAssemblyLimits,
  expandAssembly,
  stepPose,
  type CadComponentPattern,
  type CadSolvedPose,
} from './assembly';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { r2bBom } from './bom-fixtures';
import { bomRows } from './bom';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { jointTargets, solveJoints } from './joints';
import { fixtureKernel } from './fixtures';
import { emptyCad, mm, position, type CadDocument } from './model';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import type { CadEvaluateRequest, CadEvaluation } from './coordinator';
import { applyCadOperation, cadContentHash } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const near = (a: CadSolvedPose | undefined, b: CadSolvedPose) => {
  expect(a).toBeDefined();
  a!.translationMm.forEach((v, i) => expect(v).toBeCloseTo(b.translationMm[i]!, 9));
  a!.rotation.forEach((v, i) => expect(v).toBeCloseTo(b.rotation[i]!, 9));
};
const quarter = Math.SQRT1_2;
const row = (id: string, seed: string, count: number, spacing = 20): CadComponentPattern => ({
  id,
  name: id,
  seedComponentId: seed,
  layout: { type: 'linear', direction: [1, 0, 0], count: { literal: count }, spacing: mm(spacing) },
});

describe('component patterns (R2b-3, CAD46/CAD49)', () => {
  const f = r2bBom();
  const lookup = (h: string) => f.closure.get(h);

  it('lays copies out from the seed’s pose, right after it, without storing them', () => {
    expect(validateCad(f.assembly)).toEqual([]);
    expect(Object.keys(f.assembly.solvedPoses).some((k) => k.startsWith('copy:'))).toBe(false);
    const { occurrences } = expandAssembly(f.assembly, lookup);
    const top = occurrences.filter((o) => o.path.length === 1).map((o) => o.path[0]);
    const ring = top.indexOf('c-bolt-ring');
    expect(top.slice(ring, ring + 8)).toEqual([
      'c-bolt-ring',
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => `copy:p-ring:${i}`),
    ]);
    expect(top.slice(ring + 8)).toEqual([
      'c-bolt-row',
      ...[1, 2, 3, 4, 5].map((i) => `copy:p-row:${i}`),
    ]);
    const at = (p: string) => occurrences.find((o) => o.path.join('/') === p)!;
    // A quarter turn about the vertical axis through (250, 100).
    near(at('copy:p-ring:2').pose, {
      translationMm: [250, 150, 5],
      rotation: [0, 0, quarter, quarter],
    });
    near(at('copy:p-row:5').pose, { translationMm: [100, 400, 5], rotation: [0, 0, 0, 1] });
    // Every copy is the seed's part: one evaluation of the bolt version serves them all.
    expect(new Set(occurrences.map((o) => o.part.source.contentHash)).size).toBe(4);
    // Moving the seed moves its copies.
    const moved = applyCadOperation(f.assembly, {
      type: 'setComponentPlacement',
      componentId: 'c-bolt-row',
      placement: { translation: position(0, 500, 5), rotation: [0, 0, 0, 1] },
    });
    near(
      expandAssembly(moved, lookup).occurrences.find((o) => o.path[0] === 'copy:p-row:5')!.pose,
      { translationMm: [100, 500, 5], rotation: [0, 0, 0, 1] },
    );
  });

  it('refuses malformed patterns with the path that is wrong', () => {
    const cases: [(d: CadDocument) => void, string][] = [
      [(d) => (d.componentPatterns[0]!.seedComponentId = 'nope'), 'component-pattern-seed'],
      [(d) => (d.componentPatterns[1]!.layout.count = { literal: 0 }), 'count-range'],
      [(d) => (d.componentPatterns[1]!.layout.count = { literal: 1001 }), 'count-range'],
      [
        (d) => ((d.componentPatterns[1]!.layout as { direction: number[] }).direction = [1, 1, 0]),
        'pattern-direction',
      ],
      [(d) => (d.componentPatterns[1]!.id = 'c-bolt-row'), 'duplicate-id'],
      [
        (d) => (d.componentPatterns[0] = { ...d.componentPatterns[0]!, x: 1 } as never),
        'unknown-field',
      ],
      [(d) => (d.components.at(-1)!.id = 'copy:p-row:9'), 'component-id-reserved'],
      [
        (d) =>
          d.componentPatterns.push(
            ...[1, 2, 3, 4, 5].map((i) => row(`p-many-${i}`, 'c-bolt-1', 1000)),
          ),
        'limit-pattern-copies@$.componentPatterns',
      ],
    ];
    for (const [edit, code] of cases) {
      const d = structuredClone(f.assembly);
      edit(d);
      expect(
        codes(d).some((c) => c.startsWith(code)),
        `${code}: ${codes(d)}`,
      ).toBe(true);
    }
    // 4,096 copies (seeds included) is the limit itself.
    const d = structuredClone(f.assembly);
    d.componentPatterns.push(
      ...[1, 2, 3, 4].map((i) => row(`p-many-${i}`, 'c-bolt-1', 1000)),
      row('p-rest', 'c-bolt-2', cadAssemblyLimits.patternCopies - 4000 - 8 - 6),
    );
    expect(codes(d)).toEqual([]);
    // Far past the limit: refused without listing every copy first.
    const huge = structuredClone(f.assembly);
    huge.componentPatterns.push(
      ...Array.from({ length: 100 }, (_, i) => row(`p-huge-${i}`, 'c-bolt-1', 1000)),
    );
    const set = vi.spyOn(Map.prototype, 'set');
    try {
      expect(codes(huge)).toContain('limit-pattern-copies@$.componentPatterns');
      expect(set.mock.calls.length).toBeLessThan(cadAssemblyLimits.patternCopies * 2);
    } finally {
      set.mockRestore();
    }
  });

  it('counts copies as instances and stops at the instance limit', () => {
    const bolts = fixtureVersion(
      'bolts',
      'v1',
      applyCadOperation(
        applyCadOperation(emptyCad(fixtureKernel), {
          type: 'insertComponents',
          parts: [fixturePart('b', 'Bolt', f.bolt)],
          components: [fixtureComponent('b-1', 'b')],
        }),
        { type: 'insertComponentPattern', pattern: row('p-b', 'b-1', 1000, 1) },
      ),
    );
    const closure = new Map([...f.closure, [bolts.contentHash, bolts.content]]);
    const place = (count: number) =>
      applyCadOperation(
        applyCadOperation(emptyCad(fixtureKernel), {
          type: 'insertComponents',
          parts: [fixturePart('s', 'Bolts', bolts)],
          components: [fixtureComponent('s-1', 's')],
        }),
        { type: 'insertComponentPattern', pattern: row('p-s', 's-1', count, 10) },
      );
    const nine = expandAssembly(place(9), (h) => closure.get(h));
    expect(nine.limit).toBeUndefined();
    expect(nine.occurrences).toHaveLength(9 * 1001);
    // A copy inside a sub-assembly copy: the path names both.
    expect(nine.occurrences.at(-1)!.path).toEqual(['copy:p-s:8', 'copy:p-b:999']);
    near(nine.occurrences.at(-1)!.pose, {
      translationMm: [80 + 999, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    expect(expandAssembly(place(10), (h) => closure.get(h)).limit).toBe('limit-instances');
  });

  it('lets a joint hang from a copy, and refuses the edit that removes that copy', () => {
    const base = applyCadOperation(f.assembly, {
      type: 'insertComponents',
      parts: [],
      components: [fixtureComponent('c-cap', 'part-plate-1')],
    });
    const doc = applyCadOperation(base, {
      type: 'insertJoint',
      joint: fixtureJoint(
        'j-cap',
        'fastened',
        fixtureConnector(['copy:p-ring:2']),
        'c-cap',
        fixtureConnector(),
      ),
    });
    expect(validateCad(doc)).toEqual([]);
    const solved = solveJoints(
      doc,
      parameterValues(doc),
      lookup,
      () => undefined,
      () => true,
    );
    expect(solved.joints['j-cap']?.status).toBe('solved');
    near(solved.poses['c-cap'], {
      translationMm: [250, 150, 5],
      rotation: [0, 0, quarter, quarter],
    });
    near(stepPose(doc, solved.poses, 'copy:p-ring:2'), solved.poses['c-cap']!);
    expect(jointTargets(doc, doc.joints[0]!, lookup).parent.status).toBe('found');
    // Lowering the count past the copy: the joint's parent would be missing.
    const ring = doc.componentPatterns[0]!;
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateComponentPattern',
        pattern: { ...ring, layout: { ...ring.layout, count: { literal: 2 } } },
      }),
    ).toThrow('cad-invalid:connector-copy-missing@$.joints[0].parent.componentPath[0]');
    const three = applyCadOperation(doc, {
      type: 'updateComponentPattern',
      pattern: { ...ring, name: 'Three bolts', layout: { ...ring.layout, count: { literal: 3 } } },
    });
    expect(three.componentPatterns[0]!.name).toBe('Three bolts');
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateComponentPattern',
        pattern: { ...ring, seedComponentId: 'c-bolt-row' },
      }),
    ).toThrow('component-pattern-seed-changed');
    // Deleting the seed takes its pattern and the joint along; the cap stays where it stands.
    expect(() =>
      applyCadOperation(doc, { type: 'deleteClosure', ids: ['c-bolt-ring'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const gone = applyCadOperation(doc, {
      type: 'deleteClosure',
      ids: ['c-bolt-ring'],
      cascade: true,
    });
    expect(gone.componentPatterns.map((p) => p.id)).toEqual(['p-row']);
    expect(gone.joints).toEqual([]);
    expect(gone.components.find((c) => c.id === 'c-cap')!.placement).not.toBeNull();
    // Deleting only the pattern takes the joint on its copy.
    const unpatterned = applyCadOperation(doc, {
      type: 'deleteClosure',
      ids: ['p-ring'],
      cascade: true,
    });
    expect(unpatterned.joints).toEqual([]);
    expect(unpatterned.components.some((c) => c.id === 'c-bolt-ring')).toBe(true);
  });

  it('never moves a copy by a joint, and keeps a copy and its seed off one branch', () => {
    const d = structuredClone(f.assembly);
    d.components.find((c) => c.id === 'c-bolt-1')!.placement = null;
    d.joints.push(
      fixtureJoint('j', 'fastened', fixtureConnector(), 'copy:p-row:1', fixtureConnector()),
    );
    expect(codes(d)).toContain('joint-child@$.joints[0].child.componentId');
    // The seed cannot hang from its own copy.
    expect(() =>
      applyCadOperation(f.assembly, {
        type: 'insertJoint',
        joint: fixtureJoint(
          'j',
          'fastened',
          fixtureConnector(['copy:p-row:1']),
          'c-bolt-row',
          fixtureConnector(),
        ),
      }),
    ).toThrow('joint-cycle');
  });

  it('lets a joint hang from a copy of a pattern whose ID is as long as an ID may be', () => {
    const id = 'p'.repeat(128);
    const doc = [
      { type: 'insertComponentPattern', pattern: row(id, 'c-bolt-1', 3) },
      {
        type: 'insertComponents',
        parts: [],
        components: [fixtureComponent('c-cap', 'part-plate-1')],
      },
      {
        type: 'insertJoint',
        joint: fixtureJoint(
          'j-cap',
          'fastened',
          fixtureConnector([`copy:${id}:2`]),
          'c-cap',
          fixtureConnector(),
        ),
      },
    ].reduce((d, op) => applyCadOperation(d, op as never), f.assembly);
    expect(validateCad(doc)).toEqual([]);
    expect(jointTargets(doc, doc.joints[0]!, lookup).parent.status).toBe('found');
  });

  it('leaves an excluded seed’s copies out of the BOM, and renames a pattern', () => {
    const out = applyCadOperation(f.assembly, {
      type: 'setComponentBom',
      componentId: 'c-bolt-ring',
      bom: 'exclude',
    });
    expect(bomRows(out, lookup, 'flat').at(-1)!.quantity).toBe(24 - 8);
    const renamed = applyCadOperation(f.assembly, {
      type: 'rename',
      targetId: 'p-row',
      name: 'Six bolts',
    });
    expect(renamed.componentPatterns[1]!.name).toBe('Six bolts');
    expect(() =>
      applyCadOperation(f.assembly, {
        type: 'insertComponentPattern',
        pattern: row('p-x', 'nope', 2),
      }),
    ).toThrow('target-missing');
  });
});

describe('component patterns in the per-part evaluation (R2b-3, CAD49)', () => {
  it('evaluates each version once however many copies, and a count change evaluates none', async () => {
    const f = r2bBom();
    const jobs: string[] = [];
    const ok = (request: CadEvaluateRequest): CadEvaluation => ({
      status: 'ok',
      contentHash: request.candidateHash,
      buildHash: request.document.kernelProfile.buildHash,
      geometryDigest: 'd',
      bodies: {},
    });
    const kernel: CadPartKernelPort = {
      evaluate: async (request) => ok(request),
      evaluatePart: async (request) => {
        jobs.push(request.candidateHash);
        return ok(request);
      },
      cancel: () => {},
    };
    const port = new CadAssemblyPort({ kernel, parts: (h) => f.closure.get(h) });
    const request = (document: CadDocument, requestId: string): CadEvaluateRequest => ({
      requestId,
      generation: 0,
      baseHash: cadContentHash(document),
      candidateHash: cadContentHash(document),
      document,
    });
    expect((await port.evaluate(request(f.assembly, 'r1'))).status).toBe('ok');
    // 4 wheels × 3 parts, 2 + 8 + 6 bolts and 3 plates: four versions, each evaluated once.
    expect(jobs.sort()).toEqual(
      [f.plate1, f.plate2, f.bolt, f.wheel].map((v) => v.contentHash).sort(),
    );
    const ring = f.assembly.componentPatterns[0]!;
    const more = applyCadOperation(f.assembly, {
      type: 'updateComponentPattern',
      pattern: { ...ring, layout: { ...ring.layout, count: { literal: 12 } } },
    });
    expect((await port.evaluate(request(more, 'r2'))).status).toBe('ok');
    expect(jobs).toHaveLength(4);
  });
});
