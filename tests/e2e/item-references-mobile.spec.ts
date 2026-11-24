/**
 * AR3（docs/analysis-references-design.md §4）：携帯の幅でも、FMEA の故障原因から特性要因図の原因の候補を選んで引用し、
 * 外し、キーの Undo で戻せ、横にはみ出さない。
 */
import { test, expect, nativeArtifact } from './fixtures';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { citedFmea } from './item-references-fixtures';

test('AR3 携帯の幅で引用を選び、外し、Undo で戻せる', async ({ page }, info) => {
  await page.goto('/');
  const refs = await citedFmea(page);
  const rowRefs = async () =>
    ((await nativeArtifact(page)).draft.content as StructuredData).rows[0]!.refs;
  expect(await rowRefs()).toEqual({ causeCandidates: ['CC-01'] });
  await refs.getByRole('button', { name: 'CC-01 を外す', exact: true }).click();
  expect(await rowRefs()).toBeUndefined();
  // 狭い幅の Data は Undo をキーで受ける（keyboard-history-mobile と同じ）
  await refs.getByRole('button', { name: '候補から選ぶ', exact: true }).press('Control+z');
  expect(await rowRefs()).toEqual({ causeCandidates: ['CC-01'] });
  await expect(refs.getByRole('button', { name: 'CC-01 を開く', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('item-references-mobile.png') });
});
