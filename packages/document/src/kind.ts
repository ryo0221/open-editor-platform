import { defineKind } from '@editor-platform/artifact-kinds';
import { createDocument, isDocument, type DocumentContent } from './model';

/** The Document kind (docs/kind-registry-design.md). */
export const documentKind = defineKind<DocumentContent>({
  kind: 'document',
  area: 'office',
  label: 'Document',
  icon: '▤',
  description: 'Write, diagram and explain',
  creatable: true,
  create: (count) => ({ name: `Document ${count}`, content: createDocument() }),
  validate: isDocument,
});
