import { strFromU8, unzipSync } from 'fflate';
import { test, expect, nativeArtifact, setDocumentText } from './fixtures';
import { artifactMenu } from './template-fixtures';
import type { Page } from '@playwright/test';
import { confirmed, monitor, value } from './practical-fixtures';
import {
  officeDocument,
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
  docxReport,
} from './office-docx-fixtures';
import { officeDownload } from './office-fixtures';

async function hostAction(page: Page, action: string) {
  // Escape in the modeless Office panel intentionally closes it. Focus the Host menu first.
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).focus();
  await artifactMenu(page, action);
}

test('D10 shared DOCX fixes the captured revision and preserves pending/rejected/proposal guards', async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  await importOfficeDocument(page, officeDocument());
  await hostAction(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } }),
    peer = await context.newPage();
  const errors = monitor(peer);
  await peer.goto(page.url().replace('actor=A', 'actor=B'));
  await confirmed(peer);
  let dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const original = await docxReport(page, dialog);
  await setDocumentText(peer, 'h1', '共同編集後の文書');
  await confirmed(peer);
  await expect(dialog.getByText(/artifact changed after this preview/)).toBeVisible();
  const submissions: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/submit?')) submissions.push(r.postData() ?? '');
  });
  const oldBytes = await officeDownload(page, dialog, 'Download DOCX');
  expect(strFromU8(unzipSync(oldBytes)['word/document.xml'])).toContain('日本語の編集可能な文書');
  expect((await docxReport(page, dialog)).basis).toEqual(original.basis);
  await prepareDocx(dialog);
  await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).not.toBeChecked();
  await acceptDocx(dialog);
  const newBytes = await officeDownload(page, dialog, 'Download DOCX');
  expect(strFromU8(unzipSync(newBytes)['word/document.xml'])).toContain('共同編集後の文書');
  const latest = await docxReport(page, dialog);
  expect(
    latest.basis.kind === 'confirmed' &&
      original.basis.kind === 'confirmed' &&
      latest.basis.revision > original.basis.revision,
  ).toBe(true);
  expect(submissions).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await hostAction(page, 'Pause transport (reference)');
  await page.keyboard.press('Escape');
  await value(page, 'Page margin', '80');
  await expect(page.locator('.save-status')).toContainText('pending');
  await dialog.getByRole('button', { name: 'Refresh DOCX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await expect(page.getByLabel('Page margin', { exact: true })).toHaveValue('80');
  await value(peer, 'Page margin', '100');
  await confirmed(peer);
  await hostAction(page, 'Resume transport (reference)');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('Rejected');
  await dialog.getByRole('button', { name: 'Prepare DOCX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await page.screenshot({ path: info.outputPath('docx-rejected-input.png'), fullPage: true });
  await hostAction(page, 'Discard retained input');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const before = await nativeArtifact(page);
  await hostAction(page, 'Agent proposal demo');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Shared proposal preview' })).toBeVisible();
  // Document remounts its text engine for proposal previews; export cleanup cancels its job.
  await expect(dialog).toHaveCount(0);
  dialog = await openDocx(page);
  await dialog.getByRole('button', { name: 'Prepare DOCX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await page.getByRole('button', { name: 'Reject shared proposal', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  dialog = await openDocx(page);
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  await officeDownload(page, dialog, 'Download DOCX');
  await dialog.getByRole('button', { name: 'Close DOCX export', exact: true }).click();
  expect(await nativeArtifact(page)).toEqual(before);
  const injected = await peer.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    return { ...JSON.parse(sessionStorage.getItem(key)!), domain: 'document' };
  });
  await peer.goto('/embed.html');
  await peer.evaluate(
    (config) => sessionStorage.setItem('ep-independent-host', JSON.stringify(config)),
    injected,
  );
  await peer.reload();
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  const hostDialog = await openDocx(peer);
  await prepareDocx(hostDialog);
  await acceptDocx(hostDialog);
  await officeDownload(peer, hostDialog, 'Download DOCX');
  expect((await docxReport(peer, hostDialog)).basis.kind).toBe('confirmed');
  await expect(peer.getByLabel('Host versions')).toContainText('0 saved version(s)');
  await expect(peer.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await context.close();
  expect(errors).toEqual([]);
});

test('D10 unfinished Document composition retains the DOM buffer until capture can resume', async ({
  page,
}, info) => {
  await importOfficeDocument(page, officeDocument());
  const dialog = await openDocx(page);
  await dialog.getByRole('button', { name: 'Minimize DOCX export', exact: true }).click();
  await setDocumentText(page, 'h1', '未確定の入力を保持');
  const editor = page.getByRole('textbox', { name: 'Document body', exact: true });
  await editor.dispatchEvent('compositionstart', { data: '保持' });
  // Browser IME mutates the composing DOM before the text engine has committed it.
  await editor.locator('h1').evaluate((node) => {
    node.textContent = '変換中の日本語を保持';
    node.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertCompositionText',
        data: '保持',
        isComposing: true,
      }),
    );
  });
  await dialog.getByRole('button', { name: 'Expand DOCX export', exact: true }).click();
  await dialog.getByRole('button', { name: 'Prepare DOCX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Finish text composition');
  await expect(editor.locator('h1')).toHaveText('変換中の日本語を保持');
  await page.screenshot({ path: info.outputPath('docx-ime-retained.png'), fullPage: true });
  await editor.dispatchEvent('compositionend', { data: '保持' });
  await prepareDocx(dialog);
  await acceptDocx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download DOCX');
  expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toContain('変換中の日本語を保持');
});
