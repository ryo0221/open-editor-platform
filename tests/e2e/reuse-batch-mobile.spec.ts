import { test } from './fixtures';
import { componentBatchFlow } from './reuse-batch-fixtures';
test('R07/R16 mobile per-artifact batch results, failed save retry and independent history', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await componentBatchFlow(page, info);
});
