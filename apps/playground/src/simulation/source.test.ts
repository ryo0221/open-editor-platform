import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import {
  applyCadOperation,
  cadContentHash,
  f01Empty,
  f02Plate,
  f17Sheets,
  isCadDocument,
  r2bParts,
  type CadDocument,
} from '@editor-platform/cad-core';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { readImportFiles } from '../app/import-artifact';
import { makeArtifact, type StoredArtifact } from '../model';
import { validateSimulation, type SimulationDocument } from '@editor-platform/simulation-core';
import {
  mergeSimulationSources,
  newSimulation,
  portableSimulationRecord,
  simulationSourceChoices,
  simulationSourceOf,
  simulationVersionChoices,
  stageSimulationSource,
  validateSimulationSources,
} from './source';

const stored = async (kind: string, name: string, content: unknown, versions = 1) => {
  let a = createArtifact(kind, name, content);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
const context = () => ({
  exists: () => false,
  references: new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async () => {
        throw new Error('No live reads during import');
      },
    },
    nativeReferenceAdapters,
  ),
});
/** A part with a solid imported from STEP (its BRep bytes are an asset). */
const imported = (): CadDocument => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  return applyCadOperation(f01Empty(), {
    type: 'insertImportedBody',
    assets: [
      {
        id: 'a-step',
        kind: 'source-step',
        sha256: sha('a'),
        byteLength: 9,
        mediaType: 'model/step',
      },
      {
        id: 'a-brep',
        kind: 'normalized-brep',
        sha256: sha('b'),
        byteLength: 9,
        mediaType: 'model/x-occt-brep',
      },
    ],
    feature: {
      id: 'imp',
      name: 'bracket.step',
      type: 'imported',
      inputFeatureIds: [],
      args: {
        kind: 'solid',
        sourceAssetId: 'a-step',
        brepAssetId: 'a-brep',
        importer: { id: 'occt-dev', buildHash: sha('c') },
        sourceUnit: 'mm',
        scaleToMm: 1,
      },
    },
    body: {
      id: 'body',
      name: 'bracket',
      sourceFeatureId: 'imp',
      placementFeatureId: 'imp-placement',
      appearance: { color: '#8899aa', opacity: 1 },
    },
  });
};
const file = (r: StoredArtifact) =>
  new File([serializeArtifact(r)], 'analysis.artifact.json', { type: 'application/json' });

describe('structural analysis sources (R3e-4a)', () => {
  it('offers saved versions of CAD parts, newest first, sheets marked, and no drafts or assemblies', async () => {
    const plate = await stored('cad', 'Plate', f02Plate(), 2);
    const sheet = await stored('cad', 'Sheet', f17Sheets('extrude'));
    const rig = await stored('cad', 'Rig', r2bParts().assembly);
    const draftOnly = await stored('cad', 'Draft', f02Plate(), 0);
    const bracket = await stored('cad', 'Bracket', imported());
    expect(isCadDocument(bracket.versions[0]!.content)).toBe(true);
    const choices = simulationSourceChoices([plate, sheet, rig, draftOnly, bracket]);
    // CR5e (TS-1573): a sheet is offered, as a shell of the analysis's thickness (1 mm to start).
    expect(choices.map((c) => c.label)).toEqual([
      'Plate · v2 · plate',
      'Plate · v1 · plate',
      expect.stringMatching(/^Sheet · v1 · .* \(sheet\)$/),
    ]);
    const sheetDoc = newSimulation(choices[2]!, 'Sheet analysis').doc;
    expect(sheetDoc.sheets).toEqual([{ bodyId: choices[2]!.bodyId, thicknessMm: 1 }]);
    expect(validateSimulation(sheetDoc)).toEqual([]);
    expect(newSimulation(choices[0]!, 'Plate analysis').doc.sheets).toBeUndefined();
    expect(choices[0]).toMatchObject({
      artifactId: plate.id,
      versionId: plate.versions[1]!.versionId,
      bodyId: 'plate',
    });
  });

  it('creates steel on the chosen body and keeps the analysed version by its hash', async () => {
    const plate = await stored('cad', 'Plate', f02Plate());
    const [choice] = simulationSourceChoices([plate]);
    const record = makeArtifact('simulation', 1, undefined, choice);
    const doc = record.draft.content as ReturnType<typeof newSimulation>['doc'];
    expect(doc.source).toEqual({
      artifactId: plate.id,
      versionId: plate.versions[0]!.versionId,
      contentHash: cadContentHash(f02Plate()),
      bodyId: 'plate',
    });
    expect(doc.materialId).toBe('steel');
    expect(record.simulationSources).toEqual([
      { contentHash: doc.source.contentHash, content: f02Plate() },
    ]);
    expect(simulationSourceOf(record, doc)).toEqual(f02Plate());
    expect(() => validateSimulationSources(record)).not.toThrow();
    expect(() => makeArtifact('simulation', 1)).toThrow('Choose a saved 3D CAD version');
  });

  it('refuses a record whose kept versions are missing, altered, duplicated or unused', async () => {
    const plate = await stored('cad', 'Plate', f02Plate());
    const record = makeArtifact('simulation', 1, undefined, simulationSourceChoices([plate])[0]);
    const kept = record.simulationSources![0]!;
    expect(() => validateSimulationSources({ ...record, simulationSources: [] })).toThrow(
      'Simulation source missing',
    );
    const altered = structuredClone(kept);
    altered.content.bodies[0]!.name = 'Renamed';
    expect(() => validateSimulationSources({ ...record, simulationSources: [altered] })).toThrow(
      'hash mismatch',
    );
    expect(() => validateSimulationSources({ ...record, simulationSources: [kept, kept] })).toThrow(
      'duplicated',
    );
    const other = { contentHash: cadContentHash(f02Plate('edge')), content: f02Plate('edge') };
    expect(() =>
      validateSimulationSources({ ...record, simulationSources: [kept, other] }),
    ).toThrow('not referenced');
    // Imported geometry would need its asset bytes, which are not kept with the analysis.
    const importedRecord = makeArtifact('simulation', 1, undefined, {
      artifactId: 'cad-bracket',
      label: 'Bracket · v1 · bracket',
      versionId: 'v1',
      bodyId: 'body',
      content: imported(),
    });
    expect(() => validateSimulationSources(importedRecord)).toThrow('Simulation source assets');
  });

  it('travels in the native file and opens after the CAD Artifact is gone', async () => {
    const plate = await stored('cad', 'Plate', f02Plate());
    const record = makeArtifact('simulation', 1, undefined, simulationSourceChoices([plate])[0]);
    const [back] = await readImportFiles([file(record)], context());
    expect(back!.kind).toBe('simulation');
    expect(back!.simulationSources).toEqual(record.simulationSources);
    const none = structuredClone(record);
    delete none.simulationSources;
    await expect(readImportFiles([file(none)], context())).rejects.toThrow(
      'Simulation source missing',
    );
  });
});

