import { defineKind } from '@editor-platform/artifact-kinds';
import { bimStarter, isBimDocument, type BimDocument } from '@editor-platform/bim-core';

/** The Building kind (docs/kind-registry-design.md). */
export const bimKind = defineKind<BimDocument>({
  kind: 'bim',
  area: 'engineering',
  label: 'Building',
  icon: '⌂',
  description: 'Model a building by levels, elements and types',
  creatable: true,
  create: (count) => ({ name: `Building ${count}`, content: bimStarter() }),
  validate: isBimDocument,
});
