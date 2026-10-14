import { test } from './fixtures';
import { brandStyleFlow } from './reuse-style-fixtures';
test('R01/R16 mobile token/style creation, mode inheritance and explicit revision adoption', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await brandStyleFlow(page, info);
});
