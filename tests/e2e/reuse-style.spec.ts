import { test } from './fixtures';
import { brandStyleFlow } from './reuse-style-fixtures';
for (const domain of ['document', 'design', 'slide'] as const)
  test(`R01/R05 normal ${domain} token/style authoring, exact revision adoption and inherited mode`, async ({
    page,
  }, info) => {
    test.setTimeout(180000);
    await brandStyleFlow(page, info, domain);
  });
