import { test, expect } from './fixtures';
import { officeDownload } from './office-fixtures';
import {
  officeDocument,
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
  docxReport,
} from './office-docx-fixtures';

test('D10 export completion during a Cancel pointer press cannot start a new preparation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { prepareCount: 0, ready: false, release: () => {} };
    Object.assign(window, { officeCompletionRace: state });
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (event.data?.status !== 'encoded') return;
          event.stopImmediatePropagation();
          state.ready = true;
          state.release = () => this.onmessage?.call(this, event);
        });
      }
      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions,
      ) {
        if ((message as { action?: string })?.action === 'prepare') state.prepareCount++;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  await importOfficeDocument(page, officeDocument());
  const dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  await dialog.getByRole('button', { name: 'Download DOCX', exact: true }).click();
  const button = dialog.getByRole('button', { name: 'Cancel export', exact: true });
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Hold only delivery of the real Worker result, then finish while the pointer is down.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { officeCompletionRace: { ready: boolean } })
            .officeCompletionRace.ready,
      ),
    )
    .toBe(true);
  const downloaded = page.waitForEvent('download');
  await page.evaluate(() =>
    (
      window as typeof window & { officeCompletionRace: { release: () => void } }
    ).officeCompletionRace.release(),
  );
  await downloaded;
  await page.mouse.up();
  await expect(dialog.getByText('DOCX downloaded.', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { officeCompletionRace: { prepareCount: number } })
          .officeCompletionRace.prepareCount,
    ),
  ).toBe(1);
});

test('D10 DOCX over-limit input cannot be accepted or downloaded', async ({ page }) => {
  const source = officeDocument();
  source.blocks = Array.from({ length: 2001 }, (_, i) => ({
    id: `p-${i}`,
    type: 'paragraph',
    text: '上限の検証',
  }));
  await importOfficeDocument(page, source);
  const dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const report = await docxReport(page, dialog);
  expect(
    report.diagnostics.some((d) => d.severity === 'error' && d.code === 'LIMIT_EXCEEDED'),
  ).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Download DOCX', exact: true })).toBeDisabled();
});

test('D08/D10 a failed diagram renderer retries and cancelling its frame prevents late output', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const source = officeDocument();
  source.blocks.push({
    id: 'diagram',
    type: 'mermaid',
    text: 'flowchart LR\n A[受付] --> B[完了]',
  });
  await importOfficeDocument(page, source);
  const dialog = await openDocx(page);
  await dialog.getByLabel('DOCX Mermaid', { exact: true }).selectOption('image');
  await context.route('**/index_bg-*.wasm', (r) =>
    r.fulfill({ contentType: 'application/wasm', body: Buffer.from('broken') }),
  );
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  expect(
    (await docxReport(page, dialog)).diagnostics.some(
      (d) => d.code === 'MERMAID_FAILED' && d.severity === 'error',
    ),
  ).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Download DOCX', exact: true })).toBeDisabled();
  await context.unroute('**/index_bg-*.wasm');
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  await expect(dialog.getByLabel('DOCX counts')).toContainText('Errors: 0');
  expect((await officeDownload(page, dialog, 'Download DOCX')).length).toBeGreaterThan(1000);
  let seen = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route('**/office-mermaid.html', async (r) => {
    seen = true;
    await held;
    await r.continue().catch(() => {});
  });
  await dialog.getByRole('button', { name: 'Refresh DOCX preview', exact: true }).click();
  await expect.poll(() => seen).toBe(true);
  const files: string[] = [];
  page.on('download', (d) => files.push(d.suggestedFilename()));
  await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(page.locator('iframe[title="Office diagram rendering"]')).toHaveCount(0);
  release();
  await context.unroute('**/office-mermaid.html');
  await page.waitForTimeout(1200);
  expect(files).toEqual([]);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  await officeDownload(page, dialog, 'Download DOCX');
  expect(files.filter((f) => f.endsWith('.docx'))).toHaveLength(1);
});
