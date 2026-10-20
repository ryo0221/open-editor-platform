import { test, expect } from '../e2e/fixtures';
import { reactUiClassName } from '@editor-platform/react-ui-core';

for (const width of [390, 1024, 1400]) {
  test(`independent React-only 500-node output at ${width}`, async ({ page, context }, info) => {
    test.setTimeout(120000);
    await page.goto('/');
    const iframe = page.locator('iframe[title="React component preview"]');
    const frame = page.frameLocator('iframe[title="React component preview"]');
    await expect(iframe).toHaveAttribute('aria-busy', 'false');
    await page.getByLabel('Preview width', { exact: true }).selectOption(String(width));
    await page.getByRole('button', { name: 'Interact', exact: true }).click();
    await expect(iframe).toHaveAttribute('aria-busy', 'false');
    await expect(frame.locator('[data-react-ui-node]')).toHaveCount(500);
    await iframe.evaluate((element) => {
      Object.assign(element.style, { position: 'fixed', top: '0px', left: '0px', zIndex: '9999' });
    });
    const independent = await context.newPage();
    const errors: string[] = [];
    independent.on('pageerror', (error) => errors.push(error.message));
    independent.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await independent.setViewportSize({ width, height: 700 });
      await independent.goto('http://127.0.0.1:4196');
      await expect(independent.locator('[class^="rui-"]')).toHaveCount(500);
      await expect(independent.locator('article[data-theme="scale-light"]')).toHaveCount(18);
      expect(await independent.locator('iframe,[data-react-ui-node]').count()).toBe(0);
      for (const image of await independent.locator('img').all())
        expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(
          256,
        );
      const preview = frame.locator('main');
      const output = independent.locator('main');
      async function compareViewport(state: string) {
        const screenshots = [];
        for (const [host, label] of [
          [page, 'preview'],
          [independent, 'export'],
        ] as const) {
          await host.bringToFront();
          await host.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
          // Both real viewports are 700px high. A locator screenshot extending
          // beyond the iframe captures the surrounding Host, not offscreen React.
          screenshots.push(
            await host.screenshot({
              path: info.outputPath(`${label}-${state}-${width}.png`),
              clip: { x: 0, y: 0, width, height: 700 },
            }),
          );
        }
        expect(
          screenshots[1].equals(screenshots[0]),
          `Identical 500-node output at ${width}px`,
        ).toBe(true);
      }
      await compareViewport('initial');
      // Compare exact layout/styles of every exported node, including responsive
      // columns, without depending on preview-only display-contents addresses.
      const layout = async (root: typeof output) =>
        root.locator('[class^="rui-"]').evaluateAll((elements) =>
          elements.map((element) => {
            const style = getComputedStyle(element),
              box = element.getBoundingClientRect();
            return {
              className: element.className,
              tag: element.tagName,
              text: element.textContent,
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              columns: style.gridTemplateColumns,
              color: style.color,
              background: style.backgroundColor,
            };
          }),
        );
      // Include main itself; its descendants account for the other 499 nodes.
      const previewLayout = await layout(preview);
      expect(previewLayout).toHaveLength(499);
      expect(await layout(output)).toEqual(previewLayout);
      await frame.getByRole('textbox', { name: 'Item 3', exact: true }).fill('Aki');
      await independent.getByRole('textbox', { name: 'Item 3', exact: true }).fill('Aki');
      await expect(independent.getByLabel('Application name', { exact: true })).toHaveText('Aki');
      await expect(frame.getByRole('textbox', { name: 'Item 21', exact: true })).toHaveValue('Aki');
      await expect(independent.getByRole('textbox', { name: 'Item 21', exact: true })).toHaveValue(
        'Aki',
      );
      await frame.getByRole('button', { name: 'Item 2', exact: true }).click();
      await independent.locator('.' + reactUiClassName('leaf-002')).click();
      await expect(frame.getByLabel('Scale callback', { exact: true })).toHaveText(
        'onPress: called',
      );
      await expect(independent.getByLabel('Application callbacks', { exact: true })).toHaveText(
        '1',
      );
      await compareViewport('interaction');
      expect(errors).toEqual([]);
    } finally {
      await independent.close();
    }
  });
}
