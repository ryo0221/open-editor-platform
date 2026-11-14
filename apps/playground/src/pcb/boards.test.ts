import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { f75Pi5Example, f76HatBoard, type PcbDocument } from '@editor-platform/pcb-core';
import { makeArtifact, type StoredArtifact } from '../model';
import { createPcbBoardSource } from './boards';

// PB8b (ST-471, TS-1959): the Playground's board templates and the boards a board can stack.

const stored = async (kind: string, name: string, content: unknown, versions = 1) => {
  let a = createArtifact(kind, name, content);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};

describe('PCB boards in the Playground (PB8b)', () => {
  it('TS-1959: creates from a template and stacks saved versions of other boards', async () => {
    expect(makeArtifact('pcb', 1, undefined, undefined, 'pi5').draft.content).toEqual(
      f75Pi5Example(),
    );
    const hatRecord = makeArtifact('pcb', 2, undefined, undefined, 'hat');
    expect(hatRecord.name).toBe('Sensor HAT+ 2');
    expect(hatRecord.draft.content).toEqual(f76HatBoard());
    expect(makeArtifact('pcb', 3).name).toBe('Circuit board 3');

    const pi = await stored('pcb', 'Pi', f75Pi5Example());
    const hat = await stored('pcb', 'HAT', f76HatBoard(), 2);
    const draftOnly = await stored('pcb', 'Draft', f76HatBoard(), 0);
    const cad = await stored('cad', 'Part', {}, 1);
    const records = [pi, hat, draftOnly, cad];
    const source = createPcbBoardSource({ records: () => records, self: pi.id });
    // Other boards with versions, newest first; not itself, drafts or other kinds.
    const list = await source.list();
    expect(list.map((c) => [c.name, c.versions.map((v) => v.label)])).toEqual([
      ['HAT', ['v2 — v2', 'v1 — v1']],
    ]);
    const v = hat.versions[0]!;
    const ref = { artifactId: hat.id, versionId: v.versionId, contentHash: v.contentHash };
    expect(await source.document(ref)).toEqual(f76HatBoard() as PcbDocument);
    // Refused by code: a changed hash, a missing version, itself.
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(await code(source.document({ ...ref, contentHash: 'b'.repeat(64) }))).toBe(
      'board-source-missing',
    );
    expect(await code(source.document({ ...ref, versionId: 'gone' }))).toBe('board-source-missing');
    const own = pi.versions[0]!;
    expect(
      await code(
        source.document({
          artifactId: pi.id,
          versionId: own.versionId,
          contentHash: own.contentHash,
        }),
      ),
    ).toBe('board-stack-self');
  });
});
