import { test } from './fixtures';
import { compositionFlow } from './reuse-composition-fixtures';
test('R13/R16 normal composition authoring makes explicit linked/copy members, public inputs and retained slots', async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await compositionFlow(page, info);
});
