import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { prepareDocumentImport } from '@editor-platform/document-import';
import { materializeOfficeImport, sourceKey } from '@editor-platform/office-import-core';
import { exportHtml } from '@editor-platform/document/model';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { nodeDocx, nodeDocxAdapters, docxOptions } from '../../tests/fixtures/office/docx-node';
const root = process.argv[2] ?? 'test-results-office-import-docx';
await mkdir(root, { recursive: true });
const adapters = await nodeDocxAdapters();
for (const [name, file] of [
  ['external-word', 'external.docx'],
  ['upstream-numbering', 'numbering1.docx'],
] as const) {
  const bytes = new Uint8Array(await readFile(`tests/fixtures/office/import/document/${file}`)),
    options = {
      unsupported: 'review-conversions' as const,
      fontProfileId: 'noto-cjk-jp-2.004' as const,
    };
  const first = await prepareDocumentImport({ bytes, format: 'docx' }, options, name, {
    version: 'office-image-validator-1',
    decodeImage: decodeNodeOfficeImage,
  });
  await writeFile(`${root}/${name}.initial-report.json`, JSON.stringify(first.report, null, 2));
  const blocked = first.report.diagnostics.filter((d) => d.disposition === 'blocked');
  if (blocked.some((d) => name !== 'upstream-numbering' || d.code !== 'NUMBER_LABEL'))
    throw Error('Unexpected import blocker: ' + JSON.stringify(blocked));
  // This corpus explicitly selects the two known hierarchical label conversions.
  // Product users must make the same individual choice in their reviewed plan.
  const plan = blocked.length
    ? await prepareDocumentImport(
        { bytes, format: 'docx' },
        { ...options, exclude: blocked.map((d) => sourceKey(d.address)) },
        name,
        { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage },
      )
    : first;
  const artifact = materializeOfficeImport(plan, {
    planHash: plan.report.planHash,
    acceptedDiagnosticIds: plan.report.diagnostics
      .filter((d) => d.requiresConsent)
      .map((d) => d.id),
  });
  await writeFile(`${root}/${name}.artifact.json`, JSON.stringify(artifact, null, 2));
  await writeFile(`${root}/${name}.native.json`, JSON.stringify(artifact.draft.content, null, 2));
  await writeFile(`${root}/${name}.import-report.json`, JSON.stringify(plan.report, null, 2));
  await writeFile(`${root}/${name}.html`, exportHtml(artifact.draft.content));
  const exported = await nodeDocx(
    artifact.draft.content,
    { kind: 'saved-version', artifactId: artifact.id, versionId: 'imported' },
    docxOptions,
    adapters,
  );
  await writeFile(`${root}/${name}.docx`, exported.bytes);
  await writeFile(`${root}/${name}.report.json`, JSON.stringify(exported.report, null, 2));
  console.log(
    JSON.stringify({
      name,
      sourceHash: plan.report.sourceHash,
      planHash: plan.report.planHash,
      blocks: artifact.draft.content.blocks.length,
      excluded: blocked.map((d) => d.address),
      bytes: exported.bytes.length,
    }),
  );
}
