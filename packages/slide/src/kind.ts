import { defineKind } from '@editor-platform/artifact-kinds';
import { createDeck, isDeck, type SlideContent } from './model';

/** The Slide Deck kind (docs/kind-registry-design.md). */
export const slideKind = defineKind<SlideContent>({
  kind: 'slide',
  area: 'office',
  label: 'Slide Deck',
  icon: '▰',
  description: 'Tell a visual story',
  creatable: true,
  create: (count) => ({ name: `Slide Deck ${count}`, content: createDeck() }),
  validate: isDeck,
});
