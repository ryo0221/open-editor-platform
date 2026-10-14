import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { contentHash, createArtifact } from '@editor-platform/artifact-core';
import { isDeck } from '@editor-platform/slide/model';
import { isDocument } from '@editor-platform/document/model';
import { isDesign, exportDesignSvg } from '@editor-platform/design/model';
import { officeReuseCases } from '../../tests/fixtures/reuse/office';
import { nodePptx } from '../../tests/fixtures/office/node';
import { nodeDocx } from '../../tests/fixtures/office/docx-node';

const root = process.argv[2];
if (!root) throw Error('Pass an output directory for the V2.2 linked corpus');
await mkdir(root, { recursive: true });
const image = `data:image/png;base64,${(await readFile('tests/fixtures/office/images/quadrants.png')).toString('base64')}`;
const cases = await officeReuseCases(image),
  results = [];
for (const fixture of cases) {
  const directory = `${root}/${fixture.domain}`;
  await mkdir(directory, { recursive: true });
  for (const [version, content] of [
    ['pinned', fixture.pinned],
    ['adopted', fixture.adopted],
  ] as const) {
    const file = `${directory}/${version}`;
    await writeFile(`${file}.native.json`, JSON.stringify(content, null, 2));
    const artifact = createArtifact(fixture.domain, `Brand ${version}`, content);
    await writeFile(
      `${file}.artifact.json`,
      JSON.stringify({ ...artifact, annotations: [] }, null, 2),
    );
    const basis = {
      kind: 'saved-version' as const,
      artifactId: `linked-${fixture.domain}`,
      versionId: version,
    };
    const exported = isDeck(content)
      ? await nodePptx(content, basis, {
          pageIds: 'all',
          includeHiddenSlides: true,
          includeNotes: true,
          fontProfileId: 'noto-cjk-jp-2.004',
          fallback: 'reject',
        })
      : isDocument(content)
        ? await nodeDocx(content, basis)
        : undefined;
    if (exported) {
      if (
        !exported.report.diagnostics.some(
          (d) => d.code === 'REUSABLE_LINKS_RESOLVED' && d.requiresAcceptance,
        )
      )
        throw Error('Missing reusable-link loss report');
      await writeFile(`${file}.${fixture.domain === 'slide' ? 'pptx' : 'docx'}`, exported.bytes);
      await writeFile(`${file}.report.json`, JSON.stringify(exported.report, null, 2));
    } else if (isDesign(content)) await writeFile(`${file}.svg`, exportDesignSvg(content));
    results.push({
      domain: fixture.domain,
      version,
      contentHash: await contentHash(content),
      componentHash: version === 'pinned' ? fixture.oldHash : fixture.newHash,
      bytes: exported?.bytes.length,
      sharedBrandLibrary: 'office-brand',
      expectedColor: version === 'pinned' ? '#336699' : '#99331a',
    });
  }
}
await writeFile(`${root}/corpus.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify({ result: 'passed', files: results }));
