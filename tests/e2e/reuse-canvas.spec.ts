import { test } from './fixtures';
import { slideComponentFlow, boardComponentFlow } from './reuse-canvas-fixtures';
test('R08 Slide in-page and whole-page reuse preserve native notes, body, placement and history through revision', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await slideComponentFlow(page);
  await page.screenshot({ path: info.outputPath('slide-reuse.png'), fullPage: true });
});
test('R10 Whiteboard native ports, external connector migration, hold and selective revision history', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await boardComponentFlow(page);
  await page.screenshot({ path: info.outputPath('board-ports-reuse.png'), fullPage: true });
});
