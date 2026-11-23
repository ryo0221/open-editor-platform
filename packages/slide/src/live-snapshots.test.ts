import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createLiveReference,
  liveSnapshotKey,
  updateLiveReference,
  type LiveReference,
  type LiveReferenceProvider,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import {
  arrangeObjects,
  changeSlideCitation,
  createDeck,
  deleteObjects,
  detachSlideReference,
  insertSlideCitation,
  isDeck,
  normalizeSlideLiveSnapshots,
  slideLiveReference,
  type SlideContent,
} from './model';

const source = {
  artifactId: 'plan',
  domain: 'finance',
  target: { kind: 'value' as const, targetId: 'base', metricId: 'npv' },
};
const provider: LiveReferenceProvider = {
  checkAccess() {},
  checkSnapshot() {},
  list: () => [{ ...source.target, label: 'NPV' }],
  resolve: (s) => ({ kind: 'value', value: (s.content as { value: number }).value }),
};
async function snapshot(revision: number): Promise<ReferenceSnapshot> {
  const content = { value: revision, model: 'x'.repeat(4000) };
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
const format = { style: 'decimal' as const, digits: 0, unit: '円' };
const rows = (deck: SlideContent) => Object.keys(deck.liveSnapshots ?? {});
const bytes = (v: unknown) => new TextEncoder().encode(canonicalJson(v)).length;

describe('slide citations keep one copy per version (finding 79)', () => {
  it('three citations of one version are one row; update, removal, Undo and Redo move rows with them', async () => {
    const v1 = await snapshot(1);
    const quote = await createLiveReference(source, v1, provider, format);
    const deck = createDeck();
    const page = deck.slides[0].id;
    const session = new EditorSession(deck);
    for (const id of ['a', 'b', 'c']) session.execute(insertSlideCitation(page, id, quote));
    const three = session.content;
    expect(isDeck(three)).toBe(true);
    expect(rows(three)).toEqual([liveSnapshotKey(v1)]);
    expect(bytes(three) - bytes(deck)).toBeLessThan(bytes(v1) + 3_000);
    const object = (d: SlideContent, id: string) => d.slides[0].objects.find((o) => o.id === id)!;
    expect(slideLiveReference(three, object(three, 'b').liveQuote!)).toEqual(quote);

    const v2 = await snapshot(2);
    const newer = await updateLiveReference(quote, v2, provider);
    session.execute(changeSlideCitation(page, 'a', quote, newer));
    expect(rows(session.content).sort()).toEqual([liveSnapshotKey(v1), liveSnapshotKey(v2)].sort());
    session.execute(changeSlideCitation(page, 'b', object(session.content, 'b').liveQuote!));
    session.execute(deleteObjects(page, ['c']));
    // v1 is no longer named: its row goes in the same step.
    expect(rows(session.content)).toEqual([liveSnapshotKey(v2)]);
    expect(isDeck(session.content)).toBe(true);
    session.undo();
    expect(rows(session.content).sort()).toEqual([liveSnapshotKey(v1), liveSnapshotKey(v2)].sort());
    expect(object(session.content, 'c').liveQuote).toEqual(object(three, 'c').liveQuote);
    session.redo();
    expect(rows(session.content)).toEqual([liveSnapshotKey(v2)]);
    session.execute(
      detachSlideReference(
        page,
        'a',
        slideLiveReference(session.content, object(session.content, 'a').liveQuote!),
      ),
    );
    expect(session.content.liveSnapshots).toBeUndefined();
    expect(object(session.content, 'a').text).toBe('2円');
    expect(isDeck(session.content)).toBe(true);
  });

  it('leaves a schema 2 deck exactly as stored, and moves a version into the table only when it is cited again', async () => {
    const v1 = await snapshot(1);
    const v2 = await snapshot(2);
    const legacy = (r: LiveReference): LiveReference => ({ ...r, schemaVersion: 2 });
    const old1 = legacy(await createLiveReference(source, v1, provider, format));
    const old2 = legacy(await createLiveReference(source, v2, provider, format));
    const base = createDeck();
    const page = base.slides[0].id;
    const session = new EditorSession(base);
    session.execute(insertSlideCitation(page, 'old1', old1, undefined, { inline: true }));
    session.execute(insertSlideCitation(page, 'old2', old2, undefined, { inline: true }));
    const stored = session.content;
    expect(stored.liveSnapshots).toBeUndefined();
    expect(isDeck(stored)).toBe(true);
    // An ordinary edit (and the same normalization) keeps both schema 2 copies.
    session.execute(arrangeObjects(page, ['old1'], 'front'));
    expect(normalizeSlideLiveSnapshots(stored)).toEqual(stored);
    expect(session.content.slides[0].objects.map((o) => o.liveQuote)).toEqual(
      expect.arrayContaining([old1, old2]),
    );
    // A new citation of v1 moves the v1 copy into the table in the same step; v2 stays inline.
    session.execute(
      insertSlideCitation(page, 'new1', await createLiveReference(source, v1, provider, format)),
    );
    const mixed = session.content;
    const quotes = Object.fromEntries(mixed.slides[0].objects.map((o) => [o.id, o.liveQuote]));
    expect(quotes.old1?.schemaVersion).toBe(3);
    expect(quotes.old2).toEqual(old2);
    expect(rows(mixed)).toEqual([liveSnapshotKey(v1)]);
    expect(isDeck(mixed)).toBe(true);
    session.undo();
    const back = Object.fromEntries(
      session.content.slides[0].objects.map((o) => [o.id, o.liveQuote]),
    );
    expect(back.old1).toEqual(old1);
    expect(back.old2).toEqual(old2);
    expect(back.new1).toBeUndefined();
    expect(session.content.liveSnapshots).toBeUndefined();
  });

  it('refuses a stored deck whose packed citation lacks its row, or whose row conflicts', async () => {
    const v1 = await snapshot(1);
    const quote = await createLiveReference(source, v1, provider, format);
    const deck = createDeck();
    const page = deck.slides[0].id;
    const one = insertSlideCitation(page, 'a', quote).apply(deck);
    expect(isDeck({ ...one, liveSnapshots: undefined })).toBe(false);
    const key = liveSnapshotKey(v1);
    expect(
      isDeck({ ...one, liveSnapshots: { [key]: { ...one.liveSnapshots![key], revision: 5 } } }),
    ).toBe(false);
    // A whole schema 3 citation stored inline (not packed) is refused.
    const inline = structuredClone(deck);
    inline.slides[0].objects.push({ ...one.slides[0].objects.at(-1)!, liveQuote: quote });
    expect(isDeck(inline)).toBe(false);
  });
});
