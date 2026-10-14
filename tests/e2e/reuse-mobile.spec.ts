import { test, expect } from './fixtures';
import { componentFlow } from './reuse-fixtures';
import { authorAndInsert, publishRevision, stageRevision } from './reuse-revision-fixtures';
import { slideComponentFlow, boardComponentFlow } from './reuse-canvas-fixtures';
test('R09 mobile: reusable Document inputs, close/reopen, visibility, reload and Undo', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await componentFlow(page, 'document');
  await page.screenshot({ path: info.outputPath('document-component-mobile.png'), fullPage: true });
});
test('R16 mobile: publish a saved revision, inspect changes and adopt without horizontal overflow', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await authorAndInsert(page);
  await publishRevision(page);
  const inspector = await stageRevision(page);
  await page.screenshot({ path: info.outputPath('component-update-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await inspector.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
});
test('R08/R16 mobile Slide component revision and whole-page layout retain body/notes', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await slideComponentFlow(page);
  await page.screenshot({ path: info.outputPath('slide-reuse-mobile.png'), fullPage: true });
});
test('R10/R16 mobile Whiteboard port migration preserves external connectors and native history', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await boardComponentFlow(page);
  await page.screenshot({ path: info.outputPath('board-reuse-mobile.png'), fullPage: true });
});
import { dataReuseFlow } from './reuse-data-fixtures';
test('R11/R16 mobile Data reuse keeps records while reviewing typed field migration', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await dataReuseFlow(page);
  await page.screenshot({ path: info.outputPath('data-reuse-mobile.png'), fullPage: true });
});
