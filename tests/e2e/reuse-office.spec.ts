import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';
import { test, expect, nativeArtifact } from './fixtures';
import { officeReuseCases } from '../fixtures/reuse/office';
import {
  importOfficeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
  reportDownload,
} from './office-fixtures';
import {
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
  docxReport,
} from './office-docx-fixtures';
import type { DocumentContent } from '@editor-platform/document/model';
import type { SlideContent } from '@editor-platform/slide/model';

for (const domain of ['document', 'slide'] as const)
  test(`R15 ${domain} adopted library values require explicit Office metadata-loss acceptance`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    page.setDefaultTimeout(12000);
    const image = `data:image/png;base64,${(await readFile('tests/fixtures/office/images/quadrants.png')).toString('base64')}`;
    const fixture = (await officeReuseCases(image)).find((c) => c.domain === domain)!;
    if (domain === 'document') await importOfficeDocument(page, fixture.adopted as DocumentContent);
    else await importOfficeDeck(page, fixture.adopted as SlideContent);
    const before = await nativeArtifact(page);
    const dialog = domain === 'document' ? await openDocx(page) : await openPptx(page);
    if (domain === 'document') await prepareDocx(dialog);
    else await preparePptx(dialog);
    const name = domain === 'document' ? 'DOCX' : 'PPTX';
    await expect(
      dialog.getByText(/Exports the adopted native appearance\. Library links/),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: `Download ${name}`, exact: true }),
    ).toBeDisabled();
    const report =
      domain === 'document' ? await docxReport(page, dialog) : await reportDownload(page, dialog);
    expect(report.diagnostics.find((d) => d.code === 'REUSABLE_LINKS_RESOLVED')).toMatchObject({
      requiresAcceptance: true,
      severity: 'warning',
    });
    if (domain === 'document') await acceptDocx(dialog);
    else await acceptPptx(dialog);
    const bytes = await officeDownload(page, dialog, `Download ${name}`);
    const zip = unzipSync(bytes),
      text = Object.entries(zip)
        .filter(([key]) => /^(word\/document|ppt\/slides\/slide\d+)\.xml$/.test(key))
        .map(([, value]) => strFromU8(value))
        .join('');
    expect(text).toContain('案件Aの本文を保持します。');
    expect(text.toUpperCase()).toContain('99331A');
    await writeFile(info.outputPath(`adopted.${name.toLowerCase()}`), bytes);
    await writeFile(info.outputPath('loss-report.json'), JSON.stringify(report, null, 2));
    await page.screenshot({ path: info.outputPath('reusable-office-loss.png'), fullPage: true });
    await dialog.getByRole('button', { name: `Close ${name} export`, exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  });
