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
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('Ready');
});
test('production SVG agrees with the evaluator at random seek/terminal and has no write side effects', async ({
  page,
}, info) => {
  await expect(page.getByRole('img', { name: 'Blue rectangle animation' })).toBeVisible();
  for (const tick of [240000, 60000, 0, 120000, 170000]) {
    expect(
      await page.evaluate((t) => {
        const f = window.animationPreview;
        f.player.seek(t);
        const expected = f.sceneAt(t);
        const rects = [...document.querySelectorAll('svg rect')];
        return (
          rects.length === expected.rectangles.length &&
          rects.every(
            (r, i) =>
              r.getAttribute('transform') ===
                `matrix(${expected.rectangles[i].matrix.join(' ')})` &&
              r.getAttribute('fill') === expected.rectangles[i].fill &&
              r.getAttribute('opacity') === String(expected.rectangles[i].opacity) &&
              r.getAttribute('width') === String(expected.rectangles[i].width) &&
              r.getAttribute('height') === String(expected.rectangles[i].height) &&
              r.getAttribute('data-instance') ===
                JSON.stringify(expected.rectangles[i].instancePath),
          ) &&
          f.unchanged()
        );
      }, tick),
    ).toBe(true);
  }
  await page.locator('#tick').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await expect(page.locator('#stage svg')).toHaveAttribute('data-tick', '0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('readonly-player.png') });
});
test('absolute clock handles frame drops, pause/resume, hidden state and abort cleanup', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.evaluate(() => window.animationPreview.advance(500));
  await expect(page.locator('#stage svg')).toHaveAttribute('data-tick', '120000');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => window.animationPreview.advance(2000));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.evaluate(() => window.animationPreview.advance(2250));
  await expect(page.locator('#stage svg')).toHaveAttribute('data-tick', '180000');
  expect(
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return window.animationPreview.pending();
    }),
  ).toBe(0);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('#stage svg')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      window.animationPreview.advance(9000);
      return window.animationPreview.unchanged() && window.animationPreview.pending() === 0;
    }),
  ).toBe(true);
});
test('reduced motion suppresses autoplay but allows an explicit play action', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?autoplay');
  await expect(page.getByRole('status')).toHaveText('Ready');
  expect(await page.evaluate(() => window.animationPreview.pending())).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  expect(await page.evaluate(() => window.animationPreview.pending())).toBe(1);
  await page.getByRole('button', { name: 'Close preview' }).click();
});
test('real requestAnimationFrame advances and closes cleanly', async ({ page }) => {
  await page.goto('/?realtime');
  await expect(page.getByRole('status')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.animationPreview.player.tick))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('#stage svg')).toHaveCount(0);
});
test('real PNG decoder reports ready dimensions and refuses corrupt bytes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 3;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas encode'))), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const contentHash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const pin = {
      id: 'png',
      contentHash,
      byteLength: bytes.length,
      mediaType: 'image/png' as const,
    };
    const abort = new AbortController();
    const ready = await window.animationPreview.preparePreviewImage(pin, bytes, abort.signal);
    const size = [ready.width, ready.height];
    ready.dispose();
    ready.dispose();
    bytes[0] = 0;
    let rejected = false;
    try {
      await window.animationPreview.preparePreviewImage(pin, bytes, abort.signal);
    } catch {
      rejected = true;
    }
    return { size, rejected };
  });
  expect(result).toEqual({ size: [2, 3], rejected: true });
});
test('shows the documented discrete endpoint difference without changing nested half-open semantics', async ({
  page,
}, info) => {
  await page.goto('/?endpoint');
  await expect(page.getByRole('status')).toHaveText('Ready');
  await expect(page.getByRole('img', { name: 'Child exact terminal pose' })).toBeVisible();
  const samples = await page.evaluate(() => {
    const f = window.animationPreview;
    return {
      parentAtOut: f.sceneAt(120000).rectangles[1].matrix[4],
      parentFinal: f.sceneAt(240000).rectangles[1].matrix[4],
      childBefore: f.childSceneAt(119999).rectangles[0].matrix[4],
      childFinal: f.childSceneAt(120000).rectangles[0].matrix[4],
      unchanged: f.unchanged(),
    };
  });
  expect(samples).toEqual({
    parentAtOut: 260,
    parentFinal: 260,
    childBefore: 0,
    childFinal: 40,
    unchanged: true,
  });
  const rootTransform = await page.locator('#stage rect').nth(1).getAttribute('transform');
  const directTransform = await page.locator('#child-endpoint rect').getAttribute('transform');
  expect(rootTransform?.split(' ').at(-2)).toBe('260');
  expect(directTransform?.split(' ').at(-2)).toBe('40');
  await page.screenshot({ path: info.outputPath('discrete-endpoint.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.locator('svg')).toHaveCount(0);
});
