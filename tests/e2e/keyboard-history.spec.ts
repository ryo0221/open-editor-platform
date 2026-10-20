import {
  test,
  expect,
  create,
  addRecord,
  editCell,
  save,
  setDocumentText,
  insertDoc,
} from './fixtures';
import { readFile } from 'node:fs/promises';
import { artifactMenu } from './template-fixtures';
import { confirmed, monitor } from './practical-fixtures';
import type { Page } from '@playwright/test';

const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: 'Redo', exact: true });
async function action(page: Page, label: string) {
  await artifactMenu(page, label);
  await page.keyboard.press('Escape');
}
async function append(page: Page, value: string) {
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await body.press('Control+End');
  await page.keyboard.insertText(value);
  await expect(body).toContainText(value);
  return body;
}

for (const mod of ['Control', 'Meta']) {
  test(`#299 Document ${mod} history matches buttons and new input discards Redo`, async ({
    page,
  }) => {
    await page.goto('/');
    await create(page, 'document');
    const body = await append(page, ' keyboard-299');
    await body.press(`${mod}+z`);
    await expect(body).not.toContainText('keyboard-299');
    await body.press(`${mod}+y`);
    await expect(body).toContainText('keyboard-299');
    await undo(page).click();
    await expect(body).not.toContainText('keyboard-299');
    await body.press(`${mod}+Shift+z`);
    await expect(body).toContainText('keyboard-299');
    await undo(page).click();
    await append(page, ' replacement-299');
    await expect(redo(page)).toBeDisabled();
    await body.press(`${mod}+z`);
    await expect(body).not.toContainText('replacement-299');
    await redo(page).click();
    await expect(body).toContainText('replacement-299');
    await save(page, 1);
    await page.reload();
    await expect(body).toContainText('replacement-299');
  });

  test(`#299 Data ${mod} grid history matches buttons and input Undo stays in its cell`, async ({
    page,
  }) => {
    await page.goto('/');
    await create(page, 'data');
    await addRecord(page);
    const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
    const cell = page.getByRole('gridcell', { name: 'Name · record 1', exact: true });
    await editCell(page, 'Name', 1, 'committed-299');
    await grid.press(`${mod}+z`);
    await expect(cell).not.toHaveText('committed-299');
    await grid.press(`${mod}+y`);
    await expect(cell).toHaveText('committed-299');
    await undo(page).click();
    await expect(cell).not.toHaveText('committed-299');
    await grid.press(`${mod}+Shift+z`);
    await expect(cell).toHaveText('committed-299');
    await cell.dblclick();
    const input = page.getByLabel('Edit Name', { exact: true });
    await input.press('End');
    await input.press('x');
    // Chromium on Linux implements native input Undo with Control.
    await input.press('Control+z');
    await expect(input).toHaveValue('committed-299');
    await expect(redo(page)).toBeDisabled();
    await input.press('Escape');
    await grid.press(`${mod}+z`);
    await expect(cell).not.toHaveText('committed-299');
  });
}

test('#299 Document composition and read-only do not invoke Host history', async ({ page }) => {
  await page.goto('/');
  await create(page, 'document');
  const body = await append(page, ' keep-299');
  await body.dispatchEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true });
  await expect(body).toContainText('keep-299');
  await expect(redo(page)).toBeDisabled();
  await body.press('Control+f');
  const find = page.getByLabel('Find text', { exact: true });
  await find.press('x');
  await find.press('Control+z');
  await expect(find).toHaveValue('');
  await expect(body).toContainText('keep-299');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Read only', exact: true }).check();
  await page.keyboard.press('Escape');
  await body.press('Control+z');
  await expect(body).toContainText('keep-299');
  await expect(body).toHaveAttribute('aria-readonly', 'true');
});

test('#299 Data composition and read-only retain the committed grid', async ({ page }) => {
  await page.goto('/');
  await create(page, 'data');
  await addRecord(page);
  await editCell(page, 'Name', 1, 'protected-299');
  const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
  await grid.dispatchEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true });
  await expect(grid).toContainText('protected-299');
  await expect(redo(page)).toBeDisabled();
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Read only', exact: true }).check();
  await page.keyboard.press('Escape');
  await grid.press('Control+z');
  await expect(grid).toContainText('protected-299');
});

