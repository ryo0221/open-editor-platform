import { describe, expect, it } from 'vitest';
import {
  EditorSession,
  command,
  reviewProposedCommands,
  textRange,
  transaction,
  withCommandReads,
  type ProposalDiffAdapter,
  type ProposedCommands,
  type SemanticChange,
} from './index';

interface Notes {
  items: { id: string; text: string }[];
}
const adapter: ProposalDiffAdapter<Notes> = {
  domain: 'notes',
  has: (d, id) => d.items.some((i) => i.id === id),
  diff: (a, b) => ({
    changes: b.items.flatMap((item): SemanticChange[] => {
      const old = a.items.find((i) => i.id === item.id);
      if (!old)
        return [
          {
            domain: 'notes',
            kind: 'added' as const,
            elementId: item.id,
            property: 'item',
            after: item.text,
          },
        ];
      return old.text !== item.text
        ? [
            {
              domain: 'notes',
              kind: 'text' as const,
              elementId: item.id,
              property: 'text',
              before: old.text,
              after: item.text,
            },
          ]
        : [];
    }),
    view: [],
    fallback: [],
  }),
};
const content: Notes = { items: [{ id: 'a', text: 'alpha' }] };
const rename = (text: string) =>
  withCommandReads(
    command<Notes>('notes.rename', 'Rename', (d) => ({
      items: d.items.map((i) => (i.id === 'a' ? { ...i, text } : i)),
    })),
    { content: ['a'] },
  );
const proposal = (extra: Partial<ProposedCommands<Notes>> = {}): ProposedCommands<Notes> => ({
  id: 'p1',
  summary: 'Done: renamed everything',
  commands: [rename('ALPHA')],
  ...extra,
});
const base = { artifactId: 'n1', versionId: 'v1' };

describe('reviewProposedCommands', () => {
  it('describes the previewed copy and leaves the draft unchanged', () => {
    const session = new EditorSession(content);
    const review = reviewProposedCommands(
      { content: session.content, base: { ...base, revision: session.revision } },
      proposal({ baseLocalRevision: session.revision }),
      adapter,
    );
    expect(review.status).toBe('ready');
    if (review.status !== 'ready') return;
    expect(review.changes).toEqual([
      expect.objectContaining({ elementId: 'a', before: 'alpha', after: 'ALPHA' }),
    ]);
    expect(review.elementIds).toEqual(['a']);
    expect(session.content).toEqual(content);
    expect(Object.isFrozen(review.changes)).toBe(true);
    // The same commands applied natively produce the reviewed content.
    session.execute(rename('ALPHA'));
    expect(session.content).toEqual(review.preview.content);
  });
  it('refuses with a reason instead of a success for stale, missing and failing proposals', () => {
    const session = new EditorSession(content);
    const before = session.revision;
    session.execute(rename('beta'));
    const current = { content: session.content, base: { ...base, revision: session.revision } };
    const reason = (p: ProposedCommands<Notes>, a = adapter) => {
      const review = reviewProposedCommands(current, p, a);
      return review.status === 'refused' ? [review.reason, review.elementIds] : review.status;
    };
    expect(reason(proposal({ baseLocalRevision: before }))).toEqual(['stale-draft', []]);
    const reads = (versionId: string | null) => ({
      target: { artifactId: 'n1', versionId },
      references: [],
    });
    expect(reason(proposal({ reads: reads('v1') }))).toBe('ready');
    expect(reason(proposal({ reads: reads('v0') }))).toEqual(['stale-version', []]);
    expect(
      reason(
        proposal({
          commands: [
            withCommandReads(
              command<Notes>('notes.rename', 'Rename', (d) => d),
              { content: ['gone'] },
            ),
          ],
        }),
      ),
    ).toEqual(['missing-target', ['gone']]);
    expect(
      reason(
        proposal({
          commands: [
            command<Notes>('notes.fail', 'Fail', () => {
              throw new Error('no');
            }),
          ],
        }),
      ),
    ).toEqual(['command-failed', []]);
    // A summary that claims success is not a change.
    expect(
      reason(proposal({ commands: [command<Notes>('notes.noop', 'No-op', (d) => d)] })),
    ).toEqual(['no-change', []]);
    expect(session.content).toEqual({ items: [{ id: 'a', text: 'beta' }] });
  });
  it('checks reads against the state each command runs on', () => {
    const add = command<Notes>('notes.add', 'Add', (d) => ({
      items: [...d.items, { id: 'b', text: 'new' }],
    }));
    const edit = withCommandReads(
      command<Notes>('notes.rename', 'Rename', (d) => ({
        items: d.items.map((i) => (i.id === 'b' ? { ...i, text: 'NEW' } : i)),
      })),
      { content: ['b'] },
    );
    const review = reviewProposedCommands(
      { content, base },
      proposal({ commands: [add, edit] }),
      adapter,
    );
    expect(review.status).toBe('ready');
    expect(
      reviewProposedCommands({ content, base }, proposal({ commands: [edit, add] }), adapter),
    ).toMatchObject({ status: 'refused', reason: 'missing-target', elementIds: ['b'] });
    // The same steps grouped in one transaction.
    expect(
      reviewProposedCommands(
        { content, base },
        proposal({ commands: [transaction('Add and edit', [add, edit])] }),
        adapter,
      ).status,
    ).toBe('ready');
  });
  it('shows an unsupported domain only as JSON with a reason', () => {
    const review = reviewProposedCommands({ content, base }, proposal(), undefined);
    expect(review).toMatchObject({
      status: 'refused',
      reason: 'unsupported-domain',
      fallback: [{ path: '', before: content, after: { items: [{ id: 'a', text: 'ALPHA' }] } }],
    });
  });
  it('reports unknown units instead of a semantic change', () => {
    const units: ProposalDiffAdapter<Notes> = {
      ...adapter,
      diff: (a, b) => ({
        ...adapter.diff(a, b),
        changes: adapter.diff(a, b).changes.map((c) => ({ ...c, unknownUnits: 'unknown' })),
      }),
    };
    expect(reviewProposedCommands({ content, base }, proposal(), units)).toMatchObject({
      status: 'refused',
      reason: 'unknown-units',
      elementIds: ['a'],
    });
  });
  it('locates the changed text range', () => {
    expect(textRange('Ship on Friday', 'Ship on Monday')).toEqual({
      start: 8,
      beforeEnd: 11,
      afterEnd: 11,
    });
    expect(textRange('ab', 'aXb')).toEqual({ start: 1, beforeEnd: 1, afterEnd: 2 });
    // Surrogate pairs stay whole: 😀 and 😁 share their high surrogate.
    expect(textRange('a😀b', 'a😁b')).toEqual({ start: 1, beforeEnd: 3, afterEnd: 3 });
  });
});
