import { test } from './fixtures';
import { viewStyleFlow } from './reuse-view-style-fixtures';
test('R12/R16 mobile annotation token style draft and fixed-color revision', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await viewStyleFlow(page, info, 'review');
});
