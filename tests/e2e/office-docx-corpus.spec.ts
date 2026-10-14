import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { docxStructure } from '../fixtures/office/docx-structure';
import type { DocumentContent } from '@editor-platform/document/model';
import { test, expect, nativeArtifact } from './fixtures';
import {
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
  docxReport,
} from './office-docx-fixtures';
import { officeDownload } from './office-fixtures';
import { nodeDocx, docxOptions } from '../fixtures/office/docx-node';

for (const name of [
  'golden',
  'long-table',
  'practical-issue6',
  'A4-portrait',
  'A4-landscape',
  'Letter-portrait',
  'Letter-landscape',
])
  test(`D01–D09 ordinary UI and Host API export the ${name} corpus`, async ({ page }, info) => {
    test.setTimeout(120000);
    const content = JSON.parse(
      await readFile(`tests/fixtures/office/corpus/docx/${name}.native.json`, 'utf8'),
    ) as DocumentContent;
    await importOfficeDocument(page, content);
    const original = await nativeArtifact(page),
      dialog = await openDocx(page);
    await dialog.getByLabel('DOCX Mermaid', { exact: true }).selectOption('source');
    await dialog.getByLabel('DOCX preview blocks', { exact: true }).selectOption('source');
    await prepareDocx(dialog);
    await acceptDocx(dialog);
    const bytes = await officeDownload(page, dialog, 'Download DOCX'),
      report = await docxReport(page, dialog);
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const node = await nodeDocx(content, report.basis, docxOptions);
    expect({ ...report, planHash: '' }).toEqual({ ...node.report, planHash: '' });
    expect(docxStructure(bytes)).toEqual(docxStructure(node.bytes));
    const root = process.env.DOCX_UI_EVIDENCE ?? info.outputPath('corpus');
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/${name}.docx`, bytes);
    await writeFile(`${root}/${name}.report.json`, JSON.stringify(report, null, 2));
    await writeFile(`${root}/${name}.native.json`, JSON.stringify(content, null, 2));
    await page.screenshot({ path: `${root}/${name}-ui.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Close DOCX export', exact: true }).click();
    expect(await nativeArtifact(page)).toEqual(original);
  });
