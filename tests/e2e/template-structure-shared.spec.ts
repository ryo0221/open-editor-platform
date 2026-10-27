import { isGraphDocument } from '@editor-platform/structured-graph/model';
import { isReactUiDocument } from '@editor-platform/react-ui-core';
import type { Content } from '../../apps/playground/src/model';
import type { NativeContent } from '@editor-platform/templates';
function nativeContent(content: Content): NativeContent {
  if (
    isReactUiDocument(content) ||
    isGraphDocument(content) ||
    'layers' in content ||
    'rootCompositionId' in content ||
    'lanes' in content ||
    'kernelProfile' in content ||
    'axes' in content
  )
    throw new Error('Expected native content');
  if ('domain' in content && content.domain === 'estimate')
    throw Error('Estimate has no template adapter');
  if ('domain' in content && content.domain === 'analysis')
    throw Error('Analysis has no template adapter');
  return content;
}
import { test, expect, create, nativeArtifact, setDocumentText } from './fixtures';
import { artifactMenu } from './template-fixtures';
import { reuseSharedHistory } from './reuse-shared-history-fixture';
import { readStructure } from '@editor-platform/templates';
test('#27 independent shared Document: native peer text, retry, structure addition and selective Undo', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  a.setDefaultTimeout(15000);
  await a.goto('/');
  await create(a, 'document');
  await artifactMenu(a, '部分テンプレートを挿入');
  const gallery = a.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・見出し付き本文', exact: true })
    .click();
  await gallery.getByRole('button', { name: '見出し付き本文を追加', exact: true }).click();
  const start = (await nativeArtifact(a)).draft.content;
  if (!('reuse' in start) || !start.reuse) throw new Error('structure');
  const id = start.reuse.instances[0].id;
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const link = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await b.goto(link!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await setDocumentText(b, 'h1', '他者の本文を保持');
    await expect(a.locator('.ProseMirror h1').first()).toHaveText('他者の本文を保持');
    await artifactMenu(a, '項目数・配置を変更');
    const panel = a.getByRole('dialog', { name: '項目数・配置を変更', exact: true });
    await panel.getByRole('button', { name: '項目を追加', exact: true }).click();
    await panel.getByRole('button', { name: '構成変更をプレビュー', exact: true }).click();
    let lost = false;
    await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
      } else await route.fulfill({ response });
    });
    await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await panel.getByRole('button', { name: 'この構成変更を適用', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(lost).toBe(true);
    expect(
      readStructure(nativeContent((await nativeArtifact(a)).draft.content), id).items,
    ).toHaveLength(3);
    await setDocumentText(b, 'h2', '他者が直接編集');
    await expect(a.locator('.ProseMirror h2').first()).toHaveText('他者が直接編集');
    await reuseSharedHistory(a, 'Undo');
    const undone = (await nativeArtifact(a)).draft.content;
    expect(readStructure(nativeContent(undone), id).items).toHaveLength(2);
    expect(JSON.stringify(undone)).toContain('他者が直接編集');
    expect(JSON.stringify(undone)).toContain('他者の本文を保持');
    await reuseSharedHistory(a, 'Redo');
    expect(
      readStructure(nativeContent((await nativeArtifact(a)).draft.content), id).items,
    ).toHaveLength(3);
    await a.screenshot({ path: info.outputPath('shared-peer-structure.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('#27 shared compound Design text protects peer edits and retains a conflicting private buffer', async ({
  page: a,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(120000);
  await a.goto('/');
  await create(a, 'design');
  await artifactMenu(a, '部分テンプレートを挿入');
  const gallery = a.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await gallery
    .getByRole('button', { name: 'テンプレートを選択: 可変比較・複合部品のフレーム', exact: true })
    .click();
  await gallery.getByRole('button', { name: '複合部品のフレームを追加', exact: true }).click();
  await artifactMenu(a, 'Open collaboratively');
  await a.keyboard.press('Escape');
  await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
  await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  const link = await a
    .getByRole('link', { name: 'Open peer editor', exact: true })
    .getAttribute('href');
  await a.keyboard.press('Escape');
  const context = await browser.newContext({ baseURL }),
    b = await context.newPage(),
    errors: string[] = [];
  b.on('pageerror', (e) => errors.push(e.message));
  b.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await b.goto(link!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    const textA = a.getByRole('textbox', { name: 'Edit canvas text', exact: true }),
      textB = b.getByRole('textbox', { name: 'Edit canvas text', exact: true });
    await a
      .getByRole('application', { name: 'Design canvas', exact: true })
      .getByText('比較対象 1', { exact: true })
      .first()
      .dblclick();
    await textA.press('Control+a');
    await a.keyboard.insertText('私の未確定入力');
    await b
      .getByRole('application', { name: 'Design canvas', exact: true })
      .getByText('比較対象 1', { exact: true })
      .first()
      .dblclick();
    await textB.press('Control+a');
    await b.keyboard.insertText('他者編集');
    await textB.press('Control+Enter');
    // The canvas deliberately displays the private buffer while editing this part.
    // Its Inspector value reflects the peer's canonical text without replacing that buffer.
    const peerText = a.getByRole('textbox', { name: 'Component text 見出し', exact: true });
    await expect(peerText).toHaveCount(1);
    await expect(peerText).toHaveValue('他者編集');
    await expect(textA).toContainText('私の未確定入力');
    await textA.press('Control+Enter');
    await expect(textA).toContainText('私の未確定入力');
    await expect(a.getByRole('alert')).toHaveText(
      '文字または書式が変更済み、または編集できません。入力をコピーして現在値を確認してください。',
    );
    await a.screenshot({ path: info.outputPath('shared-compound-text-conflict.png') });
    await textA.press('Escape');
    const native = (await nativeArtifact(a)).draft.content;
    expect(JSON.stringify(native)).toContain('他者編集');
    expect(JSON.stringify(native)).not.toContain('私の未確定入力');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
