import { writeFile } from 'node:fs/promises';
import { test, expect, nativeArtifact, comments } from './fixtures';
import { authorAndInsert, publishRevision, stageRevision } from './reuse-revision-fixtures';
import { reuseMenu, reuseHistory } from './reuse-fixtures';
import { confirmed, monitor } from './practical-fixtures';
import { resolveDocumentAddress, type DocumentContent } from '@editor-platform/document/model';

test('R09 baseline Chromium composition survives its own shared confirmation', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const before = await authorAndInsert(page),
    id = Object.values(before.reuse!.instances[0].parts)[0];
  await reuseMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const block = page.locator(`.ProseMirror [data-block-id="${id}"]`);
  await block.evaluate((node) => {
    (node.closest('.ProseMirror') as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await confirmed(page);
  await cdp.send('Input.insertText', { text: '日本語を入力' });
  await cdp.detach();
  await confirmed(page);
  await writeFile(
    info.outputPath('baseline-text.json'),
    JSON.stringify({ text: await block.textContent() }),
  );
  await expect(block).toHaveText('入力済みの日本語日本語を入力');
});

test('R09 Chromium composition during a peer style update preserves text, selection and existing annotation anchor', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(150000);
  const before = await authorAndInsert(a),
    id = Object.values(before.reuse!.instances[0].parts)[0];
  await publishRevision(a);
  await reuseMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await confirmed(a);
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const peer = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors = monitor(b);
  await b.goto(peer!);
  await confirmed(b);
  const block = b.locator(`.ProseMirror [data-block-id="${id}"]`);
  await block.evaluate((node) => {
    (node.closest('.ProseMirror') as HTMLElement).focus();
    const range = document.createRange();
    range.setStart(node.firstChild!, 0);
    range.setEnd(node.firstChild!, 2);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await comments(b);
  await b.getByLabel('Comment', { exact: true }).fill('入力範囲の確認');
  await b.getByRole('button', { name: 'Add comment', exact: true }).click();
  await b.getByRole('button', { name: 'Close comments', exact: true }).click();
  await confirmed(b);
  const annotated = await nativeArtifact(b);
  expect(annotated.annotations).toHaveLength(1);
  const preview = await stageRevision(a);
  await block.evaluate((node) => {
    (node.closest('.ProseMirror') as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const events: string[] = [];
    (window as typeof window & { imeEvents: string[] }).imeEvents = events;
    (window as typeof window & { compositionBlock: Element }).compositionBlock = node;
    for (const name of ['compositionstart', 'compositionend'])
      node.closest('.ProseMirror')!.addEventListener(name, () => events.push(name));
  });
  const cdp = await context.newCDPSession(b);
  await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
  await expect(block).toContainText('日本');
  await preview.getByRole('button', { name: 'プレビューした変更を適用', exact: true }).click();
  await expect
    .poll(async () => block.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
    .toBeCloseTo((22 * 4) / 3, 3);
  expect(
    await block.evaluate((node) => node.contains(window.getSelection()?.anchorNode ?? null)),
  ).toBe(true);
  expect(
    await block.evaluate(
      (node) => node === (window as typeof window & { compositionBlock: Element }).compositionBlock,
    ),
  ).toBe(true);
  await cdp.send('Input.insertText', { text: '日本語を入力' });
  await cdp.detach();
  await confirmed(b);
  await expect(block).toHaveText('入力済みの日本語日本語を入力');
  const events = await b.evaluate(
    () => (window as typeof window & { imeEvents: string[] }).imeEvents,
  );
  expect(events).toEqual(['compositionstart', 'compositionend']);
  const result = await nativeArtifact(b);
  expect((result.draft.content as DocumentContent).reuse!.instances[0].ref.version).toBe(2);
  const originalAnchor = annotated.annotations[0].anchor;
  const expectedAnchor = structuredClone(originalAnchor);
  for (const address of expectedAnchor.addresses)
    if (address.region?.type === 'text') address.region.sourceText = '入力済みの日本語日本語を入力';
  expect(result.annotations[0].anchor).toEqual(expectedAnchor);
  const resolved = resolveDocumentAddress(
    result.draft.content as DocumentContent,
    result.annotations[0].anchor.addresses[0],
  );
  expect(resolved.state).toBe('Current');
  expect(resolved.address.region).toMatchObject({ type: 'text', start: 0, end: 2 });
  expect(result.annotations[0].comments).toEqual(annotated.annotations[0].comments);
  await reuseHistory(a, 'Undo');
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(b)).draft.content as DocumentContent).reuse!.instances[0].ref
          .version,
    )
    .toBe(1);
  await expect(block).toHaveText('入力済みの日本語日本語を入力');
  await reuseHistory(a, 'Redo');
  await expect
    .poll(async () => block.evaluate((node) => parseFloat(getComputedStyle(node).fontSize)))
    .toBeCloseTo((22 * 4) / 3, 3);
  await writeFile(info.outputPath('composition.artifact.json'), JSON.stringify(result, null, 2));
  await b.screenshot({ path: info.outputPath('peer-composition.png'), fullPage: true });
  await context.close();
  expect(errors).toEqual([]);
});
