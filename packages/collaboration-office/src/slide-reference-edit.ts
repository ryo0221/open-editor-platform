import {
  formatLiveValue,
  safeLiveFigure,
  type LiveReference,
} from '@editor-platform/artifact-references';
import type { SlideContent, SlideObject } from '@editor-platform/slide/model';
import { containsSharedReference } from './reference-guard';

/** Shared decks keep whole schema 2 citations inline, so `liveQuote` carries its version. */
export type SlideReferenceObject = Pick<
  SlideObject,
  'id' | 'type' | 'reference' | 'src' | 'text' | 'runs' | 'alt'
> & { liveQuote?: LiveReference };
export interface SlideReferencePolicy {
  authorize(reference: SlideReferenceObject, pageId: string): boolean;
  authorizeDetachment(
    reference: SlideReferenceObject,
    ordinary: SlideReferenceObject,
    pageId: string,
  ): boolean;
}

export const referenceFields = ['reference', 'liveQuote', 'src', 'text', 'runs', 'alt'] as const;
export function slideReferenceFields(item: Record<string, unknown>) {
  return Object.fromEntries(referenceFields.map((field) => [field, item[field] ?? null]));
}

export function validSharedSlideReferences(content: SlideContent, authorize: SlideReferencePolicy) {
  const { slides, ...deck } = content;
  // Only a Slide object's native reference fields can carry a source closure. A shared deck keeps
  // whole citations inline: packed citations and their table (finding 79) stay out of shared edits.
  if (containsSharedReference(deck) || deck.liveSnapshots !== undefined) return false;
  return slides.every(
    ({ objects, ...page }) =>
      !containsSharedReference(page) &&
      objects.every((object) => {
        const { reference, liveQuote, ...ordinary } = object;
        if (containsSharedReference(ordinary)) return false;
        if (
          reference &&
          [
            reference.snapshot.content,
            ...reference.snapshot.dependencies.map((dependency) => dependency.content),
          ].some((content) => containsSharedReference(content))
        )
          return false;
        if (liveQuote) {
          if (liveQuote.schemaVersion !== 2) return false;
          if (ordinary.runs?.length) return false;
          const expected =
            liveQuote.presentation.kind === 'value' ? formatLiveValue(liveQuote.presentation) : '';
          if (ordinary.text !== expected) return false;
        }
        return (
          !(reference || liveQuote) || authorize.authorize(object as SlideReferenceObject, page.id)
        );
      }),
  );
}

export function validDetachedSlideValue(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const reference = before.liveQuote as SlideObject['liveQuote'];
  if (reference?.presentation.kind === 'value')
    return after.text === before.text && !after.src && !after.runs;
  // The Host must independently verify the resulting projection before accepting the operation.
  return (
    safeLiveFigure(after.src) ||
    (!!before.reference && before.src === after.src && typeof after.src === 'string')
  );
}
