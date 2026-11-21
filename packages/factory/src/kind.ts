import { defineKind } from '@editor-platform/artifact-kinds';
import { isFactoryDocument, newFactory, type FactoryDocument } from '@editor-platform/factory-core';

/** The Factory kind (docs/kind-registry-design.md). */
export const factoryKind = defineKind<FactoryDocument>({
  kind: 'factory',
  area: 'engineering',
  label: 'Factory',
  icon: '⚙',
  description: 'Model a production line and simulate its material flow: throughput and bottlenecks',
  creatable: true,
  create: (count) => ({ name: `Factory ${count}`, content: newFactory('Factory') }),
  validate: isFactoryDocument,
});
