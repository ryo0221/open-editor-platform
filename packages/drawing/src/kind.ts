import { defineKind } from '@editor-platform/artifact-kinds';
import {
  drawingStarter,
  isDrawingDocument,
  type DrawingDocument,
} from '@editor-platform/drawing-core';

/** The Drawing kind (docs/kind-registry-design.md). */
export const drawingKind = defineKind<DrawingDocument>({
  kind: 'drawing',
  area: 'engineering',
  label: 'Drawing',
  icon: '⌗',
  description: 'Make construction and shop drawings from saved CAD and building versions',
  creatable: true,
  create: (count) => ({ name: `Drawing ${count}`, content: drawingStarter() }),
  validate: isDrawingDocument,
});