for (const mac of [false, true])
  for (const mark of ['strike', 'code'] as const)
    test(`#299 read-only ${mark} does not affect later typing (${mac ? 'Mac keys' : 'Control keys'})`, async ({
      page,
    }, info) => {
      if (mac)
        await page.addInitScript(() =>
          Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }),
        );
      await page.goto('/');
      await create(page, 'document');
      const body = await append(page, ' readonly-caret-299');
      const more = page.getByRole('button', { name: 'More artifact actions', exact: true });
      const readonly = page.getByRole('checkbox', { name: 'Read only', exact: true });
      await more.click();
      await readonly.check();
      await page.keyboard.press('Escape');
      await expect(body).toHaveAttribute('aria-readonly', 'true');
      const key =
        mark === 'strike'
          ? `${mac ? 'Meta' : 'Control'}+Shift+x`
          : mac
            ? 'Control+Shift+c'
            : 'Control+`';
      // A Host can revoke edit permission while the editor retains its caret.
      // Dispatch on that Surface even though contenteditable=false cannot regain focus.
      await body.dispatchEvent('keydown', {
        key: mark === 'strike' ? 'x' : mac ? 'c' : '`',
        keyCode: mark === 'strike' ? 88 : mac ? 67 : 192,
        ctrlKey: !mac || mark === 'code',
        metaKey: mac && mark === 'strike',
        shiftKey: mark === 'strike' || mac,
      });
      await page.getByRole('button', { name: 'More formatting', exact: true }).click();
      const button = page.getByRole('button', {
        name: mark === 'strike' ? 'Strikethrough' : 'Inline code',
        exact: true,
      });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await page.keyboard.press('Escape');
      await more.click();
      await readonly.uncheck();
      await page.keyboard.press('Escape');
      await expect(body).toHaveAttribute('aria-readonly', 'false');
      await body.press('q');
      await expect(body).toContainText('readonly-caret-299q');
      await expect(
        body.locator(mark === 'strike' ? 's' : 'code').filter({ hasText: 'q' }),
      ).toHaveCount(0);
      // The same shortcut becomes effective once the Host allows editing again.
      await body.press(key);
      await body.press('w');
      await expect(body.locator(mark === 'strike' ? 's' : 'code')).toHaveText('w');
      await page.screenshot({ path: info.outputPath(`readonly-${mark}-${mac}.png`) });
    });

for (const mac of [false, true])
  test(`#299 Document marks, link dialog and line break persist (${mac ? 'Mac keys' : 'Control keys'})`, async ({
    page,
  }, info) => {
    if (mac)
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }),
      );
    const mod = mac ? 'Meta' : 'Control';
    await page.goto('/');
    await create(page, 'document');
    const body = await append(page, ' link299');
    await body
      .locator('p')
      .last()
      .evaluate((element) => {
        const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null,
          last: Node | null = null;
        while ((node = walker.nextNode())) last = node;
        const range = element.ownerDocument.createRange();
        range.setStart(last!, last!.textContent!.length - 7);
        range.setEnd(last!, last!.textContent!.length);
        const selection = element.ownerDocument.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        element.ownerDocument.dispatchEvent(new Event('selectionchange'));
      });
    await expect.poll(() => body.evaluate(() => window.getSelection()?.toString())).toBe('link299');
    await body.press(`${mod}+Shift+x`);
    await expect(body.locator('s')).toHaveText('link299');
    if (mac) {
      await body.press('Meta+`');
      await expect(body.locator('code')).toHaveCount(0);
    }
    await body.press(mac ? 'Control+Shift+c' : 'Control+`');
    await expect(body.locator('code')).toHaveText('link299');
    await body.press(`${mod}+k`);
    const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
    const url = dialog.getByLabel('Link URL', { exact: true });
    await url.fill('https://example.com/299');
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/299');
    await expect(body).toBeFocused();
    await body.press(`${mod}+k`);
    await expect(url).toHaveValue('https://example.com/299');
    await url.fill('https://example.com/updated-299');
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/updated-299');
    await expect(body.locator('a')).toHaveText('link299');
    await body.press(`${mod}+k`);
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/updated-299');
    await undo(page).click();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/299');
    await redo(page).click();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/updated-299');
    await body.press(`${mod}+k`);
    await page.keyboard.press('Escape');
    await expect(body).toBeFocused();
    await body.locator('p').last().click();
    await body.press('End');
    const paragraphs = await body.locator('p').count();
    await body.press('Shift+Enter');
    await page.keyboard.insertText('after-break-299');
    await expect(body.locator('p')).toHaveCount(paragraphs);
    await expect(body.locator('br').first()).toBeAttached();
    await save(page, 1);
    await page.reload();
    await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/updated-299');
    await expect(body).toContainText('after-break-299');
    await page.screenshot({ path: info.outputPath('document-shortcuts.png') });
  });

