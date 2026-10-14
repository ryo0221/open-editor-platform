import { expect, type Browser, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  replaceFileSource,
  nativeArtifact,
  setDocumentText,
  editCell,
  create,
  artifactView,
} from './fixtures';
import { artifactMenu } from './template-fixtures';
import type { NativeContent } from '@editor-platform/templates';
import { nativeIds } from '@editor-platform/templates';
import { assertNative, type Domain } from '@editor-platform/templates';

export const evidence = 'docs/exports/issue-6';
export const screenshots = 'docs/screenshots/issue-6';
export async function value(page: Page, label: string, text: string) {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByLabel(label, { exact: true }).press('Enter');
}
export async function confirmed(page: Page) {
  await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
}
export async function screenshot(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: true });
}
export async function download(page: Page, label: string, name: string) {
  await mkdir(evidence, { recursive: true });
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      await page.getByRole('button', { name: label, exact: true }).click();
      if (label === 'Export CSV')
        await page
          .getByRole('dialog', { name: 'CSV export scope' })
          .getByRole('button', { name: 'Download CSV', exact: true })
          .click();
    })(),
  ]);
  await file.saveAs(`${evidence}/${name}`);
  await page.keyboard.press('Escape');
  return readFile(`${evidence}/${name}`);
}
export async function closePanels(page: Page) {
  for (const button of (
    await page.getByRole('button', { name: /^Close .+ (navigator|inspector)$/ }).all()
  ).reverse())
    if (await button.isVisible()) await button.click();
}
export async function renderSvg(page: Page, bytes: Buffer, name: string) {
  return renderImage(page, bytes, name, 'image/svg+xml');
}
export async function renderImage(page: Page, bytes: Buffer, name: string, mime: string) {
  const view = await page.context().newPage();
  const errors = monitor(view);
  await view.setContent('<img alt="Actual exported drawing" style="max-width:100%">');
  await view.getByRole('img').evaluate(
    async (img, { base64, mime }) => {
      const el = img as HTMLImageElement;
      el.src = `data:${mime};base64,` + base64;
      await el.decode();
      if (!el.naturalWidth || !el.naturalHeight) throw new Error('Empty export');
    },
    { base64: bytes.toString('base64'), mime },
  );
  await screenshot(view, name);
  await view.close();
  expect(errors).toEqual([]);
}
export async function renderPdf(page: Page, bytes: Buffer, name: string, count: number) {
  const view = await page.context().newPage(),
    errors = monitor(view);
  await view.goto('/');
  await create(view, 'file');
  await replaceFileSource(view, {
    name: `${name}.pdf`,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  for (let n = 1; n <= count; n++) {
    await value(view, 'PDF page', String(n));
    await expect(view.getByLabel(`Rendered PDF page ${n}`, { exact: true })).toHaveAttribute(
      'data-rendered',
      'true',
    );
    await screenshot(view, `${name}-${n}`);
  }
  await view.close();
  expect(errors).toEqual([]);
}
export function monitor(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
export async function insertFragment(
  page: Page,
  name: string,
  inputs: Record<string, string> = {},
) {
  await artifactMenu(page, '部分テンプレートを挿入');
  const dialog = page.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
  await dialog.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }).click();
  for (const [slot, text] of Object.entries(inputs))
    await dialog.locator(`[data-slot="${slot}"]`).fill(text);
  await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** A and B use normal surfaces. C is the reference Host's headless proposal client. */
export async function collaborate(
  page: Page,
  browser: Browser,
  baseURL: string | undefined,
  domain: string,
) {
  await artifactMenu(page, 'Open collaboratively');
  await page.keyboard.press('Escape');
  await confirmed(page);
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const peer = await context.newPage(),
    errors = monitor(peer);
  peer.setDefaultTimeout(12000);
  await peer.goto(page.url().replace('actor=A', 'actor=B'));
  await confirmed(peer);
  if (domain === 'document') await setDocumentText(peer, 'h1', '受付改善企画書：共同確認済み');
  else if (domain === 'data') await editCell(peer, '担当', 2, '人B');
  else if (domain === 'slide') await value(peer, 'Slide background', '#edf4ff');
  else {
    await peer
      .getByRole('button', { name: /^Layer / })
      .first()
      .click();
    await value(
      peer,
      domain === 'design' ? 'Layer name' : 'Text',
      domain === 'design' ? '共同確認画面' : '人Bが確認した議題',
    );
  }
  await confirmed(peer);
  await expect
    .poll(async () => JSON.stringify((await nativeArtifact(page)).draft.content))
    .toContain(
      domain === 'document'
        ? '共同確認済み'
        : domain === 'data'
          ? '人B'
          : domain === 'slide'
            ? '#edf4ff'
            : domain === 'design'
              ? '共同確認画面'
              : '人Bが確認した議題',
    );
  const before = (await nativeArtifact(page)).draft.content;
  await artifactMenu(page, 'Agent proposal demo');
  await page.keyboard.press('Escape');
  const panel = page.getByRole('complementary', { name: 'Shared proposal preview' });
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Apply shared proposal', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await confirmed(page);
  const after = (await nativeArtifact(page)).draft.content;
  expect(after).not.toEqual(before);
  await expect.poll(async () => (await nativeArtifact(peer)).draft.content).toEqual(after);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await confirmed(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await confirmed(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(after);
  return {
    peer,
    async close() {
      await context.close();
      expect(errors).toEqual([]);
    },
  };
}

export async function saveShared(page: Page, count: number) {
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'Save version', exact: true })
    .click();
  await expect.poll(async () => (await nativeArtifact(page)).versions.length).toBe(count);
}

/** Save/reload/native reimport and author/reuse the actual UI-created artifact. */
export async function finish(
  page: Page,
  browser: Browser,
  baseURL: string | undefined,
  domain: string,
  version = 1,
) {
  await saveShared(page, version);
  const record = await nativeArtifact(page);
  // Restore a genuinely changed draft; a restore of identical content is not evidence.
  if (domain === 'document') await setDocumentText(page, 'h1', '復元前の一時変更');
  else if (domain === 'data') await editCell(page, '課題', 1, '復元前の一時変更');
  else {
    const names = { slide: 'Slide', design: 'Design', whiteboard: 'Board' };
    if (domain !== 'slide') {
      if (
        !(await page
          .getByRole('button', { name: /^Layer / })
          .first()
          .isVisible())
      )
        await page
          .getByRole('button', {
            name: `Toggle ${names[domain as keyof typeof names]} navigator`,
            exact: true,
          })
          .click();
      await page
        .getByRole('button', { name: /^Layer / })
        .first()
        .click();
    }
    const label =
      domain === 'slide' ? 'Slide background' : domain === 'design' ? 'Layer name' : 'Text';
    if (!(await page.getByLabel(label, { exact: true }).isVisible()))
      await page
        .getByRole('button', {
          name: `Toggle ${names[domain as keyof typeof names]} inspector`,
          exact: true,
        })
        .click();
    await value(page, label, domain === 'slide' ? '#fef3c7' : '復元前の一時変更');
  }
  await confirmed(page);
  expect((await nativeArtifact(page)).draft.content).not.toEqual(record.draft.content);
  await artifactView(page, 'History');
  await page
    .getByRole('button', { name: 'Restore to draft', exact: true })
    .nth(version - 1)
    .click();
  await artifactView(page, 'Editor');
  await expect
    .poll(async () => (await nativeArtifact(page)).draft.content)
    .toEqual(record.draft.content);
  await confirmed(page);
  expect((await nativeArtifact(page)).versions).toEqual(record.versions);
  const ids = nativeIds(record.draft.content as NativeContent);
  assertNative(domain as Domain, record.draft.content);
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/${domain}.native.json`, JSON.stringify(record, null, 2));
  await page.reload();
  await confirmed(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(record.draft.content);
  expect((await nativeArtifact(page)).versions).toEqual(record.versions);
  await screenshot(page, `${domain}-desktop`);
  await page.setViewportSize({ width: 390, height: 844 });
  await closePanels(page);
  await expect(page.getByTestId('editor-viewport')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await screenshot(page, `${domain}-mobile`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await artifactMenu(page, 'テンプレートとして保存');
  const author = page.getByRole('dialog', { name: 'テンプレートとして保存', exact: true });
  await author.getByLabel('テンプレート名', { exact: true }).fill(`実作業 ${domain} 再利用`);
  await author.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
  await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
  await expect(author).toHaveCount(0);
  // The shared artifact remains in its session. A separate ordinary local artifact is
  // created from the authored pack using the same public catalog/form, without injection.
  await page.goto('/');
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const gallery = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await gallery.getByLabel('テンプレート検索', { exact: true }).fill(`実作業 ${domain} 再利用`);
  await gallery
    .getByRole('button', { name: `テンプレートを選択: 実作業 ${domain} 再利用`, exact: true })
    .click();
  const pending = page.waitForEvent('download');
  await gallery.getByRole('button', { name: 'packを書き出す', exact: true }).click();
  await (await pending).saveAs(`${evidence}/${domain}.template.json`);
  await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(gallery).toHaveCount(0);
  const reused = await nativeArtifact(page);
  expect(reused.id).not.toBe(record.id);
  expect(nativeIds(reused.draft.content as NativeContent)).toHaveLength(ids.length);
  expect(nativeIds(reused.draft.content as NativeContent).some((id) => ids.includes(id))).toBe(
    false,
  );
  const context = await browser.newContext({ baseURL }),
    imported = await context.newPage(),
    errors = monitor(imported);
  await imported.goto('/');
  await imported
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles(`${evidence}/${domain}.native.json`);
  expect((await nativeArtifact(imported)).draft.content).toEqual(record.draft.content);
  const importedRecord = await nativeArtifact(imported);
  expect(importedRecord.versions.map(({ artifactId: _owner, ...version }) => version)).toEqual(
    record.versions.map(({ artifactId: _owner, ...version }) => version),
  );
  expect(importedRecord.versions.every((v) => v.artifactId === importedRecord.id)).toBe(true);
  await context.close();
  expect(errors).toEqual([]);
  return record;
}
