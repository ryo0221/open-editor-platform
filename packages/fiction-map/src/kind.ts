import { defineKind } from '@editor-platform/artifact-kinds';
import { createFictionMap, validateFictionMap, type FictionMapContent } from './model';

/** The Fiction Map kind (docs/kind-registry-design.md). */
export const fictionMapKind = defineKind<FictionMapContent>({
  kind: 'fiction-map',
  area: 'office',
  label: 'Fiction Map',
  icon: '◇',
  description: 'Edit a bounded fictional plane, independent of Geo',
  creatable: true,
  create: (count) => ({ name: `Fiction Map ${count}`, content: createFictionMap() }),
  validate: (content): content is FictionMapContent => validateFictionMap(content).ok,
});
