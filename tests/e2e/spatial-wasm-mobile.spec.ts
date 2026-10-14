import { test } from './fixtures';
import { checkSpatialSurfaces } from './spatial-wasm-fixtures';
for (const backend of ['typescript', 'wasm', 'broken', 'unavailable'])
  test(`mobile spatial ${backend}: Design and Whiteboard select the same native IDs`, async ({
    page,
  }, info) => {
    await checkSpatialSurfaces(page, backend);
    await page.screenshot({ path: info.outputPath(`spatial-${backend}-mobile.png`) });
  });
