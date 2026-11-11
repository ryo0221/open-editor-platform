import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  simulationFixture,
  studyStatus,
  validateSimulation,
} from '@editor-platform/simulation-core';
import type { StudyRun } from './run';
import { recordedStatus, recordRunOp, runRecordCurrent } from './run-record';

/** TS-1352 (ST-189#2): a run with a result becomes a record that goes out of date with an edit. */
describe('recording a run (R3e-5c)', () => {
  const { doc } = simulationFixture();
  const run = (status: 'verified' | 'reference' | 'failed'): StudyRun => ({
    studyId: doc.studies[0]!.id,
    status:
      status === 'failed'
        ? studyStatus({ study: doc.studies[0]!, failure: 'mapping', checks: [], levels: [] })
        : { status, reasons: status === 'verified' ? [] : ['one level only'], changes: {} },
    levels:
      status === 'failed'
        ? []
        : [
            {
              settings: { ...doc.mesh, size: 10 },
              nodes: 100,
              elements: 250,
              metrics: { 'max-displacement': 0.2, 'max-von-mises': 30, 'reaction-force': 100 },
              checks: [{ name: 'solver', pass: true, detail: 'x'.repeat(5000) }],
            },
          ],
    mapping: [],
    builds: { kernel: 'sha256:k', mesher: 'sha256:m', solver: 'sha256:s' },
  });

  it('records the levels, the finest checks and the status, and goes out of date with an edit', () => {
    const made = recordRunOp(doc, run('reference'));
    if (!('op' in made)) throw new Error(made.reason);
    const next = applySimulationOperation(doc, made.op);
    expect(validateSimulation(next)).toEqual([]);
    const r = next.runs![0]!;
    expect(r).toMatchObject({
      studyId: doc.studies[0]!.id,
      status: 'reference',
      reasons: ['one level only'],
      levels: [{ size: 10, nodes: 100, elements: 250 }],
      inputs: { cadContentHash: doc.source.contentHash, mesherBuild: 'sha256:m' },
    });
    // A long detail is clipped to the record's limit.
    expect([...r.checks[0]!.detail].length).toBeLessThanOrEqual(2048);
    const builds = { kernel: 'sha256:k', mesher: 'sha256:m', solver: 'sha256:s' };
    expect(runRecordCurrent(next, r, builds)).toBe(true);
    // Another mesher build, or none known, is not the recorded run.
    expect(runRecordCurrent(next, r, { ...builds, mesher: 'sha256:other' })).toBe(false);
    expect(runRecordCurrent(next, r, undefined)).toBe(false);
    const edited = applySimulationOperation(next, {
      type: 'setMeshSettings',
      mesh: { ...next.mesh, size: next.mesh.size + 1 },
    });
    expect(runRecordCurrent(edited, r, builds)).toBe(false);
    // A record that claims verified without the checks for it shows as reference.
    expect(recordedStatus(next, { ...r, status: 'verified', reasons: [] })).toBe('reference');
    expect(recordedStatus(next, r)).toBe('reference');
    expect(recordRunOp(doc, run('failed'))).toEqual({ reason: 'A failed run has no result.' });
  });
});
