import { defineKind } from '@editor-platform/artifact-kinds';
import { createWhiteboard, isWhiteboard, type WhiteboardContent } from './model';

/** The Whiteboard kind (docs/kind-registry-design.md). */
export const whiteboardKind = defineKind<WhiteboardContent>({
  kind: 'whiteboard',
  area: 'office',
  label: 'Whiteboard',
  icon: '◇',
  description: 'Connect ideas on a canvas',
  creatable: true,
  create: (count) => ({ name: `Whiteboard ${count}`, content: createWhiteboard() }),
  validate: isWhiteboard,
});
