import { createArtifact } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { test, expect, nativeArtifact } from './fixtures';

// A long left-to-right flow (12 nodes), like a grid interconnection diagram.
const wide = `flowchart LR
  A[Site A 1.5GW] -->|HVDC 525kV| B[Site B 1.2GW]
  B -->|HVDC 525kV| C[Site C 1.4GW]
  C -->|HVDC 525kV| D[Site D 0.9GW]
  D -->|HVDC 525kV| E[Site E 1.0GW]
  E -->|HVDC 525kV| F[Site F 0.8GW]
  F --> G[Grid G]
  G --> H[Grid H]
  H --> I[Grid I]
  I --> J[Grid J]
  J --> K[Grid K]
  K --> L[Grid L]`;
const narrow = 'flowchart TD\n  A[Start] --> B[End]';
const content: DocumentContent = {
  schemaVersion: 2,
  blocks: [
    { id: 'title', type: 'heading', level: 1, text: 'Grid design' },
    { id: 'wide', type: 'mermaid', text: wide },
    { id: 'narrow', type: 'mermaid', text: narrow },
  ],
};

test.use({ viewport: { width: 1440, height: 900 } });
test('a wide Mermaid diagram shows at its own size with sideways scrolling and a Fit to width switch', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'grid-design.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ ...createArtifact('document', 'Grid design', content), annotations: [] }),
    ),
  });
  const [wideBlock, narrowBlock] = [
    page.locator('[data-block-id="wide"]'),
    page.locator('[data-block-id="narrow"]'),
  ];
  const image = wideBlock.getByRole('img', { name: 'Mermaid diagram' });
  await expect(image).toBeVisible({ timeout: 20000 });
  await expect(narrowBlock.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  const before = (await nativeArtifact(page)).draft;
  const scroller = wideBlock.locator('.ep-diagram-scroll');
  const room = await scroller.evaluate((e) => e.clientWidth);
  // Actual size by default: wider than the page, so the frame scrolls sideways.
  await expect(wideBlock.getByRole('button', { name: 'Actual size', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const natural = (await image.boundingBox())!.width;
  expect(natural).toBeGreaterThan(room);
  expect(await scroller.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await scroller.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  expect(await scroller.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0);
  // Fit to width shrinks it into the page; Actual size brings the own size back.
  await wideBlock.getByRole('button', { name: 'Fit to width', exact: true }).click();
  expect((await image.boundingBox())!.width).toBeLessThanOrEqual(room + 1);
  expect(await scroller.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await wideBlock.getByRole('button', { name: 'Actual size', exact: true }).click();
  expect(Math.abs((await image.boundingBox())!.width - natural)).toBeLessThan(1);
  // A diagram that fits offers no switch.
  await expect(narrowBlock.getByRole('button', { name: 'Fit to width' })).toHaveCount(0);
  // Switching is view state only: content and history are unchanged.
  const after = (await nativeArtifact(page)).draft;
  expect(after.content).toEqual(before.content);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
