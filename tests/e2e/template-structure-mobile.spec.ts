import { test } from './fixtures';
import { structureFlow } from './template-structure-fixtures';
for (const domain of ['slide', 'whiteboard', 'design', 'document', 'data'] as const)
  test(`#27 mobile ${domain}: native direct editing and variable composition`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    await structureFlow(page, domain, false, info);
  });
for (const domain of ['review', 'file'] as const)
  test(`#27 mobile ${domain}: private settings preserve original and annotations`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    const { settingFlow } = await import('./template-structure-fixtures');
    await settingFlow(page, domain, info);
  });
test('#27 mobile source publication and linked adoption retain placed text', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { sourceFlow } = await import('./template-structure-fixtures');
  await sourceFlow(page, info);
});
