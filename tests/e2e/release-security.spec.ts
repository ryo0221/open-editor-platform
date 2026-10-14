import { PDFDocument } from 'pdf-lib';
import { create, insertDoc, replaceFileSource, test, expect } from './fixtures';

test('release Mermaid entry renders a math label through the ordinary Document editor', async ({
  page,
}) => {
  await page.goto('/');
  await create(page);
  await insertDoc(page, 'Mermaid');
  await page
    .getByLabel('Mermaid source', { exact: true })
    .fill('flowchart LR\n A["$$x^2 + y^2$$"] --> B["Math"]');
  await page.getByLabel('Mermaid source', { exact: true }).press('Tab');
  const image = page.getByRole('img', { name: 'Mermaid diagram', exact: true });
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const source = await image.getAttribute('src');
        return source
          ? decodeURIComponent(source.slice(source.indexOf(',') + 1)).includes('<math')
          : false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('release PDF core viewer renders a scripted document without executing its JavaScript', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]).drawText('Script-free PDF rendering', { x: 20, y: 100 });
  pdf.addJavaScript('release-test', 'globalThis.__releasePdfScriptExecuted = true;');
  await page.addInitScript(() => {
    (
      globalThis as typeof globalThis & { __releasePdfScriptExecuted?: boolean }
    ).__releasePdfScriptExecuted = false;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New File Viewer', exact: true }).click();
  await replaceFileSource(page, {
    name: 'scripted-regression.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
    'data-rendered',
    'true',
    { timeout: 60_000 },
  );
  expect(
    await page.evaluate(
      () =>
        (globalThis as typeof globalThis & { __releasePdfScriptExecuted?: boolean })
          .__releasePdfScriptExecuted,
    ),
  ).toBe(false);
});
