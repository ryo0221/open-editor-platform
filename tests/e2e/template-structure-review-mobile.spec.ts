import { test } from './fixtures';
import {
  deletedStructureImport,
  designComponentAdoption,
} from './template-structure-review-fixtures';
for (const historical of [false, true])
  test(`#28 mobile ordinary Delete native round trip${historical ? ' including saved version and detached draft' : ' with repairable management'}`, async ({
    page,
  }, info) => {
    await deletedStructureImport(page, historical, info);
  });
test('#28 mobile Design source component adoption preserves old colors and uses v2 for new cards', async ({
  page,
}, info) => {
  await designComponentAdoption(page, info);
});
