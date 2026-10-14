import { test } from './fixtures';
import { dataReuseFlow } from './reuse-data-fixtures';
test('R11 native Data component mapping, held schema migration, records, relations, chart and Undo survive revision/reload', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await dataReuseFlow(page);
  await page.screenshot({ path: info.outputPath('data-reuse.png'), fullPage: true });
});

test('R11 explicit record mapping recovers a failed text-to-relation migration without discarding records', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await dataReuseFlow(page, true);
  await page.screenshot({ path: info.outputPath('data-relation-migration.png'), fullPage: true });
});
