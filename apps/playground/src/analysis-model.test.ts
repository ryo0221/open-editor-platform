import { expect, it } from 'vitest';
import { createAnalysis } from '@editor-platform/analysis-core';
import { validContent, anchorState } from './model';
it('keeps an empty Analysis native model out of Document import and dispatch', () => {
  const content = createAnalysis();
  expect(validContent('analysis', content)).toBe(true);
  expect(validContent('document', content)).toBe(false);
  expect(anchorState(content, { artifactId: 'analysis', elementId: 'missing' })).toBe('Orphan');
});
