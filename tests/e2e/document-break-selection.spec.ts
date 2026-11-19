import { test, expect, create, setDocumentText, nativeArtifact } from './fixtures';

for (const shared of [false, true])
  test(`Document ${shared ? 'shared' : 'local'} hard break uses the visible collapsed selection`, async ({
    page,
  }) => {
    await page.goto('/');
    await create(page, 'document');
    await setDocumentText(page, 'p', 'a`b');
    if (shared) {
      await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
      await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    }
    const body = page.getByRole('textbox', { name: 'Document body', exact: true });
    const paragraph = body.locator('p').last();
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await body.press('Control+`');
    await expect(paragraph.locator('code')).toHaveText('a`b');
    // A native caret move may precede its asynchronous selectionchange. Keep
    // collapse and the next command in one task to reproduce the old stale range.
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      element.closest('[role="textbox"]')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(paragraph).toHaveText('a`b');
    await expect(paragraph.locator('br:not(.ProseMirror-trailingBreak)')).toHaveCount(1);
    await page.keyboard.insertText('c');
    await expect(paragraph.locator('code')).toHaveText(['a`b', 'c']);
    const content = JSON.stringify((await nativeArtifact(page)).draft.content);
    expect(content).toContain('a`b');
    expect(content).toContain('c');
  });
