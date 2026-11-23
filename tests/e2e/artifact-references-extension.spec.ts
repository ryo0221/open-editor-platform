import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';
import { openDocx, prepareDocx } from './office-docx-fixtures';
import { strFromU8, unzipSync } from 'fflate';
import { acceptPptx, officeDownload, openPptx, preparePptx } from './office-fixtures';

async function insertOldQuote(page: Page, kind: 'value' | 'figure', propose = false) {
  await page.getByRole('button', { name: '引用を挿入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '引用の挿入' });
  await dialog.getByLabel('引用の種類').selectOption(kind);
  await dialog.getByLabel('元の成果物').selectOption({ label: 'Counter サンプル' });
  await dialog.getByLabel('保存済み版').selectOption('counter-v1');
  if (kind === 'value') {
    await dialog.getByLabel('シナリオ').selectOption('counter');
    await dialog.getByLabel('指標').selectOption({ label: 'Double' });
  } else {
    await dialog.getByRole('combobox', { name: '図', exact: true }).selectOption('tally');
  }
  await dialog.getByRole('button', { name: 'プレビュー', exact: true }).click();
  const preview = dialog.getByLabel('引用のプレビュー');
  if (kind === 'value') await expect(preview).toHaveText('引用 40.00');
  else await expect(preview.getByRole('img', { name: 'Counter: 20' })).toBeVisible();
  await dialog
    .getByRole('button', { name: propose ? '挿入を提案' : '挿入する', exact: true })
    .click();
  await expect(dialog).toBeHidden();
}

for (const narrow of [false, true]) {
  const name = 'Playground quotes and updates both saved Counter outputs in Document and Slide';
  test(narrow ? `${name} at 390px` : name, async ({ page }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    for (const kind of ['document', 'slide'] as const) {
      await test.step(kind, async () => {
        await create(page, kind);
        if (kind === 'document') await page.locator('.ProseMirror p').first().click();
        await insertOldQuote(page, 'value');
        const value = page.locator(
          kind === 'document'
            ? '.ProseMirror [data-live-quote]'
            : '.ep-slide-live-quote text[aria-label^="引用 "]',
        );
        await expect(value).toContainText('40.00');
        if (narrow) await expectNoPageOverflow(page);
        if (kind === 'document') await page.locator('.ProseMirror p').first().click();
        await insertOldQuote(page, 'figure');
        const figure = page.locator(
          kind === 'document' ? '.ep-live-document-figure img' : '.ep-slide-live-quote image',
        );
        const imageAttribute = kind === 'document' ? 'src' : 'href';
        await expect(figure).toHaveAttribute(imageAttribute, /^data:image\/png;base64,/);
        const before = await figure.getAttribute(imageAttribute);
        if (narrow) await expectNoPageOverflow(page);
        await expect(page.getByText('新しい版があります', { exact: true })).toHaveCount(2);

        await page.getByRole('button', { name: '古い引用を確認' }).click();
        const row = (name: string) =>
          page
            .getByRole('region', { name: '古い引用' })
            .getByRole('listitem')
            .filter({ hasText: name });
        const compare = (name: string) =>
          row(name).getByRole('button', { name: '比較', exact: true });
        const update = page.getByRole('button', { name: '更新する' });
        const comparison = page.locator('.ep-live-compare');
        await compare('40.00').click();
        await expect(comparison).toContainText('40.00');
        await expect(comparison).toContainText('120.00');
        await update.click();
        await expect(value).toContainText('120.00');
        await expect(figure).toHaveAttribute(imageAttribute, before!);

        await compare('Counter: 20').click();
        const oldImage = comparison.getByRole('img', { name: 'Counter: 20' });
        const newImage = comparison.getByRole('img', { name: 'Counter: 60' });
        await expect(oldImage).toHaveAttribute('src', before!);
        await expect(newImage).toHaveJSProperty('naturalWidth', 240);
        const after = await newImage.getAttribute('src');
        expect(after).not.toBe(before);
        if (narrow) {
          await expectNoPageOverflow(page);
          expect(
            await comparison.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left >= 0 &&
                bounds.right <= innerWidth + 1 &&
                element.scrollWidth <= element.clientWidth + 1
              );
            }),
          ).toBe(true);
        }
        await page.screenshot({ path: info.outputPath(`${kind}-counter-comparison.png`) });
        await update.click();
        await expect(figure).toHaveAttribute(imageAttribute, after!);
        await expect(value).toContainText('120.00');
        await expect(page.getByText('更新なし')).toBeVisible();
      });
    }
  });
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const kind of ['document', 'slide'] as const) {
  test(`Playground keeps fixed ${kind} quotes across reload and native import`, async ({
    page,
    browser,
  }) => {
    await page.goto('/');
    await create(page, kind);
    const name = `Saved fixed quotes in ${kind}`;
    await page.getByLabel('Artifact name', { exact: true }).fill(name);
    for (const quoteKind of ['value', 'figure'] as const) {
      if (kind === 'document') await page.locator('.ProseMirror p').first().click();
      await insertOldQuote(page, quoteKind);
    }
    await save(page, 1);
    const original = await nativeArtifact(page);
    expect(original.versions[0].content).toEqual(original.draft.content);
    const payload = JSON.stringify(original);
    expect(payload).toContain('counter-v1');
    expect(payload).toContain('"kind":"value"');
    expect(payload).toContain('"kind":"figure"');
    await page.reload();
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(name);
    const reloaded = await nativeArtifact(page);
    expect(reloaded.draft.content).toEqual(original.draft.content);
    expect(reloaded.versions).toEqual(original.versions);

    const imported = await browser.newPage({ viewport: page.viewportSize() });
    const errors: string[] = [];
    imported.on('pageerror', (error) => errors.push(error.message));
    imported.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await imported.goto(page.url());
      await create(imported, kind);
      await imported.getByRole('button', { name: 'More artifact actions', exact: true }).click();
      await imported.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: `${kind}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(payload),
      });
      await imported.keyboard.press('Escape');
      await expect(imported.getByLabel('Artifact name', { exact: true })).toHaveValue(name);
      const record = await nativeArtifact(imported);
      expect(record.draft.content).toEqual(original.draft.content);
      expect(record.versions.map((version) => version.content)).toEqual(
        original.versions.map((version) => version.content),
      );
      expect(errors).toEqual([]);
    } finally {
      await imported.close();
    }
  });
}

for (const kind of ['document', 'slide'] as const) {
  test(`TS-018 Playground reviews and applies or rejects ${kind} quotation changes`, async ({
    page,
  }) => {
    await page.goto('/');
    await create(page, kind);
    await save(page, 1);
    const preview = page.getByRole('dialog', { name: 'External proposal preview' });
    const value = page.locator(
      kind === 'document' ? '.ProseMirror [data-live-quote]' : '.ep-slide-live-quote',
    );
    async function proposeInsertion() {
      if (kind === 'document') await page.locator('.ProseMirror p').first().click();
      await insertOldQuote(page, 'value', true);
      await expect(preview.getByRole('region', { name: 'Proposed changes' })).toContainText(
        'counter-v1',
      );
      await expect(value).toHaveCount(0);
    }
    await proposeInsertion();
    await preview.getByRole('button', { name: 'Reject proposal' }).click();
    await expect(preview).toBeHidden();
    await expect(value).toHaveCount(0);
    await proposeInsertion();
    await preview.getByRole('button', { name: 'Apply proposal' }).click();
    await expect(value).toContainText('40.00');

    await page.getByRole('button', { name: '古い引用を確認' }).click();
    await page.getByRole('button', { name: '比較', exact: true }).click();
    await page.getByRole('button', { name: '更新を提案', exact: true }).click();
    await expect(preview.getByRole('region', { name: 'Proposed changes' })).toContainText(
      'counter-v2',
    );
    await expect(value).toContainText('40.00');
    await preview.getByRole('button', { name: 'Apply proposal' }).click();
    await expect(value).toContainText('120.00');
    await value.click();
    await page.getByRole('button', { name: '削除を提案', exact: true }).click();
    await expect(preview).toBeVisible();
    await expect(value).toContainText('120.00');
    await preview.getByRole('button', { name: 'Reject proposal' }).click();
    await expect(value).toContainText('120.00');
    await value.click();
    await page.getByRole('button', { name: '削除を提案', exact: true }).click();
    await preview.getByRole('button', { name: 'Apply proposal' }).click();
    await expect(value).toHaveCount(0);
  });

  for (const shape of ['value', 'figure'] as const) {
    test(`TS-020 ${kind === 'document' ? 'DOCX rejects' : 'PPTX embeds'} a fixed ${shape} quote`, async ({
      page,
    }, info) => {
      await page.goto('/');
      await create(page, kind);
      if (kind === 'document') await page.locator('.ProseMirror p').first().click();
      await insertOldQuote(page, shape);
      if (kind === 'document') {
        const dialog = await openDocx(page);
        await prepareDocx(dialog);
        await expect(dialog.getByText(/引用を含む.*DOCXに書き出せません/)).toBeVisible();
        await expect(dialog.getByLabel('DOCX counts')).toContainText('Errors: 1');
        await expect(
          dialog.getByRole('button', { name: 'Download DOCX', exact: true }),
        ).toBeDisabled();
        return;
      }
      const before = await nativeArtifact(page);
      const expectedPng =
        shape === 'figure'
          ? await page.locator('.ep-slide-live-quote image').getAttribute('href')
          : undefined;
      const dialog = await openPptx(page);
      await preparePptx(dialog);
      await expect(dialog.getByLabel('PPTX counts')).toContainText('Errors: 0');
      await page.screenshot({ path: info.outputPath('fixed-quote-preflight.png') });
      await acceptPptx(dialog);
      const zip = unzipSync(await officeDownload(page, dialog, 'Download PPTX'));
      const slide = strFromU8(zip['ppt/slides/slide1.xml']);
      expect(slide).not.toMatch(/引用|e4f3ea|counter-v[12]/);
      if (shape === 'value') expect(slide).toContain('<a:t>40.00</a:t>');
      else {
        expect(slide).toContain('<p:pic>');
        expect(expectedPng).toMatch(/^data:image\/png;base64,/);
        const bytes = Buffer.from(expectedPng!.split(',')[1], 'base64');
        expect(
          Object.entries(zip).some(
            ([path, data]) => path.startsWith('ppt/media/') && Buffer.from(data).equals(bytes),
          ),
        ).toBe(true);
      }
      const notes = strFromU8(zip['ppt/notesSlides/notesSlide1.xml']);
      expect(notes).toContain('counter-v1');
      expect(notes).not.toContain('counter-v2');
      await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
      expect(await nativeArtifact(page)).toEqual(before);
    });
  }
}
