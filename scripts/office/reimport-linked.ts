import { readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { unzipSync } from 'fflate';
import { prepareDocumentImport } from '@editor-platform/document-import';
import { prepareSlideImport } from '@editor-platform/slide-import';
import {
  materializeOfficeImport,
  sourceKey,
  parseOfficeXml,
  child,
  namespaces,
} from '@editor-platform/office-import-core';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { isDeck, type SlideContent } from '@editor-platform/slide/model';
const root = process.argv[2];
if (!root) throw Error('Pass the directory containing the generated linked Office corpus');
const options = {
  unsupported: 'review-conversions' as const,
  fontProfileId: 'noto-cjk-jp-2.004' as const,
};
const adapters = { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage };
const results = [];
for (const domain of ['document', 'slide'] as const)
  for (const version of ['pinned', 'adopted', 'edited']) {
    const file = `${root}/${domain}/${version}`;
    const bytes = new Uint8Array(
      await readFile(`${file}.${domain === 'document' ? 'docx' : 'pptx'}`),
    );
    let plan =
      domain === 'document'
        ? await prepareDocumentImport(
            { bytes, format: 'docx' },
            options,
            `${domain}-${version}`,
            adapters,
          )
        : await prepareSlideImport(
            { bytes, format: 'pptx' },
            { ...options, pages: 'all', notes: 'include', includeHidden: true },
            `${domain}-${version}`,
            adapters,
          );
    await writeFile(`${file}.initial-import-report.json`, JSON.stringify(plan.report, null, 2));
    const exclusions: string[] = [];
    if (domain === 'slide' && version === 'edited') {
      // This fixed LibreOffice fixture adds a transition extension. It is outside
      // the limited import subset; retain the blocked report and explicitly omit
      // only that addressed transition, as in the V2.1 external Slide corpus.
      const xml = parseOfficeXml(
        unzipSync(bytes)['ppt/slides/slide1.xml'],
        'ppt/slides/slide1.xml',
      );
      const alternate = child(xml, 'AlternateContent', namespaces.mc)!;
      assert.deepEqual(
        alternate.children.map((n) => n.local),
        ['Choice', 'Fallback'],
      );
      for (const branch of alternate.children) {
        assert.equal(branch.children.length, 1);
        const transition = branch.children[0];
        assert.equal(transition.local, 'transition');
        assert.equal(transition.uri, namespaces.p);
        assert.equal(transition.children.length, 0);
      }
      const blocked = plan.report.diagnostics.filter((d) => d.disposition === 'blocked');
      assert.deepEqual(
        blocked.map((d) => [d.code, sourceKey(d.address)]),
        [['UNSUPPORTED_ELEMENT', 'ppt/slides/slide1.xml#/sld[1]/AlternateContent[1]']],
      );
      exclusions.push(sourceKey(blocked[0].address));
      plan = await prepareSlideImport(
        { bytes, format: 'pptx' },
        {
          ...options,
          pages: 'all',
          notes: 'include',
          includeHidden: true,
          exclude: exclusions,
        },
        `${domain}-${version}`,
        adapters,
      );
    }
    await writeFile(`${file}.import-report.json`, JSON.stringify(plan.report, null, 2));
    assert.equal(
      plan.report.diagnostics.filter((d) => d.disposition === 'blocked').length,
      0,
      `Review ${file}.import-report.json before selecting any conversion or exclusion`,
    );
    const artifact = materializeOfficeImport<DocumentContent | SlideContent>(plan, {
      planHash: plan.report.planHash,
      acceptedDiagnosticIds: plan.report.diagnostics
        .filter((d) => d.requiresConsent)
        .map((d) => d.id),
    });
    const content = artifact.draft.content;
    assert.equal('reuse' in content && content.reuse !== undefined, false);
    const native = JSON.stringify(content);
    assert.ok(native.includes('採用済みブランドのご案内'));
    assert.ok(
      native.includes(
        version === 'edited'
          ? '外部Officeで編集した案件Aの本文です。'
          : '案件Aの本文を保持します。',
      ),
    );
    assert.ok(native.includes(version === 'pinned' ? '#336699' : '#99331a'));
    if (isDocument(content))
      assert.equal(content.blocks.filter((b) => b.type === 'image').length, 1);
    else if (isDeck(content)) {
      assert.equal(content.slides.length, 1);
      assert.equal(content.slides[0].objects.filter((o) => o.type === 'image').length, 1);
      assert.ok(content.slides[0].notes?.includes('発表者ノートは部品の改訂と独立です。'));
    } else throw Error('Unexpected imported domain');
    await writeFile(`${file}.imported.artifact.json`, JSON.stringify(artifact, null, 2));
    results.push({
      domain,
      version,
      sourceHash: plan.report.sourceHash,
      planHash: plan.report.planHash,
      restoredLibraryLinks: false,
      adoptedNativeAppearance: true,
      exclusions,
      diagnostics: plan.report.diagnostics,
    });
  }
await writeFile(
  `${root}/reimport-results.json`,
  JSON.stringify({ result: 'passed', files: results }, null, 2),
);
console.log(JSON.stringify({ result: 'passed', files: results.length }));
