import { describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import {
  createLiveReference,
  ReferenceError,
  type LiveReference,
} from '@editor-platform/artifact-references';
import { createDocument, makeBlock, type DocumentContent } from '@editor-platform/document/model';
import {
  blockNode,
  captureDocumentUpdate,
  contentToNode,
  documentSchema,
  documentUpdateCommand,
} from '@editor-platform/document/engine';
import { command, type EditorCommand } from '@editor-platform/editor-core';
import {
  changeSlideCitation,
  createDeck,
  insertSlideCitation,
  slideLiveReference,
} from '@editor-platform/slide/model';
import { createLocalSession, type Content } from '../model';
import {
  applyLocalProposal,
  rejectLocalProposal,
  reviewLocalProposal,
  type LocalProposal,
} from './local-proposal';
import { savedExtensionReferences } from './reference-source';

function editDocument(
  content: DocumentContent,
  old?: LiveReference,
  next?: LiveReference,
): EditorCommand<Content> {
  const state = EditorState.create({ doc: contentToNode(content) });
  const tr = state.tr;
  if (!old && next?.presentation.kind === 'figure')
    tr.insert(state.doc.content.size, blockNode({ ...makeBlock('image'), liveFigure: next }));
  else if (!old && next)
    tr.insert(1, documentSchema.nodes.live_quote.create({ id: 'quote', reference: next }));
  else {
    const pos = old?.presentation.kind === 'figure' ? state.doc.firstChild!.nodeSize : 1;
    const node = state.doc.nodeAt(pos)!;
    if (!next) tr.delete(pos, pos + node.nodeSize);
    else
      tr.setNodeMarkup(
        pos,
        undefined,
        old?.presentation.kind === 'figure'
          ? { ...node.attrs, block: { ...node.attrs.block, liveFigure: next } }
          : { ...node.attrs, reference: next },
      );
  }
  return documentUpdateCommand(content, captureDocumentUpdate([tr]), {
    origin: 'local',
    transactionId: 'citation-edit',
  }) as EditorCommand<Content>;
}

async function setup(kind: 'document' | 'slide', shape: 'value' | 'figure') {
  const initial = kind === 'document' ? createDocument() : createDeck();
  // The quote tests each need only the first editable paragraph.
  if ('blocks' in initial) initial.blocks = [makeBlock('paragraph')];
  const session = createLocalSession(initial);
  const connection = savedExtensionReferences('destination');
  if (shape === 'figure') {
    connection.provider.resolve = (saved) => ({
      kind: 'figure',
      label: `Counter: ${(saved.content as { value: number }).value}`,
      src: 'data:image/png;base64,iVBORw0KGgo=',
    });
  }
  const [artifact] = await connection.listArtifacts();
  const versions = await connection.listVersions(artifact);
  const source = {
    artifactId: artifact.artifactId,
    domain: artifact.domain,
    target:
      shape === 'value'
        ? { kind: 'value' as const, targetId: 'counter', metricId: 'double' }
        : { kind: 'figure' as const, figureId: 'tally' },
  };
  const [old, next] = await Promise.all(
    versions.map((snapshot) =>
      createLiveReference(source, snapshot, connection.provider, {
        style: 'decimal',
        digits: 2,
        unit: '',
      }),
    ),
  );
  const draft = () => ({
    kind,
    content: session.content,
    base: { artifactId: 'destination', versionId: 'saved', revision: session.revision },
  });
  const change = (before?: LiveReference, after?: LiveReference) => {
    if ('blocks' in initial) return editDocument(session.content as DocumentContent, before, after);
    const page = initial.slides[0].id;
    return (
      before
        ? changeSlideCitation(page, 'quote', before, after)
        : insertSlideCitation(page, 'quote', after!)
    ) as EditorCommand<Content>;
  };
  const review = (cmd: EditorCommand<Content>) =>
    reviewLocalProposal(draft(), {
      id: 'host-proposal',
      summary: '引用の変更',
      baseLocalRevision: session.revision,
      commands: [cmd],
    });
  const execute = vi.fn((cmd: EditorCommand<Content>) => {
    session.execute(cmd);
    return true;
  });
  return { session, connection, draft, change, review, execute, old, next };
}

describe('TS-018 Host citation proposals', () => {
  for (const kind of ['document', 'slide'] as const)
    it.each(['value', 'figure'] as const)(
      `previews, rejects and applies ${kind} %s citation commands`,
      async (shape) => {
        const { session, connection, draft, execute, change, review, old, next } = await setup(
          kind,
          shape,
        );
        const generation = { current: 0 };
        for (const [before, after] of [
          [undefined, old],
          [old, next],
          [next, undefined],
        ] as const) {
          const cmd = change(before, after);
          const original = session.content;
          const revision = session.revision;
          const history = [session.canUndo, session.canRedo];
          const state: { proposal: LocalProposal | null; busy: boolean; error: string } = {
            proposal: review(cmd),
            busy: true,
            error: 'Apply interrupted',
          };
          const pendingGeneration = generation.current;
          const executedBefore = execute.mock.calls.length;
          expect(state.proposal?.review.status).toBe('ready');
          expect(session.content).toEqual(original);
          expect(session.revision).toEqual(revision);
          expect([session.canUndo, session.canRedo]).toEqual(history);

          rejectLocalProposal(generation, {
            setProposal(proposal) {
              state.proposal = proposal;
            },
            setBusy(busy) {
              state.busy = busy;
            },
            setError(error) {
              state.error = error;
            },
          });
          expect(state).toEqual({ proposal: null, busy: false, error: '' });
          expect(generation.current).toBe(pendingGeneration + 1);
          expect(execute).toHaveBeenCalledTimes(executedBefore);
          expect(session.content).toEqual(original);
          expect(session.revision).toEqual(revision);
          expect([session.canUndo, session.canRedo]).toEqual(history);
          const approved = review(cmd);
          expect(await applyLocalProposal(approved, draft, connection, execute)).toBe(true);
          expect(session.content).toEqual(cmd.apply(original));
          const applied = session.content;
          expect(session.undo()).toEqual(original);
          expect(session.redo()).toEqual(applied);
        }
        expect(execute).toHaveBeenCalledTimes(3);
      },
    );

  it('keys slide citations by page, so the same object ID on two slides can be proposed', async () => {
    const { session, connection, draft, review, execute, old, next } = await setup(
      'slide',
      'value',
    );
    const deck = session.content as ReturnType<typeof createDeck>;
    const first = deck.slides[0].id;
    session.execute(insertSlideCitation(first, 'quote', old) as EditorCommand<Content>);
    // An imported deck may repeat a page-local object ID on another page.
    session.execute(
      command('add-page', 'Add page', (content) => {
        const d = content as ReturnType<typeof createDeck>;
        return { ...d, slides: [...d.slides, { ...d.slides[0], id: 'second' }] };
      }) as EditorCommand<Content>,
    );
    const proposal = review(
      changeSlideCitation('second', 'quote', old, next) as EditorCommand<Content>,
    );
    expect(proposal.review.status).toBe('ready');
    expect(await applyLocalProposal(proposal, draft, connection, execute)).toBe(true);
    const after = session.content as ReturnType<typeof createDeck>;
    const [one, two] = after.slides;
    const cited = (o?: { liveQuote?: Parameters<typeof slideLiveReference>[1] }) =>
      o?.liveQuote && slideLiveReference(after, o.liveQuote);
    expect(cited(one.objects.find((o) => o.id === 'quote'))).toEqual(old);
    expect(cited(two.objects.find((o) => o.id === 'quote'))).toEqual(next);
    // finding 79: the two versions are kept once each in the deck's table.
    expect(Object.keys(after.liveSnapshots ?? {})).toHaveLength(2);
  });

  it('rechecks source access, edit access and draft revision before executing', async () => {
    const { session, connection, draft, execute, change, review, old } = await setup(
      'slide',
      'value',
    );
    const proposal = review(change(undefined, old));
    const initial = session.content;
    const access = vi.spyOn(connection.provider, 'checkAccess');
    access.mockRejectedValueOnce(new ReferenceError('forbidden', '引用元の閲覧権限がありません'));
    await expect(applyLocalProposal(proposal, draft, connection, execute)).rejects.toThrow(
      '閲覧権限',
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    access.mockReturnValueOnce(held);
    let editable = true;
    const readEditable = () => {
      if (!editable) throw new Error('編集権限がありません');
      return draft();
    };
    const pending = applyLocalProposal(proposal, readEditable, connection, execute);
    editable = false;
    release();
    await expect(pending).rejects.toThrow('編集権限');
    expect(session.content).toEqual(initial);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
    session.execute(change(undefined, old));
    session.undo();
    await expect(applyLocalProposal(proposal, draft, connection, execute)).rejects.toThrow(
      'draft changed',
    );
    expect(session.content).toEqual(initial);
    expect(session.canRedo).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a proposed cached value that differs from the verified source', async () => {
    const { session, connection, draft, execute, change, review, old } = await setup(
      'slide',
      'value',
    );
    if (old.presentation.kind !== 'value') throw new Error('Expected value fixture');
    const forged = { ...old, presentation: { ...old.presentation, value: 99 } };
    const proposal = review(change(undefined, forged));
    await expect(applyLocalProposal(proposal, draft, connection, execute)).rejects.toThrow(
      '引用の表示',
    );
    expect(session.canUndo).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses invalid native output at preview', async () => {
    const { session, review, change, old } = await setup('slide', 'value');
    const insert = change(undefined, old);
    expect(() =>
      review(
        command('invalid', 'Invalid citation', (initial) => {
          const after = insert.apply(initial);
          if (!('slides' in after)) throw new Error('Expected Slide');
          after.slides[0].objects.at(-1)!.liveQuote = { ...old, schemaVersion: 99 as 2 };
          return after;
        }),
      ),
    ).toThrow('引用の形式');
    expect(session.canUndo).toBe(false);
  });
});
