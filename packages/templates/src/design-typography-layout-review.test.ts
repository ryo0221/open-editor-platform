import { expect, it } from 'vitest';
import { designDrawings, isDesign, type DesignContent } from '@editor-platform/design/model';
import { layoutDrawingText } from '@editor-platform/editor-core';
import {
  expandTemplate,
  layoutDiagnostics,
  saveAsTemplate,
  measureTemplateTextFit,
} from '@editor-platform/templates';
import { textLayoutReviewContent } from '../../../tests/fixtures/design-reuse/content';

async function definition(content: DesignContent, policy: 'expand' | 'error' = 'expand') {
  return saveAsTemplate({
    domain: 'design',
    content,
    kind: 'whole',
    name: 'Text layout',
    purpose: 'Review regression',
    category: 'test',
    slots: [],
    overflow: { policy, minFontSize: 10 },
  });
}

it('public preflight accounts for rich line height while preserving default and empty estimates', () => {
  const input = { text: '確認', bounds: { width: 100, height: 26 }, fontSize: 12, minFontSize: 10 };
  expect(measureTemplateTextFit(input).fits).toBe(true);
  expect(measureTemplateTextFit({ ...input, typography: { lineHeight: 3 } })).toMatchObject({
    requiredHeight: 44,
    fits: false,
  });
  expect(
    measureTemplateTextFit({ ...input, runs: [{ text: '確認', style: { lineHeight: 3 } }] }).fits,
  ).toBe(false);
  expect(
    measureTemplateTextFit({ ...input, text: '', typography: { lineHeight: 3 } }),
  ).toMatchObject({ requiredHeight: 8, fits: true });
});

it.each(['base', 'run', 'padding', 'fit'] as const)(
  'expands effective %s typography using the rendered line area',
  async (mode) => {
    const source = textLayoutReviewContent(mode);
    const before = JSON.stringify(source);
    const def = await definition(source);
    const sealed = JSON.stringify(def);
    const expanded = expandTemplate(def, {}, { remap: false }).content as DesignContent;
    const drawing = designDrawings(expanded, expanded.elements[0]).find((d) => d.kind === 'text')!;
    const layout = layoutDrawingText(drawing);
    expect(drawing.bounds.height).toBeGreaterThanOrEqual(layout.totalHeight + 2 * layout.padding);
    expect(layout.fontSize).toBe(12);
    expect(layout.totalHeight).toBeCloseTo(mode === 'padding' ? 15.6 : 36);
    expect(layoutDiagnostics(def, expanded)).toEqual([]);
    expect(expanded.components).toEqual(source.components);
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(def)).toBe(sealed);
  },
);

it.each(['base', 'run', 'padding'] as const)(
  'rejects insufficient rendered %s text height under error policy',
  async (mode) => {
    const source = textLayoutReviewContent(mode);
    await expect(definition(source, 'error')).rejects.toThrow(/does not fit/);
  },
);

it.each([false, true])('reprojects fill siblings after expansion, nested=%s', async (nested) => {
  const source = textLayoutReviewContent('siblings', nested);
  const def = await definition(source);
  const expanded = expandTemplate(def, {}, { remap: false }).content as DesignContent;
  const drawings = designDrawings(expanded, expanded.elements[0]).filter((d) => d.kind === 'text');
  expect(drawings).toHaveLength(2);
  for (const drawing of drawings) {
    const layout = layoutDrawingText(drawing);
    expect(drawing.bounds.height).toBeGreaterThanOrEqual(layout.totalHeight + 2 * layout.padding);
  }
  expect(layoutDiagnostics(def, expanded)).toEqual([]);
  expect(expanded.components).toEqual(source.components);
  expect(isDesign(JSON.parse(JSON.stringify(expanded)))).toBe(true);
});
