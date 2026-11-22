import { describe, expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { command, EditorSession } from '@editor-platform/editor-core';
import {
  changeLiveReference,
  createLiveReference,
  deferLiveReference,
  updateLiveReference,
  type LiveReference,
  type LiveReferenceProvider,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { changeSlideCitation, createDeck, insertSlideCitation } from './model';

const source = {
  artifactId: 'source',
  domain: 'example.counter',
  target: { kind: 'value' as const, targetId: 'counter', metricId: 'double' },
};
const provider: LiveReferenceProvider = {
  checkAccess() {},
  checkSnapshot() {},
  list: () => [{ ...source.target, label: 'Double' }],
  resolve: (snapshot) => ({
    kind: 'value',
    value: (snapshot.content as { value: number }).value * 2,
  }),
};
async function snapshot(revision: number): Promise<ReferenceSnapshot> {
  const content = { value: revision };
  return {
    artifactId: source.artifactId,
    domain: source.domain,
    versionId: `v${revision}`,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
type Item = { id: string; reference: LiveReference };

describe('reference changes in local history', () => {
  it('rejects deferral and native slide removal for missing or changed citations without adding history', async () => {
    const original = await createLiveReference(source, await snapshot(1), provider, {
      style: 'decimal',
      digits: 0,
      unit: '',
    });
    const latest = await updateLiveReference(original, await snapshot(2), provider);
    const deck = createDeck();
    const slideId = deck.slides[0].id;
    const session = new EditorSession(deck);
    session.execute(insertSlideCitation(slideId, 'changed', latest));
    session.execute(insertSlideCitation(slideId, 'undone', latest));
    session.undo();
    const content = session.content;
    const revision = session.revision;
    const undo = session.historyEntries('undo');
    const redo = session.historyEntries('redo');
    const items = [{ id: 'changed', reference: latest }];
    for (const id of ['undone', 'changed']) {
      expect(() => deferLiveReference(items, id, original)).toThrow(
        '対象引用が存在しないか変更されています。',
      );
      expect(() => session.execute(changeSlideCitation(slideId, id, original))).toThrow(
        '対象引用が変わりました。',
      );
      expect(session.content).toEqual(content);
      expect(session.revision).toEqual(revision);
      expect(session.historyEntries('undo')).toEqual(undo);
      expect(session.historyEntries('redo')).toEqual(redo);
    }
  });

  it('restores one changed reference and leaves other references untouched', async () => {
    const original = await createLiveReference(source, await snapshot(1), provider, {
      style: 'decimal',
      digits: 0,
      unit: '',
    });
    const updated = await updateLiveReference(original, await snapshot(2), provider);
    const initial: Item[] = [
      { id: 'a', reference: original },
      { id: 'b', reference: original },
    ];
    const session = new EditorSession(initial);
    session.execute(
      command('reference.update', 'Update', (items: Item[]) =>
        changeLiveReference(items, 'a', original, updated),
      ),
    );
    expect(session.content[1]).toEqual(initial[1]);
    expect(session.undo()).toEqual(initial);
    expect(session.redo()[0].reference).toEqual(updated);
    const beforeDefer = session.revision;
    deferLiveReference(session.content, 'a', updated);
    expect(session.revision).toEqual(beforeDefer);
    session.execute(
      command('reference.remove', 'Remove', (items: Item[]) =>
        changeLiveReference(items, 'a', updated),
      ),
    );
    expect(session.undo()[0].reference).toEqual(updated);
    expect(session.redo()).toEqual([initial[1]]);
  });
});
