import { defineKind } from '@editor-platform/artifact-kinds';
import {
  isSchematicDocument,
  schematicStarter,
  type SchematicDocument,
} from '@editor-platform/schematic-core';

/** The Schematic kind (docs/kind-registry-design.md). */
export const schematicKind = defineKind<SchematicDocument>({
  kind: 'schematic',
  area: 'engineering',
  label: 'Schematic',
  icon: '⏚',
  description: 'Draw a circuit: symbols, wires, net labels and power ports',
  creatable: true,
  create: (count) => ({ name: `Schematic ${count}`, content: schematicStarter() }),
  validate: isSchematicDocument,
});
