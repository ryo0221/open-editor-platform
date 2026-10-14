import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { mountBoundaryHost } from './pr52-boundary-fixtures';
import { importUsability } from './usability-fixtures';
import { createFile } from '@editor-platform/review-surfaces/model';
import { create, nativeArtifact, replaceFileSource } from './fixtures';

async function exportChart(page: Page, format: string) {
  const menu = page.getByRole('button', { name: 'Export data', exact: true });
  if (!(await menu.isVisible()))
    await page
      .getByRole('button', { name: 'More editor tools', exact: true })
      .dispatchEvent('click');
  await menu.dispatchEvent('click');
  await page
    .getByRole('button', { name: `Export chart ${format}`, exact: true })
    .dispatchEvent('click');
}

export async function freshChartOutput(page: Page, pngPath: string) {
  await mountBoundaryHost(page, 'data-output');
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const value = page.getByLabel('Host record value', { exact: true });
  await value.fill('75');
  const pending = page.waitForEvent('download');
  await exportChart(page, 'SVG');
  const svg = await readFile((await (await pending).path())!, 'utf8');
  expect(svg).toContain('Visible B');
  expect(svg).toContain('75');
  expect(
    JSON.parse((await page.getByTestId('data-output-source').textContent())!).rows[1].values.value,
  ).toBe(75);
  await page.keyboard.press('Escape');
  const accent = page.getByLabel('View accent', { exact: true });
  if (!(await accent.isVisible()))
    await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
  await accent.fill('#c53d2f');
  const fresh = page.waitForEvent('download');
  await exportChart(page, 'SVG');
  expect(await readFile((await (await fresh).path())!, 'utf8')).toContain('#c53d2f');
  await page.keyboard.press('Escape');
  if (!(await accent.isVisible()))
    await page.getByRole('button', { name: 'Toggle Data navigator', exact: true }).click();
  await accent.fill('#168745');
  const png = page.waitForEvent('download');
  await exportChart(page, 'PNG');
  const downloaded = await png;
  await downloaded.saveAs(pngPath);
  const bytes = await readFile((await downloaded.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let matching = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i] === 22 && data[i + 1] === 135 && data[i + 2] === 69) matching++;
    return matching;
  }, bytes.toString('base64'));
  expect(pixels).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  for (const format of ['SVG', 'PNG']) {
    const count = downloads.length;
    await value.fill('-1');
    await exportChart(page, format);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Host record value' }).first(),
    ).toBeVisible();
    expect(downloads.length).toBe(count);
    await value.press('Escape');
    await value.fill('80');
    await value.dispatchEvent('compositionstart');
    await exportChart(page, format);
    await expect(page.getByRole('alert').filter({ hasText: '入力変換' }).first()).toBeVisible();
    expect(downloads.length).toBe(count);
    await value.dispatchEvent('compositionend');
    await value.press('Escape');
  }
}

export async function freshCanvasOutput(
  page: Page,
  kind: 'slide' | 'whiteboard' | 'design',
  pngPath: string,
) {
  await page.goto('/');
  await create(page, kind);
  const insert = page.getByRole('button', { name: 'Insert text', exact: true });
  if (!(await insert.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await insert.click();
  await page.keyboard.press('Escape');
  const text = page.getByLabel('Text', { exact: true });
  const reveal = async () => {
    if (!(await text.isVisible()))
      await page
        .getByRole('button', {
          name: `Toggle ${kind === 'whiteboard' ? 'Board' : kind === 'slide' ? 'Slide' : 'Design'} inspector`,
          exact: true,
        })
        .click();
  };
  const exportFile = async (format: string) => {
    const menu = page.getByRole('button', {
      name: kind === 'slide' ? 'Export visual' : `Export ${kind}`,
      exact: true,
    });
    if (!(await menu.isVisible()))
      await page
        .getByRole('button', { name: 'More editor tools', exact: true })
        .dispatchEvent('click');
    await menu.dispatchEvent('click');
    await page
      .getByRole('button', {
        name: kind === 'slide' ? `Export ${format}` : `Export selection ${format}`,
        exact: true,
      })
      .dispatchEvent('click');
  };
  await reveal();
  await text.fill(`Latest ${kind} SVG`);
  const pending = page.waitForEvent('download');
  await exportFile('SVG');
  const svg = await readFile((await (await pending).path())!, 'utf8');
  const renderedText = await page.evaluate(
    (source) =>
      new DOMParser().parseFromString(source, 'image/svg+xml').documentElement.textContent,
    svg,
  );
  expect(renderedText).toContain(`Latest ${kind} SVG`);
  expect(JSON.stringify((await nativeArtifact(page)).draft.content)).toContain(
    `Latest ${kind} SVG`,
  );
  await page.keyboard.press('Escape');
  await reveal();
  await text.fill(`Latest ${kind} PNG`);
  const png = page.waitForEvent('download');
  await exportFile('PNG');
  await (await png).saveAs(pngPath);
  expect((await readFile(pngPath)).subarray(1, 4).toString()).toBe('PNG');
  if (kind === 'design') {
    await page.keyboard.press('Escape');
    const menu = page.getByRole('button', { name: 'Export design', exact: true });
    if (!(await menu.isVisible()))
      await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
    await menu.click();
    await page.getByLabel('Export padding (px)', { exact: true }).fill('44');
    const changed = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Export selection SVG', exact: true })
      .dispatchEvent('click');
    const svg = await readFile((await (await changed).path())!, 'utf8');
    const width = (await nativeArtifact(page)).draft.content as {
      elements: { bounds: { width: number } }[];
    };
    expect(svg).toContain(`width="${width.elements.at(-1)!.bounds.width + 88}"`);
  }
  await page.keyboard.press('Escape');
  for (const format of ['SVG', 'PNG']) {
    await reveal();
    await text.fill(`Composing ${kind}`);
    await text.dispatchEvent('compositionstart');
    let downloaded = false;
    const listener = () => {
      downloaded = true;
    };
    page.on('download', listener);
    await exportFile(format);
    await expect(page.getByRole('alert').filter({ hasText: '入力変換' }).first()).toBeVisible();
    expect(downloaded).toBe(false);
    page.off('download', listener);
    await text.dispatchEvent('compositionend');
    await text.press('Escape');
    await page.keyboard.press('Escape');
  }
}

export async function scalarEdgeLabels(page: Page) {
  await mountBoundaryHost(page, 'scalar-graph');
  for (const [id, text] of [
    ['zero', 'Weight · 0'],
    ['false', 'Status · false'],
    ['named', 'Text · Named'],
    ['blank', 'Text'],
    ['null', 'Text'],
  ]) {
    await page.getByLabel('Host label case', { exact: true }).selectOption(id);
    await expect(page.locator(`g[data-edge-id="${id}"] text`)).toHaveText(text);
  }
  await page.getByLabel('Host label case', { exact: true }).selectOption('false');
}

export async function pdfIndexFailureNotice(page: Page) {
  await page.goto('/');
  await importUsability(page, 'file', createFile('pdf'));
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 501; i++) pdf.addPage([200, 200]);
  await replaceFileSource(page, {
    name: 'page-limit.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await pdf.save()),
  });
  await expect(page.getByRole('alert').filter({ hasText: '500ページ' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'このPDFには抽出できる文字がありません' }),
  ).toHaveCount(0);
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  await replaceFileSource(page, {
    name: 'blank.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await blank.save()),
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'このPDFには抽出できる文字がありません' }),
  ).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '文字の抽出に失敗しました' })).toHaveCount(
    0,
  );
}
