/**
 * R3e-5b: the targets a run could not resolve (docs/cad/r3-analysis.md, 拒否操作1 and 選び直し),
 * listed with their item and reason. Nothing is retargeted by nearness: a target lost or split
 * in the CAD version is picked again on the shown shape (the item's "Use selection"), and one the
 * preparation split or merged is decided by an explicit choice stored for this version,
 * preparation and kernel build (`setOverride`).
 */
import {
  simulationPreparationHash,
  simulationTargets,
  type MappingRow,
  type SimulationDocument,
  type SimulationOperation,
} from '@editor-platform/simulation-core';

export const mappingReasonLabels: Record<NonNullable<MappingRow['reason']>, string> = {
  'cad-missing': 'not on this CAD version: pick the faces again',
  'cad-ambiguous': 'split in this CAD version: pick the faces again',
  'removed-by-preparation': 'removed by the preparation',
  'off-midsurface': 'not on the midsurface (through the wall)',
  'split-by-preparation': 'split by the preparation into several faces',
  'merged-by-preparation': 'merged by the preparation with other faces',
  'not-meshed': 'not in the mesh',
};

/** The item (load, constraint, setting) that owns a row, by name. */
export function mappingOwnerName(doc: SimulationDocument, row: MappingRow) {
  if (row.owner === 'preparation') return 'Preparation';
  if (row.owner === 'mesh') return 'Finer mesh size';
  return [...doc.loads, ...doc.constraints].find((i) => i.id === row.owner)?.name ?? row.owner;
}

/**
 * The re-selection that applies an ambiguous preparation row to all its candidates, for the run's
 * version, preparation and kernel build; undefined when the row is not one a choice decides.
 */
export function overrideAllOp(
  doc: SimulationDocument,
  row: MappingRow,
  kernelBuild: string,
): SimulationOperation | undefined {
  if (row.status !== 'ambiguous' || row.stage !== 'preparation' || !row.analysis.length)
    return undefined;
  const target = simulationTargets(doc).find((t) => t.path === row.path)?.target;
  if (!target) return undefined;
  return {
    type: 'setOverride',
    override: {
      owner: row.owner,
      target,
      versionId: doc.source.versionId,
      preparationHash: simulationPreparationHash(doc.preparation),
      kernelBuild,
      chosen: [...row.analysis],
    },
  };
}

export function MappingIssues({
  doc,
  rows,
  kernelBuild,
  readOnly,
  run,
}: {
  doc: SimulationDocument;
  rows: readonly MappingRow[];
  kernelBuild: string;
  readOnly: boolean;
  run(op: SimulationOperation): string | undefined;
}) {
  const open = rows.filter((r) => r.status !== 'resolved');
  if (!open.length) return null;
  return (
    <ul className="simulation-reasons" aria-label="Targets to resolve">
      {open.map((r) => {
        const op = overrideAllOp(doc, r, kernelBuild);
        return (
          <li key={r.path}>
            <strong>{mappingOwnerName(doc, r)}</strong>: {r.kind} {r.status},{' '}
            {r.reason ? mappingReasonLabels[r.reason] : r.stage}.
            {op && (
              <>
                {' '}
                <button type="button" disabled={readOnly} onClick={() => run(op)}>
                  Apply to all {r.analysis.length} {r.kind}s
                </button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
