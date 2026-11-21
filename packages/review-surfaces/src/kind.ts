import { defineKind } from '@editor-platform/artifact-kinds';
import {
  createFile,
  createReview,
  isFile,
  isReview,
  type FileContent,
  type ReviewContent,
} from './model';

/** The Code Review kind (docs/kind-registry-design.md). */
export const reviewKind = defineKind<ReviewContent>({
  kind: 'review',
  area: 'office',
  label: 'Code Review',
  icon: '±',
  description: 'Compare text and annotate',
  creatable: true,
  create: (count) => ({ name: `Code Review ${count}`, content: createReview() }),
  validate: isReview,
});

/** The File Viewer kind (docs/kind-registry-design.md). */
export const fileKind = defineKind<FileContent>({
  kind: 'file',
  area: 'office',
  label: 'File Viewer',
  icon: '▧',
  description: 'Inspect images, text and PDFs',
  creatable: true,
  create: (count) => ({ name: `File Viewer ${count}`, content: createFile() }),
  validate: isFile,
});
