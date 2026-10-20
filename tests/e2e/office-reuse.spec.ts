import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { test, expect, nativeArtifact } from './fixtures';
import {
  importForReuse,
  authorForReuse,
  reuseGallery,
  reusePack,
  changeReuseHeading,
  visibleTemplateFailure,
} from './office-reuse-fixtures';
import { artifactMenu } from './template-fixtures';
import {
  MemoryCatalog,
  TemplateCatalog,
  remapNative,
  nativeIds,
  type NativeContent,
} from '@editor-platform/templates';
import { prepareAgentTemplate } from '../../apps/playground/src/template-agent';
import { canonicalJson } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import { openPptx, preparePptx, acceptPptx, officeDownload } from './office-fixtures';
import { openDocx, prepareDocx, acceptDocx } from './office-docx-fixtures';
const normalize = (c: NativeContent) =>
  canonicalJson(remapNative(c, new Map(), 'normalized').content);
const count = (c: NativeContent) =>
  isDeck(c) ? c.slides.length : isDocument(c) ? c.blocks.length : 0;
for (const domain of ['slide', 'document'] as const) {
  test(`T01–T06 ${domain}: imported proposal authoring, human/agent reuse, shared faults, reload and Office output`, async ({
    page: a,
    browser,
    baseURL,
  }, info) => {
    test.setTimeout(240000);
    a.setDefaultTimeout(12000);
    const name = `${domain}社内提案`,
      fragmentName = `${domain}提案の見出し`;
    await importForReuse(a, domain);
    const { dialog: author, original } = await authorForReuse(a, domain, name);
    await author.screenshot({ path: info.outputPath('author-reviewed.png') });
    await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
    await expect(author).toHaveCount(0);
    expect((await nativeArtifact(a)).draft.content).toEqual(original.draft.content);
    await a.reload();
    const gallery = await reuseGallery(a, name),
      pack = await reusePack(a);
    expect(pack.text).not.toContain('修正した社内提案書');
    expect(pack.text).not.toContain('PRIVATE_OFFICE_AUTHOR_SENTINEL');
    await gallery.getByLabel('案件名', { exact: false }).fill('別案件の提案');
    await gallery.getByLabel('確認項目', { exact: false }).fill('新受付');
    await gallery.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
    await gallery.screenshot({ path: info.outputPath('reuse-preview.png') });
    await gallery.getByRole('button', { name: 'この内容で作成', exact: true }).click();
    await expect(gallery).toHaveCount(0);
    const human = await nativeArtifact(a),
      inputs = { ...pack.definition.sample };
    for (const field of pack.definition.inputs) {
      if (field.label === '案件名') inputs[field.key] = '別案件の提案';
      if (field.label === '確認項目') inputs[field.key] = ['新受付'];
    }
    const agent = await prepareAgentTemplate(
      new TemplateCatalog([new MemoryCatalog([pack.definition])]),
      {
        templateId: pack.definition.templateId,
        templateVersion: 1,
        inputs,
        requestId: `reuse-${domain}-agent`,
      },
    );
    expect(normalize(human.draft.content as NativeContent)).toBe(
      normalize(agent.artifact.draft.content),
    );
    const ids = new Set(nativeIds(human.draft.content));
    expect(nativeIds(agent.artifact.draft.content).some((id) => ids.has(id))).toBe(false);
    expect(human.provenance.officeImport).toBeUndefined();
    // Select a real native heading through normal editing, then save only that fragment.
    await changeReuseHeading(a, domain, '別案件の提案', '別案件の提案');
    await artifactMenu(a, 'テンプレートとして保存');
    await author.getByRole('combobox', { name: '保存範囲', exact: true }).selectOption('fragment');
    await author.getByLabel('テンプレート名', { exact: true }).fill(fragmentName);
    await author.getByRole('button', { name: '保存内容をプレビュー', exact: true }).click();
    await author.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
    await expect(author).toHaveCount(0);
    await artifactMenu(a, 'Open collaboratively');
    await a.keyboard.press('Escape');
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    await a.getByRole('button', { name: 'More artifact actions', exact: true }).click();
    const peer = await a.getByRole('link', { name: 'Open peer editor' }).getAttribute('href');
    await a.keyboard.press('Escape');
    const context = await browser.newContext({ baseURL }),
      b = await context.newPage(),
      errors: string[] = [];
    b.on('pageerror', (e) => errors.push(e.message));
    b.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await b.goto(peer!);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    const baseline = (await nativeArtifact(a)).draft.content as NativeContent;
    const preview = async () => {
      await artifactMenu(a, '部分テンプレートを挿入');
      const dialog = a.getByRole('dialog', { name: '部分テンプレートを挿入', exact: true });
      await dialog
        .getByRole('button', { name: `テンプレートを選択: ${fragmentName}`, exact: true })
        .click();
      await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: 'この内容を挿入', exact: true }),
      ).toBeVisible();
      return dialog;
    };
    let dialog = await preview();
    const field = b.getByLabel(domain === 'slide' ? 'Slide background' : 'Page margin', {
      exact: true,
    });
    await field.click();
    await field.fill(domain === 'slide' ? '#cceecc' : '64');
    await field.press('Enter');
    await expect
      .poll(async () => {
        const content = (await nativeArtifact(b)).draft.content;
        return isDeck(content)
          ? content.slides[0].background
          : isDocument(content)
            ? content.page?.margin
            : undefined;
      })
      .toBe(domain === 'slide' ? '#cceecc' : 64);
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    let lost = false;
    await a.route('**/collaboration-api/proposal/apply?*', async (route) => {
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{' });
      } else await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
    await visibleTemplateFailure(dialog);
    await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(lost).toBe(true);
    expect(count((await nativeArtifact(a)).draft.content as NativeContent)).toBe(
      count(baseline) + 1,
    );
    await a.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => count((await nativeArtifact(a)).draft.content as NativeContent))
      .toBe(count(baseline));
    const undone = (await nativeArtifact(a)).draft.content;
    if (isDeck(undone)) expect(undone.slides[0].background).toBe('#cceecc');
    if (isDocument(undone)) expect(undone.page?.margin).toBe(64);
    await expect.poll(async () => (await nativeArtifact(b)).draft.content).toEqual(undone);
    dialog = await preview();
    if (domain === 'slide') await b.getByRole('button', { name: 'Add slide', exact: true }).click();
    else await changeReuseHeading(b, domain, '別案件の提案', '別案件の共同提案');
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    await dialog.getByRole('button', { name: 'この内容を挿入', exact: true }).click();
    await visibleTemplateFailure(dialog);
    await dialog.screenshot({ path: info.outputPath('shared-stale.png') });
    await a.keyboard.press('Escape');
    await a.unroute('**/collaboration-api/proposal/apply?*');
    // A newly joined peer has no personal catalog. Its native artifact remains independent.
    await a.getByRole('button', { name: 'Save version', exact: true }).click();
    await a
      .getByRole('dialog', { name: 'Save immutable version', exact: true })
      .getByRole('button', { name: 'この版を保存', exact: true })
      .click();
    await expect(a.locator('.save-status')).toContainText('Shared · confirmed');
    const saved = await nativeArtifact(a);
    expect(saved.versions).toHaveLength(1);
    await b.reload();
    await expect(b.locator('.save-status')).toContainText('Shared · confirmed');
    expect((await nativeArtifact(b)).draft.content).toEqual(saved.draft.content);
    await b.screenshot({ path: info.outputPath('shared-reloaded.png'), fullPage: true });
    let bytes: Buffer;
    if (domain === 'slide') {
      const e = await openPptx(b);
      await preparePptx(e);
      await acceptPptx(e);
      bytes = await officeDownload(b, e, 'Download PPTX');
    } else {
      const e = await openDocx(b);
      await prepareDocx(e);
      await acceptDocx(e);
      bytes = await officeDownload(b, e, 'Download DOCX');
    }
    await mkdir(info.outputPath('corpus'), { recursive: true });
    await writeFile(
      info.outputPath(`corpus/reused.${domain === 'slide' ? 'pptx' : 'docx'}`),
      bytes,
    );
    await writeFile(info.outputPath('corpus/native.json'), JSON.stringify(saved, null, 2));
    await writeFile(info.outputPath('corpus/template.json'), pack.text);
    await writeFile(info.outputPath('corpus/agent.json'), JSON.stringify(agent.artifact, null, 2));
    await context.close();
    expect(errors).toEqual([]);
  });
  test(`T03 ${domain}: portable import in an independent Host feeds the same human and agent form`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(12000);
    await importForReuse(page, domain);
    const name = `${domain}移動用`,
      { dialog } = await authorForReuse(page, domain, name);
    await dialog.getByRole('button', { name: 'テンプレートを保存', exact: true }).click();
    const gallery = await reuseGallery(page, name),
      pack = await reusePack(page);
    await gallery.getByRole('button', { name: 'Close テンプレートから作成', exact: true }).click();
    await page.goto('/template-host.html');
    await page.getByRole('button', { name: 'Galleryを開く', exact: true }).click();
    const importer = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
    await importer.getByLabel('テンプレートpackを読み込む', { exact: true }).setInputFiles({
      name: 'reuse.json',
      mimeType: 'application/json',
      buffer: Buffer.from(pack.text),
    });
    await expect(
      importer.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }),
    ).toBeVisible();
    await importer.getByRole('button', { name: 'Close テンプレートから作成', exact: true }).click();
    await page.reload();
    await page
      .getByLabel('Host template', { exact: true })
      .selectOption(pack.definition.templateId);
    await expect
      .poll(() =>
        page
          .getByRole('img', { name: '説明画像の選択画像', exact: true })
          .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
      )
      .toBe(true);
    const preview = page.getByRole('region', { name: 'Host prepared preview', exact: true });
    const result = async () => {
      // Creation is asynchronous; the previous result remains visible while
      // applying. Wait for this creation to finish before exporting its result.
      await expect(preview).toHaveCount(0);
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export template result', exact: true }).click();
      return JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
    };
    await page.getByRole('button', { name: 'Formから準備', exact: true }).click();
    await preview.getByRole('button', { name: 'Hostに作成', exact: true }).click();
    const human = await result();
    await page.getByRole('button', { name: 'Agent APIから準備', exact: true }).click();
    await preview.getByRole('button', { name: 'Hostに作成', exact: true }).click();
    const agent = await result();
    expect(human.id).not.toBe(agent.id);
    expect(normalize(human.draft.content)).toBe(normalize(agent.draft.content));
  });
}
