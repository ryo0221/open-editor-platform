import { test, expect } from './fixtures';
import { mkdir } from 'node:fs/promises';
test('TP-Q04 portrait/landscape image, omitted image and long Japanese produce native preview or a field diagnostic', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/template-host.html');
  await page.getByLabel('Host template', { exact: true }).selectOption('slide-product');
  const human = page.getByRole('heading', { name: 'Human form', exact: true }).locator('..');
  const preview = page.getByRole('region', { name: 'Host prepared preview', exact: true });
  await mkdir('docs/screenshots/issue-4', { recursive: true });
  for (const [name, width, height] of [
    ['portrait', 160, 640],
    ['landscape', 640, 160],
  ] as const) {
    // Deterministic two-tone illustration exposes fit/crop edges without a network asset.
    const data = await page.evaluate(
      ({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#c4d9cd';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#345c73';
        ctx.fillRect(8, 8, width - 16, height - 16);
        ctx.fillStyle = '#ffe2a3';
        ctx.beginPath();
        ctx.arc(width / 2, height / 2, 45, 0, 2 * Math.PI);
        ctx.fill();
        return canvas.toDataURL('image/png');
      },
      { width, height },
    );
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    await human
      .locator('[data-slot="image"]')
      .setInputFiles({ name: name + '.png', mimeType: 'image/png', buffer: bytes });
    await expect(human.getByRole('img', { name: '画像（任意）の選択画像' })).toBeVisible();
    await human.getByRole('button', { name: 'Formから準備', exact: true }).click();
    await expect(preview).toBeVisible();
    await preview.getByRole('img').evaluate((img) => (img as HTMLImageElement).decode());
    const aspect = await preview.getByRole('img').evaluate((img) => {
      const source = img as HTMLImageElement,
        canvas = document.createElement('canvas');
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(source, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = Infinity,
        right = -1,
        top = Infinity,
        bottom = -1;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          if (
            pixels[i] > 240 &&
            pixels[i + 1] > 205 &&
            pixels[i + 1] < 235 &&
            pixels[i + 2] > 140 &&
            pixels[i + 2] < 185
          ) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { width: right - left + 1, height: bottom - top + 1 };
    });
    expect(aspect.width).toBeGreaterThan(20);
    expect(Math.abs(aspect.width - aspect.height)).toBeLessThanOrEqual(2);
    await preview.screenshot({ path: `docs/screenshots/issue-4/image-${name}.png` });
  }
  await human.getByRole('button', { name: '画像を省略', exact: true }).click();
  await human.getByRole('button', { name: 'Formから準備', exact: true }).click();
  const svg = await preview.getByRole('img').getAttribute('src');
  expect(decodeURIComponent(svg!)).not.toContain('<image');
  await human.locator('[data-slot="title"]').fill('長い日本語の見出し'.repeat(15));
  await human.getByRole('button', { name: 'Formから準備', exact: true }).click();
  await expect(human.locator('[data-slot="title"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(preview).toHaveCount(0);
});
test('TP-Q15 independent Host read-only blocks even a previously prepared creation', async ({
  page,
}) => {
  await page.goto('/template-host.html');
  await page.getByRole('button', { name: 'Formから準備', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Host prepared preview', exact: true });
  await expect(preview).toBeVisible();
  await page.getByLabel('Host read only', { exact: true }).check();
  await expect(preview.getByRole('button', { name: 'Hostに作成', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Host result' })).toHaveCount(0);
});
