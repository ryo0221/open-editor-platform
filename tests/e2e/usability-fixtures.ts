import { expect, type Locator, type Page } from '@playwright/test';
import { createArtifact } from '@editor-platform/artifact-core';
export async function importUsability(
  page: Page,
  kind: string,
  content: unknown,
  name = 'Usability fixture',
) {
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'usability.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact(kind, name, content))),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
}
export async function dragBetween(page: Page, handle: Locator, target: Locator) {
  const from = (await handle.boundingBox())!,
    to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}
/** Click a point on the actual routed stroke, rather than its rectangular bounding-box centre. */
export async function selectConnection(page: Page, name: string) {
  const point = await page.getByRole('button', { name, exact: true }).evaluate((element) => {
    const path = element as SVGPathElement,
      local = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}
export async function graphSourceAction(page: Page, name: '元データを開く' | 'データ定義') {
  await page.getByRole('button', { name: 'Graph source and definitions', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Graph source and definitions', exact: true });
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) === 'true')
    await trigger.click();
}
