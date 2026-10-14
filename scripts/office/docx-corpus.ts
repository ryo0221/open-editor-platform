import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import { docxGoldenDocument, docxLongTable, docxPageCase } from '../../tests/fixtures/office/docx';
import { nodeDocx, nodeDocxAdapters, docxOptions } from '../../tests/fixtures/office/docx-node';

const root = process.argv[2] ?? 'test-results-office-docx';
await mkdir(root, { recursive: true });
const images = {} as Record<'png' | 'jpeg' | 'gif' | 'webp', string>;
for (const format of ['png', 'jpeg', 'gif', 'webp'] as const)
  images[format] =
    `data:image/${format};base64,` +
    (await readFile(`tests/fixtures/office/images/quadrants.${format}`)).toString('base64');
const practical = JSON.parse(await readFile('tests/fixtures/office/practical/document.native.json', 'utf8'))
  .draft.content as DocumentContent;
const cases = [
  { name: 'golden', content: docxGoldenDocument(images) },
  { name: 'long-table', content: docxLongTable() },
  { name: 'practical-issue6', content: practical },
  ...(['A4', 'Letter'] as const).flatMap((size) =>
    [false, true].map((landscape) => ({
      name: `${size}-${landscape ? 'landscape' : 'portrait'}`,
      content: docxPageCase(size, landscape),
    })),
  ),
];
const adapters = await nodeDocxAdapters();
const results = [];
for (const { name, content } of cases) {
  if (!isDocument(content)) throw Error(`Invalid Document fixture: ${name}`);
  const before = JSON.stringify(content),
    started = performance.now();
  const result = await nodeDocx(
    content,
    {
      kind: 'saved-version',
      artifactId: 'PRIVATE_ARTIFACT_SENTINEL',
      versionId: 'PRIVATE_VERSION_SENTINEL',
    },
    docxOptions,
    adapters,
  );
  if (before !== JSON.stringify(content)) throw Error('Export changed the fixture');
  await writeFile(`${root}/${name}.docx`, result.bytes);
  await writeFile(`${root}/${name}.report.json`, JSON.stringify(result.report, null, 2));
  await writeFile(`${root}/${name}.native.json`, JSON.stringify(content, null, 2));
  const sample = {
    name,
    blocks: content.blocks.length,
    bytes: result.bytes.length,
    elapsedMs: performance.now() - started,
    sha256: createHash('sha256').update(result.bytes).digest('hex'),
    counts: result.report.counts,
  };
  results.push(sample);
  console.log(JSON.stringify(sample));
}
await writeFile(
  `${root}/generation.json`,
  JSON.stringify(
    {
      node: process.version,
      results,
      note: 'Public Node API corpus generation, not a D12 browser performance measurement. Mermaid source policy here; browser diagram adapter is verified separately.',
    },
    null,
    2,
  ),
);
