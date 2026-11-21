// How the Playground stores, opens and imports engineering records (kinds/record-kind.ts), in
// the order of kinds/engineering.ts. No React. Each native file carries the closure of the
// versions and assets its content names; a missing or altered one refuses the file.
import type { CosimDocument } from '@editor-platform/cosim-core';
import { bimKind } from '@editor-platform/bim/kind';
import { characterKind } from '@editor-platform/character/kind';
import { constructionKind } from '@editor-platform/construction/kind';
import { cosimKind } from '@editor-platform/cosim/kind';
import { drawingKind } from '@editor-platform/drawing/kind';
import { factoryKind } from '@editor-platform/factory/kind';
import { ladderKind } from '@editor-platform/ladder/kind';
import { pcbKind } from '@editor-platform/pcb/kind';
import { schematicKind } from '@editor-platform/schematic/kind';
import { simulationKind } from '@editor-platform/simulation/kind';
import { validateBimParts } from '../../bim/parts';
import { validateCadRecord } from '../../cad/resources';
import { validateCharacterParts } from '../../character/parts';
import { validateConstructionSources } from '../../construction/source';
import { validateDrawingSources } from '../../drawing/sources';
import { validateFactoryLooks } from '../../factory/looks';
import { validateFactorySources } from '../../factory/source';
import { validateSimulationSources } from '../../simulation/source';
import { cadDefinition } from '../engineering';
import { recordKind, type RecordKindHooks } from '../record-kind';

// Engineering versions are hash-checked when opened and have no reusable-definition adapter.
const engineering = { storedVersionHashes: true, reusableAdapter: () => false } as const;
const kept = <C>(hooks: RecordKindHooks<C>): RecordKindHooks<C> => ({ ...engineering, ...hooks });

export const engineeringRecords = [
  recordKind(
    cadDefinition,
    kept({
      importExtras(record, file) {
        // The asset closure travels in the same file.
        if (file.cadResources !== undefined) record.cadResources = file.cadResources;
        // The part closure too (R2b).
        if (file.cadParts !== undefined) record.cadParts = file.cadParts;
        return validateCadRecord(record);
      },
    }),
  ),
  recordKind(
    bimKind,
    kept({
      importExtras(record, file) {
        // The CAD versions the building places (its retained closure).
        if (file.cadParts !== undefined) record.cadParts = file.cadParts;
        validateBimParts(record);
        // Its materials' texture images (#662), checked as CAD assets are.
        if (file.cadResources !== undefined) record.cadResources = file.cadResources;
        return validateCadRecord(record);
      },
    }),
  ),
  recordKind(
    characterKind,
    kept({
      importExtras(record, file) {
        // Its mesh and texture assets.
        if (file.cadResources !== undefined) record.cadResources = file.cadResources;
        // The CAD versions its props place (C2b).
        if (file.cadParts !== undefined) record.cadParts = file.cadParts;
        // And the buildings (C8p), with the CAD versions they place in `cadParts`.
        if (file.bimParts !== undefined) record.bimParts = file.bimParts;
        validateCharacterParts(record);
        return validateCadRecord(record);
      },
    }),
  ),
  recordKind(
    simulationKind,
    kept({
      verifyStored: (record) => validateSimulationSources(record, { stored: true }),
      importExtras(record, file) {
        // The analysed CAD versions.
        if (file.simulationSources !== undefined) record.simulationSources = file.simulationSources;
        validateSimulationSources(record);
      },
    }),
  ),
  recordKind(
    constructionKind,
    kept({
      verifyStored: (record) => validateConstructionSources(record, { stored: true }),
      importExtras(record, file) {
        // The scheduled BIM versions.
        if (file.constructionSources !== undefined)
          record.constructionSources = file.constructionSources;
        validateConstructionSources(record);
      },
    }),
  ),
  recordKind(pcbKind, kept({})),
  recordKind(schematicKind, kept({})),
  recordKind(ladderKind, kept({})),
  recordKind(
    cosimKind,
    kept({
      // A co-simulation names its schematic and ladder versions by artifact (SL8c).
      relink(content: CosimDocument, ids) {
        for (const key of ['schematic', 'ladder'] as const) {
          const ref = content[key];
          const id = ref && ids.get(ref.artifactId);
          if (ref && id) content[key] = { ...ref, artifactId: id };
        }
      },
    }),
  ),
  recordKind(
    drawingKind,
    kept({
      verifyStored: (record) => validateDrawingSources(record, { stored: true }),
      importExtras(record, file) {
        // The CAD and building versions the views see (DW1).
        if (file.drawingSources !== undefined) record.drawingSources = file.drawingSources;
        if (file.drawingAssets !== undefined) record.drawingAssets = file.drawingAssets;
        // DW6b: its issues and their PDFs, each naming one of its versions.
        if (file.drawingIssues !== undefined) record.drawingIssues = file.drawingIssues;
        validateDrawingSources(record);
      },
    }),
  ),
  recordKind(
    factoryKind,
    kept({
      verifyStored(record) {
        validateFactorySources(record, { stored: true });
        validateFactoryLooks(record, { stored: true });
      },
      importExtras(record, file) {
        // FT4a: the Building versions it stands in.
        if (file.factorySources !== undefined) record.factorySources = file.factorySources;
        validateFactorySources(record);
        // FT4c: and the CAD versions that give its objects their look.
        if (file.factoryLooks !== undefined) record.factoryLooks = file.factoryLooks;
        validateFactoryLooks(record);
      },
    }),
  ),
];
