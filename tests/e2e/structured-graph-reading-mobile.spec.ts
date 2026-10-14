import {
  checkDefaultLabels,
  checkDefaultLabelUpdates,
  checkDefaultOverlap,
} from './structured-graph-default-labels';
import {
  checkUnmeasurableFit,
  checkNoopCompositionSave,
  checkMeasuredInitialFit,
  checkGraphSwitchCamera,
  checkCompositionReadonly,
  checkActualLabelBounds,
} from './structured-graph-reading-fixtures';
import { test } from './fixtures';
import { checkReadingControls, checkReadingFilters } from './structured-graph-reading-fixtures';
test('mobile reading Host: readonly tools, full labels, custom Inspector and adjacent emphasis', async ({
  page,
}, info) => {
  await checkReadingControls(page);
  await page.screenshot({ path: info.outputPath('graph-reading-mobile.png') });
});
test('mobile reading Host: initial Fit, optional refit and private relation filters', async ({
  page,
}, info) => {
  await checkReadingFilters(page);
  await page.screenshot({ path: info.outputPath('graph-filter-mobile.png') });
});

for (const view of ['origin', 'custom'] as const)
  test(`review regression: ${view} resets scroll on graph switch`, async ({ page }, info) => {
    await checkGraphSwitchCamera(page, view);
    await page.screenshot({ path: info.outputPath(`review-camera-${view}.png`) });
  });
for (const permission of ['Host read only', 'Profile read only'] as const)
  test(`review regression: ${permission} during composition preserves buffer and selection`, async ({
    page,
  }, info) => {
    await checkCompositionReadonly(page, permission);
    await page.screenshot({ path: info.outputPath('review-composition.png') });
  });
test('review regression: actual wide glyph bounds do not overlap nodes', async ({ page }, info) => {
  await checkActualLabelBounds(page);
  await page.screenshot({ path: info.outputPath('review-wide-label.png') });
});

for (const mode of ['fresh', 'switch', 'filter'] as const)
  test(`review measurement Fit: ${mode}`, async ({ page }) => {
    await checkMeasuredInitialFit(page, mode);
  });

test('review no-op composition permits Save after readonly', async ({ page }) => {
  await checkNoopCompositionSave(page);
});

for (const mode of ['refused', 'empty', 'space', 'zero'] as const)
  test(`review Fit readiness: ${mode}`, async ({ page }) => {
    await checkUnmeasurableFit(page, mode);
  });

test('default node labels: full Japanese English unbroken and multiline text', async ({
  page,
}, info) => {
  await checkDefaultLabels(page);
  await page.screenshot({ path: info.outputPath('default-labels.png') });
});
test('default node labels: real font loading editing Undo and explicit override', async ({
  page,
}, info) => {
  await checkDefaultLabelUpdates(page);
  await page.screenshot({ path: info.outputPath('default-label-updates.png') });
});

test('default node labels: derived height drives overlap refusal and explicit sizing', async ({
  page,
}) => {
  await checkDefaultOverlap(page);
});
