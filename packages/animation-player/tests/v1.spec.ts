import { test as base, expect } from '@playwright/test';
const test = base.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
test('explicit migration mounts the v1 Player and preserves prototype while rendering exact attributes', async ({
  page,
}, info) => {
  await page.goto('/v1.html');
  await expect(page.getByRole('status')).toHaveText('Prototype retained');
  await expect(page.locator('svg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Migrate to v1 draft' }).click();
  await expect(page.getByRole('status')).toHaveText('v1 ready');
  for (const tick of [240000, 120000, 0]) {
    const result = await page.evaluate((t) => {
      const f = window.animationV1;
      f.seek(t);
      const s = f.sceneAt(t),
        rect = document.querySelector('svg rect')!;
      return {
        schema: s.schemaVersion,
        evaluator: s.evaluatorVersion,
        hashChanged: s.contentHash !== f.oldHash,
        unchanged: f.unchanged(),
        x: s.rectangles[0].matrix[4],
        attributes: ['transform', 'fill', 'opacity', 'width', 'height'].map((a) =>
          rect.getAttribute(a),
        ),
      };
    }, tick);
    expect(result.schema).toBe('animation-rectangle-scene-1');
    expect(result.evaluator).toBe('animation-evaluator-rectangle-1');
    expect(result.hashChanged && result.unchanged).toBe(true);
    expect(result.x).toBe(10 + tick / 1200);
    expect(result.attributes).toEqual([
      `matrix(1 0 0 1 ${10 + tick / 1200} 30)`,
      '#2563eb',
      '0.5',
      '60',
      '40',
    ]);
  }
  await page.screenshot({ path: info.outputPath('rectangle-v1.png') });
});
test('v1 Player refuses prototype before mounting and closes on scope abort', async ({ page }) => {
  await page.goto('/v1.html');
  await expect(page.getByRole('status')).toHaveText('Prototype retained');
  expect(await page.evaluate(() => window.animationV1.rejectPrototype())).toBe(true);
  await expect(page.locator('svg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Migrate to v1 draft' }).click();
  await expect(page.getByRole('status')).toHaveText('v1 ready');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('svg')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      window.animationV1.dispose();
      return window.animationV1.unchanged();
    }),
  ).toBe(true);
});
