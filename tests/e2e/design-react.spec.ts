import { test, expect, nativeArtifact, save } from './fixtures';
import { authorDesignReact, layer } from './design-react-fixtures';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
const run = promisify(execFile);
test('#29 D2–D4 ordinary Design authors native/original components and exports independent responsive site', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(12000);
  const source = await authorDesignReact(page);
  expect(source.elements.some((e) => e.type === 'react')).toBe(true);
  expect(source.components[0].web?.symbol).toBe('ProductCard');
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(source);
  await page.screenshot({ path: info.outputPath('ordinary-design-source-canvas.png') });
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review Design React export', exact: true });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  const download = await pending;
  await mkdir('work/issue-29', { recursive: true });
  await download.saveAs('work/issue-29/ordinary-design.zip');
  const files = unzipSync(new Uint8Array(await readFile('work/issue-29/ordinary-design.zip')));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(manifest.routes).toHaveLength(2);
  expect(
    manifest.mappings.some(
      (m: { nativeId: string }) =>
        m.nativeId === source.elements.find((e) => e.react?.import.name === 'Button')!.id,
    ),
  ).toBe(true);
  expect(strFromU8(files['ProductPage.tsx'])).toContain('@reference/ui');
  expect(strFromU8(files['ProductPage.tsx'])).not.toContain('@editor-platform');
  expect(files['styles/tokens.css']).toBeDefined();
  await run(
    process.execPath,
    ['scripts/design-react-export-host.mjs', 'work/issue-29/ordinary-design.zip'],
    { maxBuffer: 1024 * 1024 },
  );
  await review.getByRole('button', { name: 'Close export review', exact: true }).click();
  const accepted = await nativeArtifact(page);
  await layer(page, 'Contact');
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  await dialog.getByRole('button', { name: 'Interact with React', exact: true }).click();
  const preview = dialog.frameLocator('iframe');
  const app = await context.newPage();
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  app.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    for (const width of [390, 1024, 1400]) {
      await dialog
        .getByLabel('Design React preview width', { exact: true })
        .selectOption(String(width));
      await app.setViewportSize({ width, height: 700 });
      await app.goto('http://127.0.0.1:4176/contact');
      await expect(app.getByRole('heading', { name: 'Color study', exact: true })).toBeVisible();
      await expect(
        preview.getByRole('heading', { name: 'Color study', exact: true }),
      ).toBeVisible();
      // Keep the preview at an integer compositor origin, as in #24 acceptance.
      // The composition, styling and viewport are unchanged.
      await expect(dialog.locator('iframe')).toHaveAttribute('aria-busy', 'false');
      await dialog.locator('iframe').evaluate((element, width) => {
        Object.assign(element.style, {
          position: 'fixed',
          top: '0px',
          left: '0px',
          zIndex: '9999',
          width: `${width}px`,
        });
      }, width);
      const before = await preview
        .locator('main')
        .screenshot({ path: info.outputPath(`preview-${width}.png`) });
      const after = await app
        .locator('main')
        .screenshot({ path: info.outputPath(`export-${width}.png`) });
      expect(createHash('sha256').update(before).digest('hex')).toBe(
        createHash('sha256').update(after).digest('hex'),
      );
      expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await preview.getByRole('textbox', { name: 'Name', exact: true }).fill('Ryo');
    await preview.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(preview.getByRole('heading', { name: 'Thanks Ryo' })).toBeVisible();
    await app.getByRole('textbox', { name: 'Name', exact: true }).fill('Ryo');
    await app.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Thanks Ryo' })).toBeVisible();
    await expect(app.locator('#app-status')).toHaveText('Submitted 1');
    await dialog.locator('iframe').evaluate((element) =>
      Object.assign(element.style, {
        position: '',
        top: '',
        left: '',
        zIndex: '',
        width: '100%',
      }),
    );
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
    await layer(page, 'Product');
    await page
      .getByRole('button', { name: 'Preview selected Design as React', exact: true })
      .click();
    for (const width of [390, 1024, 1400]) {
      await dialog
        .getByLabel('Design React preview width', { exact: true })
        .selectOption(String(width));
      await expect(dialog.locator('iframe')).toHaveAttribute('aria-busy', 'false');
      await dialog.locator('iframe').evaluate(
        (element, width) =>
          Object.assign(element.style, {
            position: 'fixed',
            top: '0px',
            left: '0px',
            zIndex: '9999',
            width: `${width}px`,
          }),
        width,
      );
      await app.setViewportSize({ width, height: 700 });
      await app.goto('http://127.0.0.1:4176/');
      await expect(
        app.getByRole('heading', { name: 'Reusable native card', exact: true }),
      ).toBeVisible();
      await expect(
        preview.getByRole('heading', { name: 'Reusable native card', exact: true }),
      ).toBeVisible();
      const cardBox = await app
        .getByRole('region', { name: 'Reference card', exact: true })
        .boundingBox();
      const headingBox = await app
        .getByRole('heading', { name: 'Reusable native card', exact: true })
        .boundingBox();
      expect(headingBox!.y).toBeGreaterThanOrEqual(cardBox!.y);
      expect(headingBox!.y + headingBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height);
      expect(headingBox!.width).toBeLessThanOrEqual(cardBox!.width);
      for (const image of [
        app.getByRole('img', { name: 'Native PNG sample' }),
        app.getByRole('img', { name: 'Original React PNG sample' }),
      ]) {
        await expect(image).toBeVisible();
        expect(
          await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
        ).toBeGreaterThan(0);
      }
      const expected = await preview
        .locator('main')
        .screenshot({ path: info.outputPath(`product-preview-${width}.png`) });
      const actual = await app
        .locator('main')
        .screenshot({ path: info.outputPath(`product-export-${width}.png`) });
      expect(actual.equals(expected), `Identical native/original product pixels at ${width}`).toBe(
        true,
      );
      expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
    await app.goto('http://127.0.0.1:4176/');
    await expect(app.getByRole('heading', { name: 'Reusable native card' })).toBeVisible();
    await app.getByRole('link', { name: 'Contact us', exact: true }).click();
    await expect(app).toHaveURL('http://127.0.0.1:4176/contact');
    await expect(app.getByRole('textbox', { name: 'Name' })).toBeVisible();
    await dialog.locator('iframe').evaluate((element) => {
      Object.assign(element.style, { position: '', top: '', left: '', zIndex: '', width: '100%' });
    });
    await page.screenshot({ path: info.outputPath('ordinary-design-react-preview.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
  await dialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page
    .getByRole('button', { name: 'Register native components for React UI', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Interact', exact: true })).toBeVisible();
  const registered = page.frameLocator('iframe[title="React component preview"]');
  await expect(registered.getByRole('heading', { name: 'Reusable native card' })).toBeVisible();
  await page.reload();
  await expect(registered.getByRole('heading', { name: 'Reusable native card' })).toBeVisible();
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(files['native.json']),
  });
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  expect((await nativeArtifact(page)).draft.content).toEqual({
    ...source,
    web: {
      ...source.web,
      publications: (accepted.draft.content as typeof source).web!.publications,
    },
  });
});
