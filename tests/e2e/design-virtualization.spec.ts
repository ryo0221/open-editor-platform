import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures';

let bundle: Promise<{ js: string; css: string }>;
test.beforeEach(async ({ page }) => {
  test.setTimeout(120000);
  bundle ??= build({
    entryPoints: ['tests/fixtures/design-prototype/large-host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/design-viewport',
    format: 'iife',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((file) => file.path.endsWith('.css'))!.text,
  }));
  const assets = await bundle;
  await page.route('**/viewport-design.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: assets.js }),
  );
  await page.route('**/viewport-design.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: assets.css }),
  );
  await page.route('**/viewport-design.html*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/viewport-design.css"><body style="margin:0"><div id="root"></div><script src="/viewport-design.js"></script>',
    }),
  );
  await page.goto('/viewport-design.html?immutable&native');
});

for (const mode of ['move', 'resize', 'rotate'] as const)
  test(`large native Design keeps viewport culling during ${mode} preview`, async ({
    page,
  }, info) => {
    const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
    await expect(canvas).toBeVisible({ timeout: 90000 });
    if (!(await page.getByRole('button', { name: 'Frame 0', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
    await page.getByRole('button', { name: 'Frame 0', exact: true }).click();
    if (info.project.name === 'mobile')
      await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
    const frame = canvas.locator('[data-canvas-target="frame-0"]');
    const descendant = canvas.locator('[data-canvas-target="instance-0"]');
    const distant = canvas.locator('[data-canvas-target="frame-93"]');
    await expect(frame).toHaveCount(1);
    await expect(descendant).toHaveCount(1);
    await expect(distant).toHaveCount(0);
    await expect.poll(() => canvas.locator('[data-canvas-target]').count()).toBeLessThan(300);
    const before = await page.evaluate(() => window.designPrototypeProbe.native());
    const frameDrawing = await frame.innerHTML();
    const descendantDrawing = await descendant.innerHTML();
    const handle =
      mode === 'move'
        ? frame
        : canvas.getByRole('button', {
            name: mode === 'resize' ? 'Resize e' : 'Rotate selection',
            exact: true,
          });
    const bounds = (await handle.boundingBox())!;
    // The bottom-right Frame corner is clear of its children. Handles use their center.
    const start = {
      x: bounds.x + bounds.width * (mode === 'move' ? 0.97 : 0.5),
      y: bounds.y + bounds.height * (mode === 'move' ? 0.97 : 0.5),
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 35, start.y + (mode === 'resize' ? 0 : 25), { steps: 2 });
    await expect.poll(() => frame.innerHTML()).not.toBe(frameDrawing);
    // Design supplies preview entries for every native element. Unchanged entries
    // must not mount the other 93 Frames while a pointer transform is active.
    await expect(distant).toHaveCount(0);
    await expect.poll(() => canvas.locator('[data-canvas-target]').count()).toBeLessThan(300);
    if (mode !== 'resize')
      await expect.poll(() => descendant.innerHTML()).not.toBe(descendantDrawing);
    expect(await page.evaluate(() => window.designPrototypeProbe.native())).toBe(before);
    await page.screenshot({ path: info.outputPath(`${mode}-preview.png`) });
    // Move the viewport away during the preview: changed descendants must remain
    // mounted, while unchanged Frame children can leave the rendering window.
    await canvas.evaluate((node) =>
      node.dispatchEvent(
        new WheelEvent('wheel', { deltaX: 10000, deltaY: 10000, bubbles: true, cancelable: true }),
      ),
    );
    await expect(frame).toHaveCount(1);
    await expect(descendant).toHaveCount(mode === 'resize' ? 0 : 1);
    await expect(distant).toHaveCount(0);
    await expect.poll(() => canvas.locator('[data-canvas-target]').count()).toBeLessThan(100);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(descendant).toHaveCount(0);
    expect(await page.evaluate(() => window.designPrototypeProbe.native())).toBe(before);
  });

test('large native Design keeps offscreen selection, search and keyboard layer access', async ({
  page,
}, info) => {
  const canvas = page.getByRole('application', { name: 'Design canvas', exact: true });
  await expect(canvas).toBeVisible({ timeout: 90000 });
  const showNavigator = async () => {
    if (!(await page.getByRole('tree', { name: 'Layers', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'Toggle Design navigator', exact: true }).click();
  };
  await showNavigator();
  const tree = page.getByRole('tree', { name: 'Layers', exact: true });
  await expect.poll(() => tree.getByRole('treeitem').count()).toBeLessThan(40);
  const first = page.getByRole('button', { name: 'Layer Frame 0', exact: true });
  await first.focus();
  await page.keyboard.press('End');
  const last = page.getByRole('button', { name: 'Layer Frame 93 element 49', exact: true });
  await expect(last).toBeFocused();
  await last.press('F2');
  const rename = page.getByLabel('Rename layer', { exact: true });
  await rename.fill('Private rename buffer');
  await tree.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(rename).toHaveValue('Private rename buffer');
  await expect(rename).toHaveCount(1);
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText('Frame 93 element 49');
  await page.keyboard.press('Enter');
  await last.focus();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  const dragged = tree.locator('[data-layer-id="element-0-1"]');
  await dragged.dispatchEvent('dragstart');
  await tree.evaluate((node) => {
    node.scrollTop = 93 * 52 * 36;
  });
  await expect(dragged).toHaveCount(1);
  await tree.locator('[data-layer-id="frame-93"]').dispatchEvent('drop');
  await dragged.dispatchEvent('dragend');
  await expect
    .poll(
      async () =>
        JSON.parse(await page.evaluate(() => window.designPrototypeProbe.native())).elements.find(
          (element: { id: string }) => element.id === 'element-0-1',
        ).parentId,
    )
    .toBe('frame-93');
  // Reparenting preserves world coordinates. Restore the hierarchy before Fit:
  // otherwise the distant Frame correctly includes this still-nearby child.
  await dragged.dispatchEvent('dragstart');
  await tree.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(dragged).toHaveCount(1);
  await tree.locator('[data-layer-id="frame-0"]').dispatchEvent('drop');
  await dragged.dispatchEvent('dragend');
  await expect
    .poll(
      async () =>
        JSON.parse(await page.evaluate(() => window.designPrototypeProbe.native())).elements.find(
          (element: { id: string }) => element.id === 'element-0-1',
        ).parentId,
    )
    .toBe('frame-0');
  await page.getByLabel('Search layers', { exact: true }).fill('Frame 93 element 49');
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await last.click();
  await last.press('F2');
  await page.getByLabel('Rename layer', { exact: true }).fill('Renamed distant layer');
  await page.getByLabel('Rename layer', { exact: true }).press('Enter');
  await page.getByLabel('Search layers', { exact: true }).fill('');
  await expect(
    page.getByRole('button', { name: 'Layer Renamed distant layer', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Frame 0', exact: true }).click();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await expect(canvas.locator('[data-canvas-target="frame-0"]')).toHaveCount(1);
  await expect(canvas.locator('[data-canvas-target="frame-93"]')).toHaveCount(0);
  await expect.poll(() => canvas.locator('[data-canvas-target]').count()).toBeLessThan(300);
  const before = await page.evaluate(() => ({
    dom: document.querySelectorAll('*').length,
    native: window.designPrototypeProbe.native(),
  }));
  const open = page.getByRole('button', { name: 'Open prototype', exact: true });
  if (!(await open.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  const timing = await page.evaluate(async () => {
    const started = performance.now();
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Open prototype')!
      .click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const open = performance.now() - started;
    const closing = performance.now();
    (
      document.querySelector('button[aria-label="Close Design prototype"]') as HTMLButtonElement
    ).click();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { open, close: performance.now() - closing };
  });
  expect(await page.evaluate(() => window.designPrototypeProbe.native())).toBe(before.native);
  await writeFile(
    info.outputPath('viewport-measurements.json'),
    JSON.stringify({ dom: before.dom, timing }, null, 2),
  );
  // The timing probe uses DOM click(), so explicitly dismiss the mobile toolbar
  // menu before continuing with pointer-driven text editing.
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) === 'true')
    await more.click();
  const text = canvas.locator('[data-canvas-target="element-0-0"]');
  await text.dblclick({ position: { x: 8, y: 8 } });
  const editor = page.getByLabel('Edit canvas text', { exact: true });
  await editor.fill('Retained private text');
  await canvas.evaluate((node) =>
    node.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 10000, deltaY: 10000, bubbles: true, cancelable: true }),
    ),
  );
  await expect(text).toHaveCount(1);
  await expect(editor).toHaveCount(1);
  await expect(editor).toHaveText('Retained private text');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(await page.evaluate(() => window.designPrototypeProbe.native())).elements.find(
          (element: { id: string }) => element.id === 'element-0-0',
        ).text,
    )
    .toBe('Retained private text');
  await canvas.focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByText('4888 elements · 4888 selected', { exact: true })).toBeVisible();
  await expect(canvas.locator('[data-canvas-target="frame-93"]')).toHaveCount(1);
  // Selection semantics use all native targets; fitting another frame still works after culling.
  await showNavigator();
  await page.getByRole('button', { name: 'Frame 93', exact: true }).click();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await expect(canvas.locator('[data-canvas-target="frame-93"]')).toHaveCount(1);
  await expect(canvas.locator('[data-canvas-target="frame-0"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('distant-frame.png') });
});
