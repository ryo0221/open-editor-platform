import { describe, expect, it } from 'vitest';
import {
  applySimulationOperation,
  simulationFixture,
  simulationPreparationHash,
  type MappingRow,
} from '@editor-platform/simulation-core';
import { mappingOwnerName, overrideAllOp } from './mapping-issues';

/** TS-1349 (ST-188#2): an open target is named and, when the preparation split it, decided. */
describe('targets a run could not resolve (R3e-5b)', () => {
  const { doc } = simulationFixture();
  const load = doc.loads[0]!;
  const row = (patch: Partial<MappingRow>): MappingRow => ({
    path: '$.loads[0].targets[0]',
    owner: load.id,
    kind: 'face',
    status: 'ambiguous',
    stage: 'preparation',
    analysis: [3, 4],
    reason: 'split-by-preparation',
    ...patch,
  });

  it('names the item and stores "all candidates" for this version, preparation and build', () => {
    expect(mappingOwnerName(doc, row({}))).toBe(load.name);
    expect(mappingOwnerName(doc, row({ owner: 'mesh' }))).toBe('Finer mesh size');
    const op = overrideAllOp(doc, row({}), 'sha256:kernel')!;
    const next = applySimulationOperation(doc, op);
    expect(next.overrides).toEqual([
      {
        owner: load.id,
        target: (load as { targets: unknown[] }).targets[0],
        versionId: doc.source.versionId,
        preparationHash: simulationPreparationHash(doc.preparation),
        kernelBuild: 'sha256:kernel',
        chosen: [3, 4],
      },
    ]);
  });

  it('offers no choice for a target lost in the CAD version or removed by the preparation', () => {
    expect(
      overrideAllOp(doc, row({ stage: 'cad', reason: 'cad-ambiguous' }), 'sha256:kernel'),
    ).toBe(undefined);
    expect(
      overrideAllOp(
        doc,
        row({ status: 'missing', reason: 'removed-by-preparation', analysis: [] }),
        'sha256:kernel',
      ),
    ).toBe(undefined);
  });
});
