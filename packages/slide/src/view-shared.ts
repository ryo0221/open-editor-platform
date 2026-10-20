import type { ReferenceResolver } from '@editor-platform/artifact-references';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { Slide, SlideContent, SlideObject } from './model';
/** Current Slide editing state and the checked actions shared by the surface panels. */
export interface SlideEditing {
  content: SlideContent;
  slide: Slide | undefined;
  /** Selected object IDs that exist on the current slide. */
  ids: string[];
  readOnly: boolean;
  references?: ReferenceResolver;
  apply(cmd: EditorCommand<SlideContent>): boolean;
  choose(next: string[], pageId?: string): void;
  setError(message: string): void;
}
/** A drawing with its reference projection, for thumbnails and presentation. */
export const projectedReference = (object: SlideObject, references?: ReferenceResolver) =>
  object.reference && references
    ? { ...object, src: references.get(object.reference).projection?.src }
    : object;
