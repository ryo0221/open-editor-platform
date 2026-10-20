import { test, expect, nativeArtifact, save } from './fixtures';
import { authorDesignReact, jsonApply, layer } from './design-react-fixtures';
import { value } from './practical-fixtures';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { reuseHash } from '@editor-platform/reuse-core';
import type { DesignContent } from '@editor-platform/design/model';
const run = promisify(execFile);

test('#29 pinned default/named exports, named slot, CSS, asset, aliases and Provider survive ordinary Design round trip', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240_000);
  await authorDesignReact(page, '/?design-dependencies=1');
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Insert React DependencyBadge', exact: true }).click();
  await value(page, 'Layer name', 'Dependency badge');
  await value(page, 'Element height', '240');
  await jsonApply(page, 'Web responsive layout', {
    base: { width: { kind: 'literal', value: '100%' }, height: { kind: 'literal', value: 'auto' } },
    breakpoints: {},
  });
  await jsonApply(page, 'React bindings', {
    label: { kind: 'data', input: 'title', path: [] },
    onPress: { kind: 'callback', callback: 'onBuy' },
  });
  await page.getByRole('button', { name: 'Insert React Text', exact: true }).click();
  await value(page, 'Layer name', 'Named footer');
  await value(page, 'React prop text', 'Named slot content');
  await save(page, 1);
  const source = (await nativeArtifact(page)).draft.content as DesignContent;
  const original = await readFile('apps/react-ui-reference/src/dependency-badge.tsx', 'utf8');
  const badge = source.elements.find((element) => element.name === 'Dependency badge')!;
  const footer = source.elements.find((element) => element.name === 'Named footer')!;
  expect(badge.react?.import).toEqual({ source: '@reference/dependency-ui', export: 'default' });
  expect(badge.react?.slots.footer).toEqual([footer.id]);
  expect(badge.react?.component.implementationHash).toBe(reuseHash(original));
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(source);
  await layer(page, 'Product');
  await page.getByRole('button', { name: 'Preview selected Design as React', exact: true }).click();
  const previewDialog = page.getByRole('dialog', { name: 'Design React preview', exact: true });
  const preview = previewDialog.frameLocator('iframe');
  await expect(preview.getByText('Named slot content', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Color study', exact: true })).toHaveCSS(
    'border-top-color',
    'rgb(18, 102, 170)',
  );
  await previewDialog.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('button', { name: 'Review React export', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review Design React export', exact: true });
  await review.getByRole('button', { name: 'Accept reviewed conversion', exact: true }).click();
  const pending = page.waitForEvent('download');
  await review.getByRole('button', { name: 'Download React bundle', exact: true }).click();
  await mkdir('work/issue-29-dependencies', { recursive: true });
  const archive = 'work/issue-29-dependencies/ordinary-design.zip';
  await (await pending).saveAs(archive);
  const files = unzipSync(new Uint8Array(await readFile(archive)));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  expect(
    manifest.components.find((component: { name: string }) => component.name === 'DependencyBadge')
      .ref.implementationHash,
  ).toBe(reuseHash(original));
  expect(strFromU8(files['ProductPage.tsx'])).toContain('@reference/dependency-ui');
  expect(files['styles/dependency-fixture.css']).toBeDefined();
  expect(files['assets/product.png']).toBeDefined();
  await review.getByRole('button', { name: 'Close export review', exact: true }).click();
  const missing = { ...files };
  delete missing['styles/dependency-fixture.css'];
  const incomplete = 'work/issue-29-dependencies/missing-css.zip';
  await writeFile(incomplete, zipSync(missing));
  await expect(
    run(process.execPath, ['scripts/design-react-export-host.mjs', incomplete], {
      maxBuffer: 1024 * 1024,
    }),
  ).rejects.toThrow(/dependency-fixture\.css/);
  const app = await context.newPage();
  const errors: string[] = [];
  app.on('pageerror', (error) => errors.push(error.message));
  app.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    for (const mode of ['component', 'page', 'site']) {
      await run(process.execPath, ['scripts/design-react-export-host.mjs', archive, mode], {
        maxBuffer: 1024 * 1024,
      });
      expect(await readFile('work/issue-29/independent-host/dependency-ui.tsx', 'utf8')).toBe(
        original,
      );
      for (const width of [390, 1024, 1400]) {
        await app.setViewportSize({ width, height: 800 });
        await app.goto('http://127.0.0.1:4176/');
        if (mode === 'component') {
          await expect(
            app.getByRole('heading', { name: 'Color study', exact: true }),
          ).toBeVisible();
        } else {
          await expect(app.getByText('Named slot content', { exact: true })).toBeVisible();
          const button = app.getByRole('button', { name: 'Color study', exact: true });
          await expect(button).toHaveCSS('border-top-color', 'rgb(18, 102, 170)');
          const image = app.getByRole('img', { name: 'Pinned dependency image', exact: true });
          await expect(image).toBeVisible();
          expect(
            await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
          ).toBeGreaterThan(0);
          await expect(app.getByRole('region', { name: 'Reference card' }).last()).toHaveAttribute(
            'data-theme',
            'light',
          );
          await button.click();
          await expect(
            app.getByRole('button', { name: 'Thanks visitor', exact: true }),
          ).toBeVisible();
        }
        expect(await app.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
        await app.screenshot({ path: info.outputPath(`${mode}-${width}.png`), fullPage: true });
      }
      if (mode === 'site') {
        await app.getByRole('link', { name: 'Contact us', exact: true }).click();
        await expect(app).toHaveURL('http://127.0.0.1:4176/contact');
        await app.getByRole('textbox', { name: 'Name', exact: true }).fill('Dependency');
        await app.getByRole('button', { name: 'Submit', exact: true }).click();
        await expect(app.getByRole('heading', { name: 'Thanks Dependency' })).toBeVisible();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
  if (!(await page.getByLabel('Import artifact', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'native.json',
    mimeType: 'application/json',
    buffer: Buffer.from(files['native.json']),
  });
  const imported = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(imported.elements.find((element) => element.id === badge.id)?.react).toEqual(badge.react);
  expect(imported.elements.find((element) => element.id === footer.id)?.react).toEqual(
    footer.react,
  );
  expect(imported.web?.environment).toEqual(source.web?.environment);
  expect(await readFile('apps/react-ui-reference/src/dependency-badge.tsx', 'utf8')).toBe(original);
});
