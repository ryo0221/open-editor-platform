import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  simulationFixture,
  simulationInputHash,
  validateSimulation,
  type SimulationDocument,
  type SimulationRunRecord,
} from './index';

/** TS-1351 (ST-189#1): one recorded run per study, checked, replaced and removed with its study. */
const record = (
  doc: SimulationDocument,
  patch: Partial<SimulationRunRecord> = {},
): SimulationRunRecord => ({
  id: 'run',
  studyId: doc.studies[0]!.id,
  inputs: {
    simulationHash: simulationInputHash(doc),
    cadContentHash: doc.source.contentHash,
    kernelBuild: 'sha256:kernel',
    mesherBuild: 'sha256:mesher',
    solverBuild: 'sha256:solver',
  },
  levels: [
    {
      size: 10,
      nodes: 120,
      elements: 300,
      metrics: { 'max-displacement': 0.1, 'max-von-mises': 12, 'reaction-force': 500 },
    },
  ],
  checks: [{ name: 'mapping', pass: true, detail: '2 targets resolved' }],
  status: 'reference',
  reasons: ['one level only'],
  ...patch,
});

describe('recorded runs (R3e-5c)', () => {
  it('records, replaces and removes a study run as edits', () => {
    const { doc } = simulationFixture();
    const a = applySimulationOperation(doc, { type: 'recordRun', run: record(doc) });
    expect(a.runs).toHaveLength(1);
    expect(validateSimulation(a)).toEqual([]);
    // Recording (and renaming) leaves the input hash as it was.
    expect(simulationInputHash(a)).toBe(simulationInputHash(doc));
    expect(simulationInputHash({ ...a, name: 'Other' })).toBe(simulationInputHash(doc));
    expect(simulationInputHash({ ...a, mesh: { ...a.mesh, size: a.mesh.size + 1 } })).not.toBe(
      simulationInputHash(doc),
    );
    // A later record of the study replaces it; the old ID is never reused.
    const b = applySimulationOperation(a, {
      type: 'recordRun',
      run: record(a, { id: 'run-2', reasons: ['two levels only'] }),
    });
    expect(b.runs!.map((r) => r.id)).toEqual(['run-2']);
    expect(b.retiredIds).toContain('run');
    // Removing the study removes its record.
    const c = applySimulationOperation(b, { type: 'removeStudy', id: b.studies[0]!.id });
    expect(c.runs).toBeUndefined();
    expect(validateSimulation(c)).toEqual([]);
    expect(() =>
      applySimulationOperation(doc, { type: 'recordRun', run: record(doc, { studyId: 'nope' }) }),
    ).toThrow();
  });

  it('records a modal run with its frequency and its own checks (TS-1382, ST-199#1)', () => {
    const { doc } = simulationFixture();
    const modal = {
      ...doc.studies[0]!,
      id: 'modal',
      name: 'Modal 1',
      kind: 'modal' as const,
      modes: 4,
      loadIds: [],
      convergence: { levels: 2, metrics: ['first-frequency' as const], tolerance: 0.02 },
    };
    const a = applySimulationOperation(doc, { type: 'addStudy', study: modal });
    const run = record(a, {
      studyId: 'modal',
      levels: [{ size: 10, nodes: 120, elements: 300, metrics: { 'first-frequency': 652.1 } }],
      checks: ['mapping', 'mass', 'quality', 'solver', 'orthogonality'].map((name) => ({
        name: name as SimulationRunRecord['checks'][number]['name'],
        pass: true,
        detail: 'ok',
      })),
    });
    const b = applySimulationOperation(a, { type: 'recordRun', run });
    expect(validateSimulation(b)).toEqual([]);
    // A static metric or check on a modal record is refused.
    const codes = (r: SimulationRunRecord) =>
      validateSimulation({ ...a, runs: [r] }).map((p) => p.code);
    expect(
      codes({ ...run, levels: [{ ...run.levels[0]!, metrics: { 'max-displacement': 1 } }] }),
    ).toContain('missing-key');
    expect(
      codes({ ...run, checks: [...run.checks, { name: 'equilibrium', pass: true, detail: 'x' }] }),
    ).not.toEqual([]);
  });

  it('refuses a record that is malformed, failed, duplicated or names no study', () => {
    const { doc } = simulationFixture();
    const codes = (runs: unknown[]) =>
      validateSimulation({ ...doc, runs } as unknown as SimulationDocument).map((d) => d.code);
    expect(codes([record(doc, { status: 'failed' as never })])).toContain('run');
    expect(codes([record(doc, { status: 'verified' })])).toContain('run');
    // Verified needs every check passed over two levels or more.
    const level = record(doc).levels[0]!;
    const passed = ['mapping', 'load', 'quality', 'solver', 'equilibrium'].map((name) => ({
      name: name as SimulationRunRecord['checks'][number]['name'],
      pass: true,
      detail: '',
    }));
    const verified = { status: 'verified' as const, reasons: [], checks: passed };
    expect(codes([record(doc, { ...verified, levels: [level, level] })])).toEqual([]);
    expect(codes([record(doc, { ...verified, levels: [level] })])).toContain('run');
    expect(
      codes([
        record(doc, {
          ...verified,
          levels: [level, level],
          checks: passed.map((c) => (c.name === 'solver' ? { ...c, pass: false } : c)),
        }),
      ]),
    ).toContain('run');
    expect(codes([record(doc), record(doc, { id: 'run-2' })])).toContain('duplicate-run');
    expect(codes([record(doc, { studyId: 'nope' })])).toContain('reference-missing');
    expect(codes([record(doc, { levels: [] })])).toContain('run');
    expect(codes([])).toContain('runs');
    expect(
      codes([{ ...record(doc), checks: [{ name: 'mystery', pass: true, detail: '' }] }]),
    ).toContain('run');
    // Its ID shares the namespace.
    expect(codes([record(doc, { id: doc.studies[0]!.id })])).toContain('duplicate-id');
  });
});
