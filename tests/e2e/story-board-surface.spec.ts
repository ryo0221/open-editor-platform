import { build } from 'esbuild';
import { test, expect } from './fixtures';

let bundle: Promise<{ js: string; css: string }>;
test.beforeEach(async ({ page }) => {
  bundle ??= build({
    entryPoints: ['tests/fixtures/story-board/surface.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/story-board-surface-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((file) => file.path.endsWith('.css'))?.text ?? '',
  }));
  const files = await bundle;
  await page.route('**/surface-fixture.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: files.js }),
  );
  await page.route('**/surface-fixture.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: files.css }),
  );
  await page.route('**/surface-fixture-host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/surface-fixture.css"><style>html,body{margin:0}#root{height:100vh}</style><div id="root"></div><script type="module" src="/surface-fixture.js"></script>',
    }),
  );
  await page.goto('/surface-fixture-host');
  await page.getByRole('button', { name: 'Fit board', exact: true }).click();
});

test('SB07: content controls and keyboard change view state without native layout or Undo', async ({
  page,
}) => {
  const before = await page.getByTestId('native').textContent();
  const control = page.getByRole('button', { name: '時点を進める', exact: true });
  await control.click();
  await expect(page.getByTestId('counter')).toHaveText('1');
  await expect(control).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('counter')).toHaveText('2');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('native')).toHaveText(before!);
  await expect(page.getByTestId('history')).toHaveText('false');
  await page.getByRole('button', { name: '配置モード', exact: true }).click();
  await control.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('counter')).toHaveText('2');
  await page.keyboard.press('Tab');
  await expect(control).not.toBeFocused();
});

test('SB07: layout selects the native frame, moves it once and restores it with native Undo', async ({
  page,
}) => {
  const before = await page.getByTestId('native').textContent();
  await page.getByRole('button', { name: '配置モード', exact: true }).click();
  // Overlay has pointer-events:none in layout: the same position selects the ordinary shape.
  const box = (await page
    .getByRole('button', { name: '時点を進める', exact: true })
    .boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('history')).toHaveText('true');
  expect(await page.getByTestId('native').textContent()).not.toBe(before);
  await expect(page.getByTestId('counter')).toHaveText('0');
  await page.getByRole('button', { name: 'Undo fixture', exact: true }).click();
  await expect(page.getByTestId('native')).toHaveText(before!);
  await expect(page.getByTestId('history')).toHaveText('false');
});
