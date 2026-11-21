import { defineKind } from '@editor-platform/artifact-kinds';
import { createDesign, isDesignWithPaths, type DesignContent } from './model';

/** The Design kind (docs/kind-registry-design.md). */
export const designKind = defineKind<DesignContent>({
  kind: 'design',
  area: 'office',
  label: 'Design',
  icon: '▱',
  description: 'Compose frames and components',
  creatable: true,
  create: (count) => ({ name: `Design ${count}`, content: createDesign() }),
  validate: isDesignWithPaths,
});
