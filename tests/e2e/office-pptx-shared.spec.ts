import { strFromU8, unzipSync } from 'fflate';
import { test, expect, nativeArtifact } from './fixtures';
import { artifactMenu } from './template-fixtures';
import type { Page } from '@playwright/test';
import { confirmed, monitor, value } from './practical-fixtures';
import {
  officeDeck,
  importOfficeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
  reportDownload,
} from './office-fixtures';

async function hostAction(page: Page, action: string) {
  // Escape in the modeless Office panel intentionally closes it. Focus the Host menu first.
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).focus();
  await artifactMenu(page, action);
}

test('G10 shared PPTX fixes the captured revision and preserves pending/rejected/proposal guards', async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  await importOfficeDeck(page, officeDeck());
  await hostAction(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } }),
    peer = await context.newPage();
  const errors = monitor(peer);
  await peer.goto(page.url().replace('actor=A', 'actor=B'));
  await confirmed(peer);
  const dialog = await openPptx(page);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const original = await reportDownload(page, dialog);
  await value(peer, 'Slide background', '#ddeeff');
  await confirmed(peer);
  await expect(dialog.getByText(/artifact changed after this preview/)).toBeVisible();
  const submissions: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/submit?')) submissions.push(r.postData() ?? '');
  });
  const oldBytes = await officeDownload(page, dialog, 'Download PPTX');
  expect(strFromU8(unzipSync(oldBytes)['ppt/slides/slide1.xml'])).toContain(
    '<a:srgbClr val="FFFFFF"',
  );
  expect((await reportDownload(page, dialog)).basis).toEqual(original.basis);
  await preparePptx(dialog);
  await expect(dialog.getByRole('checkbox', { name: /I accept all/ })).not.toBeChecked();
  await acceptPptx(dialog);
  const newBytes = await officeDownload(page, dialog, 'Download PPTX');
  expect(strFromU8(unzipSync(newBytes)['ppt/slides/slide1.xml'])).toContain(
    '<a:srgbClr val="DDEEFF"',
  );
  const latest = await reportDownload(page, dialog);
  expect(
    latest.basis.kind === 'confirmed' &&
      original.basis.kind === 'confirmed' &&
      latest.basis.revision > original.basis.revision,
  ).toBe(true);
  expect(submissions).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await hostAction(page, 'Pause transport (reference)');
  await page.keyboard.press('Escape');
  await value(page, 'Slide background', '#123456');
  await expect(page.locator('.save-status')).toContainText('pending');
  await dialog.getByRole('button', { name: 'Refresh PPTX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await expect(page.getByLabel('Slide background', { exact: true })).toHaveValue('#123456');
  await value(peer, 'Slide background', '#654321');
  await confirmed(peer);
  await hostAction(page, 'Resume transport (reference)');
  await page.keyboard.press('Escape');
  await expect(page.locator('.save-status')).toContainText('Rejected');
  await dialog.getByRole('button', { name: 'Prepare PPTX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await page.screenshot({ path: info.outputPath('pptx-rejected-input.png'), fullPage: true });
  await hostAction(page, 'Discard retained input');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const before = await nativeArtifact(page);
  await hostAction(page, 'Agent proposal demo');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Shared proposal preview' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Prepare PPTX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm or resolve pending edits');
  await page.getByRole('button', { name: 'Reject shared proposal', exact: true }).click();
  await preparePptx(dialog);
  await acceptPptx(dialog);
  await officeDownload(page, dialog, 'Download PPTX');
  await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
  expect(await nativeArtifact(page)).toEqual(before);
  const injected = await peer.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('ep-shared-host:'))!;
    return { ...JSON.parse(sessionStorage.getItem(key)!), domain: 'slide' };
  });
  await peer.goto('/embed.html');
  await peer.evaluate(
    (config) => sessionStorage.setItem('ep-independent-host', JSON.stringify(config)),
    injected,
  );
  await peer.reload();
  await expect(peer.getByLabel('Host sync status')).toContainText('confirmed');
  const hostDialog = await openPptx(peer);
  await preparePptx(hostDialog);
  await acceptPptx(hostDialog);
  await officeDownload(peer, hostDialog, 'Download PPTX');
  expect((await reportDownload(peer, hostDialog)).basis.kind).toBe('confirmed');
  await expect(peer.getByLabel('Host versions')).toContainText('0 saved version(s)');
  await expect(peer.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
  await context.close();
  expect(errors).toEqual([]);
});

test('G10 unfinished composition blocks PPTX capture while keeping the local text buffer', async ({
  page,
}, info) => {
  await importOfficeDeck(page, officeDeck());
  const dialog = await openPptx(page);
  await page
    .getByRole('application', { name: 'Slide canvas', exact: true })
    .getByRole('button')
    .filter({ hasText: '日本語の編集可能な資料' })
    .dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+a');
  await page.keyboard.insertText('未確定の入力を保持');
  await editor.dispatchEvent('compositionstart', { data: '保持' });
  await dialog.getByRole('button', { name: 'Prepare PPTX preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Finish text composition');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('未確定の入力を保持');
  await page.screenshot({ path: info.outputPath('pptx-ime-retained.png'), fullPage: true });
  await editor.dispatchEvent('compositionend', { data: '保持' });
  await editor.press('Control+Enter');
  await expect(editor).toHaveCount(0);
  await preparePptx(dialog);
  await acceptPptx(dialog);
  const bytes = await officeDownload(page, dialog, 'Download PPTX');
  expect(strFromU8(unzipSync(bytes)['ppt/slides/slide1.xml'])).toContain('未確定の入力を保持');
});
