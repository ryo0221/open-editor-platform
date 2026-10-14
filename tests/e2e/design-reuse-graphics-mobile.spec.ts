import { assertPost258, assertForeignVectorUpdate } from './post-258-fixtures';
import { test, expect } from './fixtures';
import {
  independentDesignReuse,
  assertButtonPng,
  assertVectorViewport,
  assertVectorOccurrences,
  assertInputDiagnostics,
  assertExpandedTextLayout,
} from './design-reuse-graphics-fixtures';
test('mobile public Host renders expanded typography and fill labels after native reload', async ({
  page,
}, info) => {
  await assertExpandedTextLayout(page);
  await page.screenshot({ path: info.outputPath('mobile-expanded-text-layout.png') });
});
test('mobile public input form highlights the clipped component field without applying content', async ({
  page,
}, info) => {
  await assertInputDiagnostics(page);
  await page.screenshot({ path: info.outputPath('mobile-component-input-diagnostics.png') });
});
test('mobile public Host keeps colliding native and component vector IDs separate', async ({
  page,
}, info) => {
  await assertVectorOccurrences(page);
  await page.screenshot({ path: info.outputPath('mobile-unique-vector-occurrences.png') });
});
test('mobile public Host keeps oversized vector paint inside the rotated view box', async ({
  page,
}, info) => {
  await assertVectorViewport(page, true);
  await page.screenshot({ path: info.outputPath('mobile-clipped-vector.png') });
});
test('mobile public Host renders small text/icons, switches mode, exports PNG and undoes', async ({
  page,
}, info) => {
  await independentDesignReuse(page);
  await expect(page.getByRole('img', { name: 'Exported button', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Host dark mode', exact: true }).tap();
  await expect(page.getByTestId('reuse-native')).toContainText('"artifactMode":"dark"');
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#ff9933');
  await assertButtonPng(page, [255, 153, 51]);
  await page.screenshot({ path: info.outputPath('mobile-dark-vector.png') });
  await page.getByRole('button', { name: 'Host undo', exact: true }).tap();
  await expect(page.locator('svg path[d="M20 6 9 17l-5-5"]')).toHaveAttribute('stroke', '#336699');
});

test('post-258 adopted vector and effective small run survive SVG export and native reload', async ({
  page,
}, info) => {
  await assertPost258(page);
  await page.screenshot({ path: info.outputPath('post-258.png') });
});

for (const domain of ['slide', 'whiteboard'] as const)
  for (const change of ['change', 'delete'] as const)
    test(`${domain} keeps opaque vector on definition ${change} through saved native reload`, async ({
      page,
    }, info) => {
      await assertForeignVectorUpdate(page, domain, change);
      await page.screenshot({ path: info.outputPath(`${domain}-${change}-opaque-vector.png`) });
    });
