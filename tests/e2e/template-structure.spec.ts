import { test } from './fixtures';
import { structureFlow } from './template-structure-fixtures';
for (const domain of ['slide', 'whiteboard', 'design', 'document', 'data'] as const)
  for (const steps of [false, true])
    test(`#27 ${domain}: ${steps ? '3→4 steps' : '2→3 comparison'} directly edits, reorders/deletes, Undo, saves, reloads and exports`, async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      await structureFlow(page, domain, steps, info);
    });
for (const domain of ['review', 'file'] as const)
  test(`#27 ${domain}: gallery applies private settings while original and existing annotations survive reload`, async ({
    page,
  }, info) => {
    test.setTimeout(120000);
    const { settingFlow } = await import('./template-structure-fixtures');
    await settingFlow(page, domain, info);
  });
test('#27 immutable source publication, explicit linked adoption and source-independent native editing', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const { sourceFlow } = await import('./template-structure-fixtures');
  await sourceFlow(page, info);
});
