import { defineKind } from '@editor-platform/artifact-kinds';
import { createMindmap, isMindmap, type MindmapContent } from '@editor-platform/mindmap-core';

/** The Mind Map kind (docs/kind-registry-design.md). */
export const mindmapKind = defineKind<MindmapContent>({
  kind: 'mindmap',
  area: 'office',
  label: 'Mind Map',
  icon: '✳',
  description: 'Grow ideas from one central topic',
  creatable: true,
  create: (count) => ({ name: `Mind Map ${count}`, content: createMindmap() }),
  validate: isMindmap,
});
