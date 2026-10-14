import { test } from './fixtures';
import { compositionFlow } from './reuse-composition-fixtures';
test('R13/R16 mobile composition authoring and ordinary gallery creation preserve linked/copy choices', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await compositionFlow(page, info);
});