for (const edge of ['start', 'end'] as const)
  test(`#299 link dialog edits the existing URL at a collapsed ${edge} caret`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, 'document');
    await setDocumentText(page, 'p', 'linked');
    const body = page.getByRole('textbox', { name: 'Document body', exact: true });
    const paragraph = body.locator('p').last();
    await body.focus();
    await paragraph.evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(page.getByRole('combobox', { name: 'Text style', exact: true })).toHaveValue(
      'paragraph',
    );
    await body.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
    const url = dialog.getByLabel('Link URL', { exact: true });
    await url.fill('https://example.com/original-edge');
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await expect(paragraph.locator('a')).toHaveText('linked');
    await body.focus();
    await paragraph.evaluate((element, start) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(start);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, edge === 'start');
    await expect
      .poll(() =>
        paragraph.evaluate((element) => {
          const selection = element.ownerDocument.getSelection();
          if (
            !selection?.isCollapsed ||
            !selection.anchorNode ||
            !element.contains(selection.anchorNode)
          )
            return -1;
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          range.setEnd(selection.anchorNode, selection.anchorOffset);
          return range.toString().length;
        }),
      )
      .toBe(edge === 'start' ? 0 : 6);
    await body.press('Control+k');
    await expect(url).toHaveValue('https://example.com/original-edge');
    await url.fill('https://example.com/updated-edge');
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await expect(paragraph.locator('a')).toHaveCount(1);
    await expect(paragraph.locator('a')).toHaveAttribute(
      'href',
      'https://example.com/updated-edge',
    );
    await expect(paragraph).toHaveText('linked');
    await undo(page).click();
    await expect(paragraph.locator('a')).toHaveAttribute(
      'href',
      'https://example.com/original-edge',
    );
    await redo(page).click();
    await expect(paragraph.locator('a')).toHaveAttribute(
      'href',
      'https://example.com/updated-edge',
    );
    await save(page, 1);
    await page.reload();
    await expect(paragraph.locator('a')).toHaveText('linked');
    await expect(paragraph.locator('a')).toHaveAttribute(
      'href',
      'https://example.com/updated-edge',
    );
    await page.screenshot({ path: info.outputPath(`link-${edge}-caret.png`) });
  });

