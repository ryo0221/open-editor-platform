import { build } from 'esbuild';
import { test, expect } from './fixtures';
let bundle: Promise<{ js: string; css: string }>;
for (const host of ['通常', '独立'] as const)
  test.describe(host, () => {
    test.beforeEach(async ({ page }) => {
      bundle ??= build({
        entryPoints: ['tests/fixtures/story-board/cameras.tsx'],
        bundle: true,
        write: false,
        outdir: '/tmp/story-board-camera-bundle',
        format: 'esm',
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((result) => ({
        js: result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: result.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
      }));
      const files = await bundle;
      await page.route('**/camera-fixture.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: files.js }),
      );
      await page.route('**/camera-fixture.css', (route) =>
        route.fulfill({ contentType: 'text/css', body: files.css }),
      );
      await page.route('**/camera-fixture-host?*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/camera-fixture.css"><nav><button id="camera-inspect">Inspect stored owners</button><output hidden id="camera-native"></output></nav><div id="root"></div><script type="module" src="/camera-fixture.js"></script>',
        }),
      );
    });
    for (const board of ['same', 'other'])
      test(`SB01 ${board} board: switching explicit settings keeps private cameras independent and saves no owners`, async ({
        page,
      }) => {
        await page.goto(
          `${host === '通常' ? '' : 'http://127.0.0.1:4177'}/camera-fixture-host?board=${board}`,
        );
        await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue(
          '3',
        );
        const before = await page.locator('#camera-native').textContent();
        const showCanvas = async () => {
          const button = page.getByRole('button', { name: 'キャンバスへ', exact: true });
          if (await button.isVisible()) await button.click();
          await expect(
            page.getByRole('application', { name: 'Whiteboard canvas', exact: true }),
          ).toBeVisible();
        };
        await showCanvas();
        await page.getByRole('button', { name: 'Fit board', exact: true }).click();
        const stage = page.getByRole('application', { name: 'Whiteboard canvas', exact: true });
        const box = (await stage.boundingBox())!;
        await stage.focus();
        await page.keyboard.down('Space');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 35, {
          steps: 5,
        });
        await page.mouse.up();
        await page.keyboard.up('Space');
        const key = (boardId: string, settingsId: string) =>
          `ep-camera:${JSON.stringify(['story-board', 'camera-fixture', boardId, settingsId])}`;
        const firstKey = key('sb660-board', 'sb660-settings');
        const firstCamera = await page.evaluate(
          (k) => JSON.parse(localStorage.getItem(k)!),
          firstKey,
        );
        expect(firstCamera.fit).toBe(false);
        const switchTo = async (id: string) => {
          await page.getByRole('button', { name: '別のボード', exact: true }).click();
          await page.getByRole('textbox', { name: '表示設定のArtifact ID', exact: true }).fill(id);
          await page.getByRole('button', { name: '指定したボードを開く', exact: true }).click();
          await expect(page.getByRole('slider', { name: '共通の時点', exact: true })).toHaveValue(
            '3',
          );
          await showCanvas();
        };
        await switchTo('camera-settings-2');
        const secondKey = key(
          board === 'same' ? 'sb660-board' : 'camera-board-2',
          'camera-settings-2',
        );
        await expect
          .poll(() => page.evaluate((k) => localStorage.getItem(k), secondKey))
          .not.toBeNull();
        const secondCamera = await page.evaluate(
          (k) => JSON.parse(localStorage.getItem(k)!),
          secondKey,
        );
        expect(secondCamera).not.toEqual(firstCamera);
        expect(secondCamera.pan).toEqual({ x: 0, y: 0 });
        await switchTo('sb660-settings');
        await expect
          .poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), firstKey))
          .toEqual(firstCamera);
        await page.getByRole('button', { name: 'Inspect stored owners', exact: true }).click();
        await expect(page.locator('#camera-native')).toHaveText(before!);
      });
  });
