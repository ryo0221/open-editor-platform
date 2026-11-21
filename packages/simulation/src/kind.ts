import { defineKind } from '@editor-platform/artifact-kinds';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import {
  emptySimulation,
  isSimulationDocument,
  simulationMaterialPresets,
  type SimulationDocument,
} from '@editor-platform/simulation-core';

/** The saved CAD version and solid body a new analysis analyses (the `create` option). */
export interface SimulationSource {
  artifactId: string;
  versionId: string;
  bodyId: string;
  content: CadDocument;
}

/** A new analysis of the choice, and the CAD version it keeps beside the record (by hash). */
export function newSimulation(
  choice: SimulationSource,
  name: string,
): { doc: SimulationDocument; retained: { contentHash: string; content: CadDocument } } {
  const contentHash = cadContentHash(choice.content);
  const doc = emptySimulation(
    {
      artifactId: choice.artifactId,
      versionId: choice.versionId,
      contentHash,
      bodyId: choice.bodyId,
    },
    name,
  );
  doc.materials.push({ id: 'steel', ...simulationMaterialPresets[0]! });
  doc.materialId = 'steel';
  // CR5e: a sheet starts as a 1 mm shell, its thickness edited in the Bodies list.
  if (choice.content.bodies.find((b) => b.id === choice.bodyId)?.kind === 'sheet') {
    doc.schemaVersion = 2;
    doc.sheets = [{ bodyId: choice.bodyId, thicknessMm: 1 }];
  }
  return { doc, retained: { contentHash, content: structuredClone(choice.content) } };
}

/** The Structural analysis kind. Options: the `SimulationSource` to analyse. */
export const simulationKind = defineKind<SimulationDocument>({
  kind: 'simulation',
  area: 'engineering',
  label: 'Structural analysis',
  icon: 'σ',
  description: 'Load a saved 3D CAD part and solve it for displacement and stress',
  creatable: true,
  create(count, options) {
    if (!options) throw new Error('Choose a saved 3D CAD version to analyse');
    const { doc, retained } = newSimulation(
      options as SimulationSource,
      `Structural analysis ${count}`,
    );
    return { name: doc.name, content: doc, extras: { simulationSources: [retained] } };
  },
  validate: isSimulationDocument,
});
