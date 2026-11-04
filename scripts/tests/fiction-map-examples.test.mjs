import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('all five progressive examples admit, preserve base IDs and leave capacity for edits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fiction-map-examples-'));
  try {
    const file = path.join(dir, 'examples.mjs');
    await build({
      entryPoints: ['scripts/fixtures/fiction-map-examples.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: file,
    });
    const { exampleIds, exampleStages, exampleContent, exampleArtifact, exampleBriefs } =
      await import(pathToFileURL(file).href);
    assert.equal(exampleIds.length, 5);
    for (const id of exampleIds) {
      let previous;
      for (const stage of exampleStages) {
        const content = exampleContent(id, stage); // Public validator owns the returned snapshot.
        assert.deepEqual(
          exampleContent(id, stage),
          content,
          'authored candidates are deterministic',
        );
        assert.equal(new Set(content.features.map((f) => f.id)).size, content.features.length);
        const vertices = content.features.reduce(
          (n, f) =>
            n +
            (f.geometry.type === 'point'
              ? 1
              : f.geometry.type === 'polygon'
                ? f.geometry.outer.length - 1
                : f.geometry.coordinates.length),
          0,
        );
        assert(content.features.length < 190 && vertices < 950);
        assert(Buffer.byteLength(JSON.stringify(content)) < 60000);
        const landmark = content.features.find((f) => f.id === exampleBriefs[id].landmarkId);
        assert.equal(landmark?.geometry.type, 'point');
        if (previous) {
          assert(content.features.length > previous.features.length);
          for (const f of previous.features)
            assert.deepEqual(
              content.features.find((n) => n.id === f.id),
              f,
              'detail adds to, rather than silently replacing, earlier authored features',
            );
        }
        previous = content;
      }
      const artifact = exampleArtifact(id);
      assert.equal(artifact.kind, 'fiction-map');
      assert.deepEqual(artifact.draft.content, exampleContent(id, 'rough'));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
