import { test as base, expect, type Page } from '@playwright/test';
const test = base.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
async function migrated(page: Page) {
  await page.goto('/animation-viewer.html');
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Original prototype retained',
  );
  await expect(page.locator('svg')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open read-only viewer', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Migrate retained prototype', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Migration ready; open explicitly',
  );
  await expect(page.locator('svg')).toHaveCount(0);
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Open read-only viewer', exact: true }).click();
}
async function ready(page: Page) {
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Read-only viewer ready',
  );
  await expect(page.locator('svg')).toHaveCount(1);
}
test('actual Basic read shows exact migrated rectangle/group with read-only grants and retained hash', async ({
  page,
}, info) => {
  await migrated(page);
  await open(page);
  await ready(page);
  const inspected = await page.evaluate(() => window.extensionAnimationViewer.inspect());
  expect(inspected.originalUnchanged).toBe(true);
  expect(inspected.provenance).toMatchObject({
    schemaVersion: 1,
    ticksPerSecond: 240000,
    evaluatorVersion: 'animation-evaluator-rectangle-1',
    playerVersion: 'animation-rectangle-player-1',
  });
  expect(inspected.provenance!.sourceContentHash).not.toBe(inspected.provenance!.targetContentHash);
  expect(inspected.openings[0].slots).toEqual({
    edit: 'unavailable',
    inputs: 'unavailable',
    save: 'unavailable',
    lifecycle: 'granted',
    resources: 'unavailable',
  });
  await page.getByLabel('Seek Animation tick').evaluate((node: HTMLInputElement) => {
    node.value = '120000';
    node.dispatchEvent(new Event('input'));
  });
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 118 30)');
  await expect(page.locator('svg rect')).toHaveAttribute('opacity', '0.75');
  await page.screenshot({
    path: info.outputPath('extension-animation-viewer.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect(page.locator('svg')).toHaveCount(0);
  await open(page);
  await ready(page);
  expect(
    await page.evaluate(() => window.extensionAnimationViewer.inspect().originalUnchanged),
  ).toBe(true);
});
for (const phase of ['beforePrepare', 'beforeMount', 'afterMount'] as const)
  test(`late ${phase} work from closed A cannot display or notify reopened B`, async ({ page }) => {
    await migrated(page);
    const id = await page.evaluate((phase) => window.extensionAnimationViewer.hold(phase), phase);
    await open(page);
    await expect
      .poll(() => page.evaluate((id) => window.extensionAnimationViewer.entered(id), id))
      .toBe(true);
    await expect(page.locator('svg')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
    expect((await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state).toBe(
      'incomplete',
    );
    await open(page);
    await ready(page);
    const before = await page.evaluate(() => window.extensionAnimationViewer.inspect());
    expect(before.openings[0].outcome).toBe('ScopeRevoked');
    expect(before.openings[0].generation).not.toBe(before.openings[1].generation);
    await page.evaluate((id) => window.extensionAnimationViewer.release(id), id);
    await expect
      .poll(async () => (await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state)
      .toBe('drained');
    await ready(page);
    expect(
      (await page.evaluate(() => window.extensionAnimationViewer.inspect())).openings.map(
        (value) => value.outcome,
      ),
    ).toEqual(['ScopeRevoked', 'ready']);
  });
test('read loss while preparing denies old delivery; restoration requires an explicit fresh open', async ({
  page,
}) => {
  await migrated(page);
  const id = await page.evaluate(() => window.extensionAnimationViewer.hold('afterMount'));
  await open(page);
  await expect
    .poll(() => page.evaluate((id) => window.extensionAnimationViewer.entered(id), id))
    .toBe(true);
  await page.getByRole('button', { name: 'Revoke read', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Read revoked',
  );
  await expect(page.locator('svg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore read', exact: true }).click();
  await page.evaluate((id) => window.extensionAnimationViewer.release(id), id);
  await expect
    .poll(async () => (await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state)
    .toBe('drained');
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Read restored; reopen explicitly',
  );
  await expect(page.locator('svg')).toHaveCount(0);
  await open(page);
  await ready(page);
  expect(
    (await page.evaluate(() => window.extensionAnimationViewer.inspect())).openings.map(
      (value) => value.outcome,
    ),
  ).toEqual(['ScopeRevoked', 'ready']);
});
test('late unmount acknowledgment and detached control cannot remove or alter B', async ({
  page,
}) => {
  await migrated(page);
  await open(page);
  await ready(page);
  const stale = await page.getByLabel('Seek Animation tick').elementHandle();
  const id = await page.evaluate(() => window.extensionAnimationViewer.hold('afterDispose'));
  await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  await expect
    .poll(() => page.evaluate((id) => window.extensionAnimationViewer.entered(id), id))
    .toBe(true);
  await expect(page.locator('svg')).toHaveCount(0);
  expect((await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state).toBe(
    'incomplete',
  );
  await open(page);
  await ready(page);
  await stale!.evaluate((node: HTMLInputElement) => {
    node.value = '240000';
    node.dispatchEvent(new Event('input'));
  });
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 18 30)');
  await page.evaluate((id) => window.extensionAnimationViewer.release(id), id);
  await expect
    .poll(async () => (await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state)
    .toBe('drained');
  await ready(page);
});
for (const phase of ['beforeMount', 'afterMount'] as const)
  test(`synchronous ${phase} close prevents presentation and readiness`, async ({ page }) => {
    await migrated(page);
    await page.evaluate((phase) => window.extensionAnimationViewer.reenterClose(phase), phase);
    await open(page);
    await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
      'Viewer closed',
    );
    await expect(page.locator('svg')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.extensionAnimationViewer.inspect().openings[0].outcome),
      )
      .toBe('ScopeRevoked');
    await open(page);
    await ready(page);
  });
test('read revocation removes an already playing viewer and restoration never resumes it', async ({
  page,
}) => {
  await migrated(page);
  await open(page);
  await ready(page);
  await page.getByRole('button', { name: 'Play Animation', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke read', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Viewer status', exact: true })).toHaveText(
    'Read revoked',
  );
  await expect(page.locator('svg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore read', exact: true }).click();
  await expect(page.locator('svg')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.extensionAnimationViewer.drain(0))).state)
    .toBe('drained');
  await open(page);
  await ready(page);
  await expect(page.locator('svg rect')).toHaveAttribute('transform', 'matrix(1 0 0 1 18 30)');
});
