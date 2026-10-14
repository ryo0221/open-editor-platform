import { replaceFileSource, test, expect, create, nativeArtifact, comments } from './fixtures';
import { artifactMenu } from './template-fixtures';
import {
  confirmed,
  closePanels,
  download,
  monitor,
  saveShared,
  screenshot,
  evidence,
} from './practical-fixtures';
import { PDFDocument } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

for (const kind of ['review', 'pdf', 'image'] as const)
  test(`QL-06 ${kind}: fixed source, region/side, shared reply/resolve, reload and original bytes`, async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120000);
    page.setDefaultTimeout(12000);
    await page.goto('/');
    await create(page, kind === 'review' ? 'review' : 'file');
    let bytes: Buffer | undefined;
    if (kind === 'review') {
      await page.getByRole('button', { name: 'Comparison sources', exact: true }).click();
      await page
        .getByLabel('Old text', { exact: true })
        .fill('const 受付時間 = 8;\nconst 案内 = "窓口で確認";\nexport { 案内 };');
      await page
        .getByLabel('New text', { exact: true })
        .fill('const 受付時間 = 3;\nconst 案内 = "保存前に確認";\nexport { 案内 };');
      await page.getByRole('button', { name: 'Apply comparison sources', exact: true }).click();
    } else {
      const images = await page.evaluate(() =>
        Array.from({ length: 3 }, (_, i) => {
          const c = document.createElement('canvas');
          c.width = 612;
          c.height = 792;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 612, 792);
          ctx.fillStyle = ['#e7efff', '#fff0d0', '#e5f6e4'][i];
          ctx.fillRect(40, 150, 532, 450);
          ctx.fillStyle = '#253044';
          ctx.font = 'bold 30px sans-serif';
          ctx.fillText(`受付改善資料 ${i + 1}`, 45, 90);
          ctx.font = '24px sans-serif';
          ctx.fillText(['受付の課題', '比較した結果', '二週間の試行'][i], 65, 210);
          return c.toDataURL('image/png');
        }),
      );
      if (kind === 'pdf') {
        const pdf = await PDFDocument.create();
        for (const src of images) {
          const img = await pdf.embedPng(src);
          pdf.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
        }
        bytes = Buffer.from(await pdf.save());
      } else bytes = Buffer.from(images[1].split(',')[1], 'base64');
      await replaceFileSource(page, {
        name: `受付資料.${kind === 'pdf' ? 'pdf' : 'png'}`,
        mimeType: kind === 'pdf' ? 'application/pdf' : 'image/png',
        buffer: bytes,
      });
      if (kind === 'pdf')
        await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
          'data-rendered',
          'true',
        );
      else await expect(page.getByText('612 × 792 pixels', { exact: true })).toBeVisible();
    }
    const source = (await nativeArtifact(page)).draft.content;
    const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const sourceHash = hash(source);
    await artifactMenu(page, 'Open collaboratively');
    await page.keyboard.press('Escape');
    await confirmed(page);
    await saveShared(page, 1);
    const originalVersion = (await nativeArtifact(page)).versions[0];
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } }),
      peer = await context.newPage(),
      errors = monitor(peer);
    await peer.goto(page.url().replace('actor=A', 'actor=B'));
    await confirmed(peer);
    if (kind === 'review') {
      await page.getByRole('button', { name: 'removed old line 2', exact: true }).click();
    } else {
      if (kind === 'pdf') {
        await page.getByLabel('PDF page', { exact: true }).fill('2');
        await page.getByLabel('PDF page', { exact: true }).press('Enter');
        await expect(page.getByLabel('Rendered PDF page 2', { exact: true })).toHaveAttribute(
          'data-rendered',
          'true',
        );
      }
      await page.getByRole('button', { name: 'Select file region', exact: true }).click();
      const overlay = page.getByLabel(
          kind === 'pdf' ? 'Select PDF region on page 2' : 'Select image region',
          { exact: true },
        ),
        box = (await overlay.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.23);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByTestId('selected-file-region')).toBeVisible();
    }
    await comments(page);
    await page.getByLabel('Comment', { exact: true }).fill('比較結果と受付担当の合意を確認');
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await confirmed(page);
    await comments(peer);
    await expect(peer.locator('.comment-thread')).toContainText('比較結果と受付担当の合意を確認');
    await peer.locator('.comment-thread').getByText('Reply', { exact: true }).click();
    await peer.getByLabel('Reply text').fill('受付担当が二週間の試行に合意しました');
    await peer.getByRole('button', { name: 'Post reply', exact: true }).click();
    await confirmed(peer);
    await expect(page.locator('.comment-thread')).toContainText('二週間の試行');
    await peer.getByRole('button', { name: 'Resolve', exact: true }).click();
    await confirmed(peer);
    await page.getByLabel('Show resolved').check();
    await expect(page.locator('.comment-thread')).toContainText('Resolved');
    if (kind === 'review') {
      await page.getByRole('button', { name: 'Close comments', exact: true }).click();
      await page.getByRole('button', { name: 'added new line 2', exact: true }).click();
      await comments(page);
      await page.getByLabel('Comment', { exact: true }).fill('新しい案内文の確認');
      await page.getByRole('button', { name: 'Add comment', exact: true }).click();
      await confirmed(page);
    }
    const annotated = await nativeArtifact(page);
    expect(hash(annotated.draft.content)).toBe(sourceHash);
    expect(annotated.versions[0]).toEqual(originalVersion);
    await expect
      .poll(async () => (await nativeArtifact(peer)).annotations)
      .toEqual(annotated.annotations);
    await page.reload();
    await confirmed(page);
    expect((await nativeArtifact(page)).annotations).toEqual(annotated.annotations);
    expect((await nativeArtifact(page)).versions[0]).toEqual(originalVersion);
    await comments(page);
    await page.getByLabel('Show resolved').check();
    const thread = page
      .locator('.comment-thread')
      .filter({ hasText: '比較結果と受付担当の合意を確認' });
    await thread.getByRole('button', { name: 'Jump to annotation', exact: true }).click();
    await page.getByRole('button', { name: 'Close comments', exact: true }).click();
    if (kind === 'pdf') await expect(page.getByLabel('PDF page', { exact: true })).toHaveValue('2');
    await screenshot(page, `${kind}-annotation-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await closePanels(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await screenshot(page, `${kind}-annotation-mobile`);
    if (bytes) {
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
      expect(
        await download(
          page,
          'Download original file',
          `reviewed.${kind === 'pdf' ? 'pdf' : 'png'}`,
        ),
      ).toEqual(bytes);
    }
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/${kind}-review.native.json`,
      JSON.stringify(await nativeArtifact(page), null, 2),
    );
    await context.close();
    expect(errors).toEqual([]);
  });
