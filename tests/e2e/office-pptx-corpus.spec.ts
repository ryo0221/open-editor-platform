import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import type { SlideContent } from '@editor-platform/slide/model';
import { test, expect, nativeArtifact } from './fixtures';
import {
  importOfficeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
  reportDownload,
  officeOptions,
} from './office-fixtures';
import { nodePptx } from '../fixtures/office/node';

for (const name of ['golden', 'practical-issue6', 'portrait-notes'])
  test(`G01–G09 ordinary UI and Host API export the ${name} corpus`, async ({ page }, info) => {
    test.setTimeout(120000);
    const content = JSON.parse(
      await readFile(`tests/fixtures/office/corpus/pptx/${name}.native.json`, 'utf8'),
    ) as SlideContent;
    await importOfficeDeck(page, content);
    const original = await nativeArtifact(page),
      dialog = await openPptx(page);
    if (name === 'portrait-notes') {
      await dialog.getByRole('checkbox', { name: 'Include hidden pages', exact: true }).check();
      await dialog.getByRole('checkbox', { name: 'Include speaker notes', exact: true }).check();
    }
    await preparePptx(dialog);
    await acceptPptx(dialog);
    const bytes = await officeDownload(page, dialog, 'Download PPTX'),
      report = await reportDownload(page, dialog);
    expect(report.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const options = {
      ...officeOptions,
      includeHiddenSlides: name === 'portrait-notes',
      includeNotes: name === 'portrait-notes',
    };
    const node = await nodePptx(content, report.basis, options);
    expect({ ...report, planHash: '' }).toEqual({ ...node.report, planHash: '' });
    const a = unzipSync(bytes),
      b = unzipSync(node.bytes);
    for (const part of Object.keys(a).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)))
      expect(strFromU8(a[part])).toEqual(strFromU8(b[part]));
    const root = process.env.OFFICE_UI_EVIDENCE ?? info.outputPath('corpus');
    await mkdir(root, { recursive: true });
    await writeFile(`${root}/${name}.pptx`, bytes);
    await writeFile(`${root}/${name}.report.json`, JSON.stringify(report, null, 2));
    await writeFile(`${root}/${name}.native.json`, JSON.stringify(content, null, 2));
    await page.screenshot({ path: `${root}/${name}-ui.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Close PPTX export', exact: true }).click();
    expect(await nativeArtifact(page)).toEqual(original);
  });
