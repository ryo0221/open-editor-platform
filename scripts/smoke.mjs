import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { log } from 'node:console';
const browser = await chromium.launch(
  existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(process.env.EDITOR_BASE_URL || 'http://127.0.0.1:5173');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.getByRole('button', { name: 'New Document', exact: true }).click();
  await page.locator('.ProseMirror h1').evaluate((heading) => {
    heading.closest('.ProseMirror').focus();
    const doc = heading.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(heading);
    const selection = doc.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
  });
  await page.keyboard.insertText('Cloud readiness check');
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Insert document block' })
    .getByRole('button', { name: 'Mermaid', exact: true })
    .click();
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version' })
    .getByRole('button', { name: 'Save version', exact: true })
    .click();
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'History (1)', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  await page.reload();
  await expect(page.locator('.ProseMirror h1')).toHaveText('Cloud readiness check');
  await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
  expect(errors).toEqual([]);
  log(
    'PASS: page startup, document edit, Mermaid render, version save and IndexedDB reload; zero browser errors.',
  );
} finally {
  await browser.close();
}