/** TS-1348 (ST-188#1): switching the analysed CAD version keeps the new version with the record. */
describe('switching the analysed CAD version (R3e-5b)', () => {
  const twoVersions = async () => {
    let a = createArtifact('cad', 'Plate', f02Plate());
    a = await commitVersion(a, null, 'v1');
    a = { ...a, draft: { ...a.draft, content: f02Plate('edge') } };
    a = await commitVersion(a, null, 'v2');
    return { ...a, annotations: [] } as unknown as StoredArtifact;
  };
  it('offers the other versions with the same body and keeps the chosen one before the edit', async () => {
    const plate = await twoVersions();
    const [v2, v1] = simulationSourceChoices([plate]);
    const record = makeArtifact('simulation', 1, undefined, v1);
    const doc = record.draft.content as SimulationDocument;
    expect(simulationVersionChoices([plate], doc).map((c) => c.versionId)).toEqual([v2!.versionId]);
    // Another body id is not offered.
    expect(
      simulationVersionChoices([plate], { ...doc, source: { ...doc.source, bodyId: 'other' } }),
    ).toEqual([]);
    const staged = stageSimulationSource(record, v2!.content);
    expect(staged.simulationSources!.map((p) => p.contentHash)).toEqual([
      cadContentHash(f02Plate()),
      cadContentHash(f02Plate('edge')),
    ]);
    // Staged twice: kept once.
    expect(stageSimulationSource(staged, v2!.content)).toBe(staged);
    // Before the switch the stored record may keep it; an import may not.
    expect(() => validateSimulationSources(staged, { stored: true })).not.toThrow();
    expect(() => validateSimulationSources(staged)).toThrow('not referenced');
    // After the switch (and after Undo back to v1), the export keeps only what is analysed.
    const switched = {
      ...staged,
      draft: {
        ...staged.draft,
        content: {
          ...doc,
          source: {
            ...doc.source,
            versionId: v2!.versionId,
            contentHash: cadContentHash(v2!.content),
          },
        },
      },
    };
    expect(() => validateSimulationSources(switched, { stored: true })).not.toThrow();
    expect(portableSimulationRecord(switched).simulationSources!.map((p) => p.contentHash)).toEqual(
      [cadContentHash(f02Plate('edge'))],
    );
    expect(() => validateSimulationSources(portableSimulationRecord(switched))).not.toThrow();
    expect(portableSimulationRecord(staged).simulationSources).toHaveLength(1);
  });

  /** TS-1358 (ST-188#5): a version saved while a switch staged v2 keeps v2 with the record. */
  it('keeps a source staged during a version save', async () => {
    const plate = await twoVersions();
    const [v2, v1] = simulationSourceChoices([plate]);
    const saved = makeArtifact('simulation', 1, undefined, v1);
    const latest = stageSimulationSource(saved, v2!.content);
    const merged = mergeSimulationSources(saved, latest).simulationSources!;
    expect(merged.map((p) => p.contentHash).sort()).toEqual(
      [cadContentHash(f02Plate()), cadContentHash(f02Plate('edge'))].sort(),
    );
    // Neither side drops what the other holds.
    expect(mergeSimulationSources(latest, saved).simulationSources).toHaveLength(2);
    expect(mergeSimulationSources({}, {})).toEqual({});
  });
});