for (const remove of [false, true])
  test(`#299 stored-only link reopens before typing (${remove ? 'remove' : 'update'})`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, 'document');
    await setDocumentText(page, 'p', 'plain');
    const body = page.getByRole('textbox', { name: 'Document body', exact: true });
    await body.press('Control+End');
    await body.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
    const url = dialog.getByLabel('Link URL', { exact: true });
    await url.fill('https://example.com/pending');
    await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    await body.press('Control+k');
    await expect(url).toHaveValue('https://example.com/pending');
    if (remove) await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
    else {
      await url.fill('https://example.com/pending-updated');
      await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
      await body.press('Control+k');
      await expect(url).toHaveValue('https://example.com/pending-updated');
      await dialog.getByRole('button', { name: 'Apply link', exact: true }).click();
    }
    const paragraph = body.locator('p').last();
    await expect(body).toBeFocused();
    await expect
      .poll(() =>
        paragraph.evaluate((element) => {
          const selection = element.ownerDocument.getSelection();
          if (
            !selection?.isCollapsed ||
            !selection.anchorNode ||
            !element.contains(selection.anchorNode)
          )
            return -1;
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          range.setEnd(selection.anchorNode, selection.anchorOffset);
          return range.toString().length;
        }),
      )
      .toBe(5);
    await page.keyboard.insertText('X');
    await expect(paragraph).toHaveText('plainX');
    if (remove) await expect(paragraph.locator('a')).toHaveCount(0);
    else {
      await expect(paragraph.locator('a')).toHaveText('X');
      await expect(paragraph.locator('a')).toHaveAttribute(
        'href',
        'https://example.com/pending-updated',
      );
    }
    await save(page, 1);
    await page.reload();
    await expect(paragraph).toHaveText('plainX');
    await expect(paragraph.locator('a')).toHaveCount(remove ? 0 : 1);
    if (!remove)
      await expect(paragraph.locator('a')).toHaveAttribute(
        'href',
        'https://example.com/pending-updated',
      );
    await page.screenshot({ path: info.outputPath(`pending-link-${remove}.png`) });
  });

test('#299 code containing backticks exports and imports a hard break', async ({ page }, info) => {
  await page.goto('/');
  await create(page, 'document');
  await setDocumentText(page, 'p', 'a`b');
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  const paragraph = body.locator('p').last();
  await paragraph.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
  await body.press('Control+`');
  await expect(paragraph.locator('code')).toHaveText('a`b');
  await body.press('ArrowRight');
  await body.press('Shift+Enter');
  await page.keyboard.insertText('c');
  await expect(paragraph.locator('code')).toHaveText(['a`b', 'c']);
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.toString()).toContain('``a`b``<br/>`c`');
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name: 'code-break.md', mimeType: 'text/markdown', buffer: bytes });
  // Inline-code formatting remains outside the bounded Markdown reader's scope.
  await expect(paragraph).toHaveText('``a`b```c`');
  await expect(paragraph.locator('br')).toHaveCount(1);
  await save(page, 1);
  await page.reload();
  await expect(paragraph).toHaveText('``a`b```c`');
  await expect(paragraph.locator('br')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('code-backtick-break.png') });
});

test('#299 Markdown download and import preserve literal backticks, entities and breaks', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'document');
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  const first = '`<br/>` and ``a & b &amp;``';
  const last = 'C:\\path\\file \\`<br/>`';
  await setDocumentText(page, 'h1', first);
  await body.locator('h1').click();
  await body.press('End');
  await body.press('Shift+Enter');
  await page.keyboard.insertText(last);
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.toString()).toContain('\\`&lt;br/>\\`');
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name: 'literals.md', mimeType: 'text/markdown', buffer: bytes });
  await expect(body.locator('h1')).toHaveText(first + last);
  await expect(body.locator('h1 br')).toHaveCount(1);
  await expect(body.locator('h1 code')).toHaveCount(0);
  await save(page, 1);
  await page.reload();
  await expect(body.locator('h1')).toHaveText(first + last);
  await expect(body.locator('h1 br')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('markdown-literals-roundtrip.png') });
});

test('#299 Markdown download and import retain heading and list hard breaks', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'document');
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await setDocumentText(page, 'h1', 'heading-first');
  await body.locator('h1').click();
  await body.press('End');
  await body.press('Shift+Enter');
  await page.keyboard.insertText('heading-second');
  await expect(body.locator('h1')).toHaveText('heading-firstheading-second');
  await insertDoc(page, 'Bulleted list');
  await setDocumentText(page, 'li p', 'item-first');
  await body.locator('li p').first().click();
  await body.press('End');
  await body.press('Shift+Enter');
  await page.keyboard.insertText('item-second');
  await body.press('Enter');
  await page.keyboard.insertText('next-item');
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.toString()).toContain('# heading-first<br/>heading-second');
  expect(bytes.toString()).toContain('- item-first<br/>item-second');
  await page.keyboard.press('Escape');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name: 'breaks.md', mimeType: 'text/markdown', buffer: bytes });
  await expect(body.locator('h1')).toHaveCount(1);
  await expect(body.locator('h1')).toHaveText('heading-firstheading-second');
  await expect(body.locator('h1 br')).toHaveCount(1);
  await expect(body.locator('li')).toHaveCount(2);
  await expect(body.locator('li').first()).toHaveText('item-firstitem-second');
  await expect(body.locator('li').first().locator('br')).toHaveCount(1);
  await expect(body.locator('li').last()).toHaveText('next-item');
  await page.screenshot({ path: info.outputPath('markdown-breaks-roundtrip.png') });
});

