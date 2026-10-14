import { expect, type Page } from '@playwright/test';
import { mountReadingGraphHost } from './structured-graph-fixtures';
import { expectGraphFitted, readingSnapshot } from './structured-graph-reading-fixtures';

async function expectVisibleLabels(page: Page) {
  await expect
    .poll(
      () =>
        page.locator('.ep-graph-node').evaluateAll((nodes) =>
          nodes.every((node) => {
            const button = node.querySelector('.ep-graph-node-select')!;
            const bounds = button.getBoundingClientRect();
            const source = JSON.parse(
              document.querySelector('[data-testid="reading-source"]')!.textContent!,
            );
            const label = source.nodes.find(
              (n: { id: string }) => n.id === node.getAttribute('data-node-id'),
            ).attributes.name;
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode()))
              if (text.textContent === label) {
                const range = document.createRange();
                range.selectNodeContents(text);
                const rects = [...range.getClientRects()];
                return (
                  rects.length > 1 &&
                  rects.every(
                    (rect) =>
                      rect.left >= bounds.left - 1 &&
                      rect.right <= bounds.right + 1 &&
                      rect.top >= bounds.top - 1 &&
                      rect.bottom <= bounds.bottom + 1,
                  ) &&
                  (button as HTMLElement).scrollHeight <= (button as HTMLElement).clientHeight + 1
                );
              }
            return false;
          }),
        ),
      { message: 'All default labels must be visually contained, not just accessible' },
    )
    .toBe(true);
}
async function expectPorts(page: Page) {
  const edges = await page.locator('[data-edge-id]').evaluateAll((elements) => {
    const source = JSON.parse(
      document.querySelector('[data-testid="reading-source"]')!.textContent!,
    );
    return elements.every((el) => {
      const edge = source.edges.find(
        (e: { id: string }) => e.id === el.getAttribute('data-edge-id'),
      );
      const path = el.querySelector('path')!.getAttribute('d')!;
      const points = [...path.matchAll(/[ML]([\d.e+-]+),([\d.e+-]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      if (!points.length) return false;
      return [edge.from, edge.to].every((id, index) => {
        const node = document.querySelector(`[data-node-id="${id}"]`) as HTMLElement;
        const x = parseFloat(node.style.left),
          y = parseFloat(node.style.top),
          w = parseFloat(node.style.width),
          h = parseFloat(node.style.height);
        const [px, py] = index ? points[points.length - 1] : points[0];
        return (
          px >= x &&
          px <= x + w &&
          py >= y &&
          py <= y + h &&
          (px === x || px === x + w || py === y || py === y + h)
        );
      });
    });
  });
  expect(edges, 'ports use the same derived node bounds as rendering').toBe(true);
}
export async function checkDefaultLabels(page: Page) {
  await mountReadingGraphHost(page, '?default-labels&inputs');
  const original = await readingSnapshot(page);
  await expectVisibleLabels(page);
  await expectGraphFitted(page);
  await expectPorts(page);
  const multiline = page.locator('[data-node-id="n3"] .ep-graph-node-select');
  expect(
    await multiline.evaluate(
      (el) =>
        getComputedStyle(el).whiteSpace === 'pre-wrap' ||
        [...el.children].some((child) => getComputedStyle(child).whiteSpace === 'pre-wrap'),
    ),
  ).toBe(true);
  const node = page.locator('[data-node-id="n0"]');
  const box = (await node.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 2);
  await expect(page.getByTestId('reading-selection')).toHaveText('n0');
  expect(await readingSnapshot(page)).toEqual(original);
}
export async function checkDefaultLabelUpdates(page: Page) {
  await mountReadingGraphHost(page, '?default-labels&inputs');
  const original = await readingSnapshot(page);
  await expectVisibleLabels(page);
  const first = page.locator('[data-node-id="n0"]');
  const height = await first.evaluate((el) => parseFloat((el as HTMLElement).style.height));
  // Real local font load; no external provider or synthetic font-ready event.
  await page.addStyleTag({
    content:
      '@font-face {font-family: GraphLabelFixture; src: url(/office-fonts/NotoSansMonoCJKjp-Regular.otf)} .ep-graph .ep-graph-node-select {font-family: GraphLabelFixture, monospace; font-size: 20px;}',
  });
  await page.evaluate(async () => {
    await document.fonts.load('20px GraphLabelFixture');
    await document.fonts.ready;
  });
  await expect(first.locator('.ep-graph-node-select')).toHaveCSS('font-size', '20px');
  await expectVisibleLabels(page);
  await expect
    .poll(() => first.evaluate((el) => parseFloat((el as HTMLElement).style.height)))
    .toBeGreaterThan(height);
  expect(await readingSnapshot(page)).toEqual(original);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expectGraphFitted(page);
  await expectPorts(page);
  await page.getByLabel('Host read only', { exact: true }).uncheck();
  await first.locator('.ep-graph-node-select').click();
  const name = page.getByLabel('name', { exact: true });
  const text = (await name.inputValue()).repeat(2);
  await name.fill(text);
  await page.getByRole('button', { name: 'Apply attributes', exact: true }).click();
  await expectVisibleLabels(page);
  await expectPorts(page);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expectGraphFitted(page);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await readingSnapshot(page)).source).toBe(original.source);
  await expectVisibleLabels(page);
  await page.getByLabel('Custom node sizes', { exact: true }).check();
  await expect(first).toHaveCSS('width', '320px');
  await expect(first).toHaveCSS('height', '140px');
  await expectPorts(page);
}

export async function checkDefaultOverlap(page: Page) {
  await mountReadingGraphHost(page, '?default-labels&default-overlap');
  const original = await readingSnapshot(page);
  const edge = page.locator('[data-edge-id="labels01"]');
  await expect(edge.getByText('ノードの重なりを解消してください', { exact: true })).toBeVisible();
  await expect(edge.locator('path').first()).toHaveAttribute('d', '');
  await expectGraphFitted(page);
  await page.getByLabel('Custom node sizes', { exact: true }).check();
  await expect(edge.locator('path').first()).not.toHaveAttribute('d', '');
  await expect(page.locator('[data-node-id="n0"]')).toHaveCSS('height', '140px');
  await page.getByLabel('Custom node sizes', { exact: true }).uncheck();
  await expect(edge.getByText('ノードの重なりを解消してください', { exact: true })).toBeVisible();
  expect(await readingSnapshot(page)).toEqual(original);
}
