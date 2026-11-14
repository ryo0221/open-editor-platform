import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { cosimLedSchematic, cosimStarter } from '@editor-platform/cosim-core';
import { ladderSelfHoldExample } from '@editor-platform/ladder-core';
import { makeArtifact, validContent, type StoredArtifact } from '../model';
import { readImportFiles } from '../app/import-artifact';
import { createCosimSources } from './sources';

// SL8c (ST-575, TS-2121): the saved versions a co-simulation runs in the Playground.

const stored = async (kind: string, name: string, content: unknown, versions = 1) => {
  let a = createArtifact(kind, name, content);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message,
  );

describe('co-simulation sources in the Playground (SL8c)', () => {
  it('TS-2121: lists saved schematic and ladder versions and reads one by its hash', async () => {
    expect(makeArtifact('cosim', 1).draft.content).toEqual(cosimStarter());
    expect(validContent('cosim', cosimStarter())).toBe(true);
    const sch = await stored('schematic', 'LED board', cosimLedSchematic(), 2);
    const lad = await stored('ladder', 'Self-hold', ladderSelfHoldExample());
    const draftOnly = await stored('ladder', 'Draft', ladderSelfHoldExample(), 0);
    const bad = await stored('ladder', 'Bad', { ...ladderSelfHoldExample(), scanMs: 0 });
    const records = [sch, lad, draftOnly, bad];
    const sources = createCosimSources(() => records);
    expect(
      (await sources.schematics.list()).map((e) => [e.name, e.versions.map((v) => v.label)]),
    ).toEqual([['LED board', ['v2 — v2', 'v1 — v1']]]);
    expect((await sources.ladders.list()).map((e) => e.name)).toEqual(['Self-hold', 'Bad']);
    const v = lad.versions[0]!;
    const ref = { artifactId: lad.id, versionId: v.versionId, contentHash: v.contentHash };
    expect(await sources.ladders.document(ref)).toEqual(ladderSelfHoldExample());
    expect(await code(sources.ladders.document({ ...ref, contentHash: 'x' }))).toBe(
      'source-missing',
    );
    expect(await code(sources.schematics.document(ref))).toBe('source-missing');
    const b = bad.versions[0]!;
    expect(
      await code(
        sources.ladders.document({
          artifactId: bad.id,
          versionId: b.versionId,
          contentHash: b.contentHash,
        }),
      ),
    ).toBe('source-invalid');
  });

  it('TS-2121: refuses content that no longer hashes to its version; imports relink the sources', async () => {
    const sch = await stored('schematic', 'LED board', cosimLedSchematic());
    const lad = await stored('ladder', 'Self-hold', ladderSelfHoldExample());
    const ref = (a: StoredArtifact) => ({
      artifactId: a.id,
      versionId: a.versions[0]!.versionId,
      contentHash: a.versions[0]!.contentHash,
    });
    // The hash field kept, the content changed.
    const tampered = structuredClone(lad);
    (tampered.versions[0]!.content as { scanMs: number }).scanMs = 20;
    const sources = createCosimSources(() => [sch, tampered]);
    expect(await code(sources.ladders.document(ref(lad)))).toBe('source-missing');
    expect(await code(sources.schematics.document(ref(sch)))).toBe('ok');

    // A co-simulation imported with its two sources follows their new IDs.
    let cosim = createArtifact('cosim', 'Run', {
      ...cosimStarter(),
      schematic: ref(sch),
      ladder: ref(lad),
    });
    cosim = await commitVersion(cosim, null, 'v1');
    const file = (a: Artifact<unknown>) =>
      new File([serializeArtifact(a)], `${a.name}.json`, { type: 'application/json' });
    const imported = await readImportFiles([file(cosim), file(sch), file(lad)], {
      exists: () => false,
      references: new ReferenceResolver(
        {
          list: async () => [],
          subscribe: () => () => {},
          read: async () => {
            throw new Error('No live reads during import');
          },
        },
        nativeReferenceAdapters,
      ),
    });
    const [run, newSch, newLad] = imported;
    expect(newSch.id).not.toBe(sch.id);
    const draft = run.draft.content as ReturnType<typeof cosimStarter> & {
      schematic: { artifactId: string };
      ladder: { artifactId: string };
    };
    expect(draft.schematic).toEqual({ ...ref(sch), artifactId: newSch.id });
    expect(draft.ladder).toEqual({ ...ref(lad), artifactId: newLad.id });
    const after = createCosimSources(() => imported);
    expect(await after.ladders.document(draft.ladder)).toEqual(ladderSelfHoldExample());
  });
});