for (const kind of ['slide', 'design', 'whiteboard'] as const)
  test(`#299 ${kind} private text history and committed Host history stay separate`, async ({
    page,
  }, info) => {
    await page.goto('/');
    await create(page, kind);
    await page.getByRole('button', { name: 'Insert text', exact: true }).click();
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
    const original = await editor.textContent();
    await editor.press('Control+a');
    await page.keyboard.insertText('canvas-299');
    await editor.press('Control+z');
    await expect(editor).toHaveJSProperty('textContent', original);
    await editor.press('Control+y');
    await expect(editor).toHaveText('canvas-299');
    await editor.press('Control+z');
    await editor.press('Control+Shift+z');
    await expect(editor).toHaveText('canvas-299');
    await editor.press('Control+Enter');
    await expect(editor).toHaveCount(0);
    await canvas.press('Control+z');
    await expect(canvas).not.toContainText('canvas-299');
    await canvas.press('Control+y');
    await expect(canvas).toContainText('canvas-299');
    await page.screenshot({ path: info.outputPath(`${kind}-history.png`) });
  });

test('#299 shared Document keyboard Undo retains another actor’s text', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/');
  await create(page, 'document');
  await action(page, 'Open collaboratively');
  await confirmed(page);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const peer = await context.newPage();
  const errors = monitor(peer);
  try {
    await peer.goto(page.url().replace('actor=A', 'actor=B'));
    await confirmed(peer);
    const body = await append(page, ' actor-A-299');
    await confirmed(page);
    const peerBody = peer.getByRole('textbox', { name: 'Document body', exact: true });
    await expect(peerBody).toContainText('actor-A-299');
    // The shared contract rejects Undo after a peer edits the same stable block.
    // Use a different block to verify that permitted selective Undo stays routed.
    await peerBody.press('Control+Home');
    await peer.keyboard.insertText('actor-B-299 ');
    await expect(peerBody).toContainText('actor-B-299');
    await confirmed(peer);
    await expect(body).toContainText('actor-B-299');
    await page.bringToFront();
    const receipt = page.waitForResponse((response) =>
      response.url().includes('/collaboration-api/undo?'),
    );
    await body.press('Control+z');
    expect((await (await receipt).json()).status).toBe('accepted');
    await confirmed(page);
    await expect(body).not.toContainText('actor-A-299');
    await expect(body).toContainText('actor-B-299');
    await body.press('Control+y');
    await confirmed(page);
    await expect(body).toContainText('actor-A-299');
    await expect(body).toContainText('actor-B-299');
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});

test('#299 shared Canvas bridge handles Z, Y and Shift+Z', async ({ page }) => {
  await page.goto('/');
  await create(page, 'slide');
  await page.getByRole('button', { name: 'Insert text', exact: true }).click();
  await action(page, 'Open collaboratively');
  await confirmed(page);
  const canvas = page.getByRole('application', { name: 'Slide canvas', exact: true });
  await canvas
    .getByRole('button')
    .filter({ has: page.locator('text') })
    .first()
    .dblclick();
  const editor = page.getByRole('textbox', { name: 'Edit canvas text', exact: true });
  await editor.press('Control+End');
  await page.keyboard.insertText(' shared-canvas-299');
  await confirmed(page);
  await editor.press('Control+z');
  await confirmed(page);
  await expect(editor).not.toContainText('shared-canvas-299');
  await editor.press('Control+y');
  await confirmed(page);
  await expect(editor).toContainText('shared-canvas-299');
  await editor.press('Control+z');
  await confirmed(page);
  await editor.press('Control+Shift+z');
  await confirmed(page);
  await expect(editor).toContainText('shared-canvas-299');
});
