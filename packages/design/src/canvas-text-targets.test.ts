import { expect, it } from 'vitest';
import { deepFreeze } from '@editor-platform/artifact-core';
import { designDrawingProjector, overrideInstance, type DesignContent } from './model';
import { collectScopedTexts, designCanvasTargets } from './view-panels';
import { nestedTextFixture } from '../../../tests/fixtures/design-nested-text/content';

it('keeps nested text targets in paint order and isolated across instances and edits', () => {
  const content = deepFreeze(nestedTextFixture());
  const targets = (d: DesignContent) => {
    const project = designDrawingProjector(d);
    return designCanvasTargets(d, project, new Map(), collectScopedTexts(d, project), undefined);
  };
  const before = targets(content);
  expect(before.map((t) => t.id)).toEqual(['card', 'other']);
  for (const target of before) {
    expect(target.textParts?.map((p) => p.text)).toEqual(['Nested title', 'Retained body']);
    expect(target.textParts?.every((p) => p.drawingId?.includes(`"${target.id}"`))).toBe(true);
  }
  const edited = overrideInstance('card', ['section', 'title'], { text: 'Changed title' }).apply(
    content,
  );
  const after = targets(edited);
  expect(after[0].textParts?.map((p) => p.text)).toEqual(['Changed title', 'Retained body']);
  expect(after[1].textParts).toEqual(before[1].textParts);
  expect(before[0].textParts?.[0].text).toBe('Nested title');
});
