import { it, expect } from 'vitest';
import {
  createArtifact,
  commitVersion,
  MemoryStorage,
  contentHash,
} from '@editor-platform/artifact-core';
import { ArtifactEditor } from '@editor-platform/editor-host';
import { command } from '@editor-platform/editor-core';
import { createFictionMap } from './model';
import { parseFictionMapArtifact, fictionMapHostAdapter } from './host';
it('admits all retained native versions and hashes without repairing them', async () => {
  const a = await commitVersion(
    createArtifact('fiction-map', 'Map', createFictionMap()),
    'local',
    'first',
  );
  const parsed = await parseFictionMapArtifact(JSON.stringify(a));
  expect(parsed).toEqual(a);
  const bad = structuredClone(a);
  bad.versions[0].contentHash = '0'.repeat(64);
  await expect(parseFictionMapArtifact(JSON.stringify(bad))).rejects.toThrow('hash');
  const schema = structuredClone(a);
  Reflect.set(schema.versions[0].content, 'schemaVersion', 99);
  await expect(parseFictionMapArtifact(JSON.stringify(schema))).rejects.toThrow();
  await expect(
    parseFictionMapArtifact(
      JSON.stringify(a).replace(
        '"kind":"fiction-map"',
        '"kind":"fiction-map","ki\\u006ed":"fiction-map"',
      ),
    ),
  ).rejects.toThrow('invalid-json');
  expect(a.versions[0].contentHash).toBe(await contentHash(a.versions[0].content));
});
it('keeps failed storage intact, retries, and never rolls a later edit back on save completion', async () => {
  const a = createArtifact('fiction-map', 'Map', createFictionMap()),
    storage = new MemoryStorage<typeof a>();
  await storage.put(a);
  let fail = true,
    release: () => void = () => {};
  let slow = false;
  let entered: () => void = () => {};
  const delayedPut = new Promise<void>((resolve) => (entered = resolve));
  const h = new ArtifactEditor(a, fictionMapHostAdapter, {
    put: async (v) => {
      if (fail) throw Error('disk failed');
      if (slow)
        await new Promise<void>((resolve) => {
          release = resolve;
          entered();
        });
      await storage.put(v);
    },
  });
  h.execute(
    command('layer', 'layer', (v) => ({
      ...v,
      layers: [{ id: 'l', name: 'Places', purpose: 'settlement', visibleByDefault: true }],
    })),
  );
  await expect(h.save({ commitVersion: true })).rejects.toThrow('disk failed');
  expect((await storage.get(a.id))!.versions).toHaveLength(0);
  expect(h.snapshot.dirty).toBe(true);
  fail = false;
  await h.save({ commitVersion: true });
  expect(h.artifact.versions).toHaveLength(1);
  const version = h.artifact.versions[0];
  slow = true;
  const pending = h.save();
  // Native preflight hashes asynchronously. Wait for the actual delayed write,
  // rather than assuming a zero-delay timer runs after it has entered storage.
  await delayedPut;
  h.execute(
    command('rename', 'rename', (v) => ({
      ...v,
      layers: v.layers.map((l) => ({ ...l, name: 'Newer' })),
    })),
  );
  release();
  await pending;
  expect(h.content.layers[0].name).toBe('Newer');
  expect(h.snapshot.dirty).toBe(true);
  expect(h.artifact.versions[0]).toEqual(version);
});
