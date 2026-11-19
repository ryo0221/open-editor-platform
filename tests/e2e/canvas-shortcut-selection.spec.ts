import { test, expect, create, nativeArtifact } from './fixtures';

for (const kind of ['slide', 'whiteboard', 'design'])
  for (const shared of [false, true])
    test(`${kind} ${shared ? 'shared' : 'local'} formatting uses the visible selection before selectionchange`, async ({
      page,
    }) => {
      await page.goto('/');
      await create(page, kind);
      await page.getByRole('button', { name: 'Insert text', exact: true }).click();
      if (shared) {
        await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
        await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
      }
      const canvas = page.getByRole('application', {
        name: `${kind[0].toUpperCase() + kind.slice(1)} canvas`,
        exact: true,
      });
      await canvas
        .getByRole('button')
        .filter({ has: page.locator('text') })
        .first()
        .dblclick();
      const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
      await expect(editor).toBeVisible();
      for (const [key, tag] of [
        ['b', 'strong'],
        ['i', 'em'],
        ['u', 'u'],
      ]) {
        await editor.press('Control+Home');
        // Reproduce the browser ordering: the DOM range changes before the
        // asynchronous selectionchange reaches the engine. Keep both events in
        // one task so this regression does not depend on machine speed.
        const first = await editor.evaluate((node, key) => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text = walker.nextNode();
          while (text && (!text.textContent || text.parentElement?.closest('[data-presence]')))
            text = walker.nextNode();
          if (!text?.textContent) throw Error('Expected editable canvas text');
          const first = text.textContent[0];
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          if (key === 'i') selection.setBaseAndExtent(text, 1, text, 0);
          else selection.addRange(range);
          node.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              code: `Key${key.toUpperCase()}`,
              keyCode: key.toUpperCase().charCodeAt(0),
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          return first;
        }, key);
        await expect(editor.locator(tag)).toContainText(first);
      }
      // A normal Select All remains supported, including its document boundaries.
      await editor.press('Control+a');
      await editor.press('Control+b');
      await expect(editor.locator('strong')).toHaveCount(0);
      await editor.press('Control+b');
      await expect(editor.locator('strong')).not.toHaveCount(0);
      await editor.press('Control+Enter');
      await expect(editor).toHaveCount(0);
      const saved = JSON.stringify((await nativeArtifact(page)).draft.content);
      for (const mark of ['bold', 'italic', 'underline']) expect(saved).toContain(`"${mark}":true`);
    });
