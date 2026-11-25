import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { type LiveReference } from '@editor-platform/artifact-references';
import {
  Authority,
  initial,
  localAdapter,
  type Action,
  type DomainCodec,
  type Operation,
} from '@editor-platform/collaboration-core';
import { blockNode, documentSchema } from '@editor-platform/document/engine';
import { createDocument, makeBlock } from '@editor-platform/document/model';
import { createDeck, insertSlideCitation, makeSlideObject } from '@editor-platform/slide/model';
import { documentEditorCodec } from './document-editor';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
import { slideEditorCodec } from './editor-transactions';
import { person } from './fixtures';

async function setup<T>(codec: DomainCodec<T>, content: T) {
  const actor = person('A');
  const authority = new Authority(codec, initial('destination', codec, content));
  function unexpected(): never {
    throw new Error('The shared session called an unrelated Host service');
  }
  const adapter: EditorHostAdapter<T> = {
    ...localAdapter(authority, actor),
    versions: async () => [],
    undo: unexpected,
    save: unexpected,
    restore: unexpected,
    registerProposal: unexpected,
    previewProposal: unexpected,
    applyProposal: unexpected,
    cancelProposal: unexpected,
  };
  const session = new SharedEditorSession(codec, adapter);
  await session.open();
  const before = authority.snapshot();
  function submit(action: Action, targets: string[]) {
    // Submit caller-controlled wire data without using the client command builder.
    const operation: Operation = {
      ...actor,
      protocol: 1,
      schema: 1,
      artifactId: before.artifactId,
      domain: before.domain,
      operationId: crypto.randomUUID(),
      transactionId: crypto.randomUUID(),
      origin: 'human',
      baseRevision: before.revision,
      targets,
      conditions: [],
      actions: [action],
    };
    expect(authority.commit(actor, JSON.parse(JSON.stringify(operation)))).toMatchObject({
      status: 'rejected',
      code: 'invalid-operation',
      message: expect.stringContaining('共有編集は未対応'),
    });
    expect(authority.snapshot()).toEqual(before);
    expect(session.viewContent).toEqual(before.content);
    expect(session.pendingCount).toBe(0);
  }
  return { session, submit };
}

async function quote(kind: 'value' | 'figure'): Promise<LiveReference> {
  const snapshot = {
    artifactId: 'source',
    domain: 'counter',
    versionId: 'saved-1',
    revision: 1,
    content: { value: 12 },
    contentHash: await contentHash({ value: 12 }),
    dependencies: [],
  };
  return {
    schemaVersion: 2,
    mode: 'fixed',
    snapshot,
    source: {
      artifactId: snapshot.artifactId,
      domain: snapshot.domain,
      target:
        kind === 'value'
          ? { kind, targetId: 'counter', metricId: 'value' }
          : { kind, figureId: 'figure' },
    },
    presentation:
      kind === 'value'
        ? { kind, value: 12, format: { style: 'decimal', digits: 0, unit: '' } }
        : { kind, label: 'Figure' },
  };
}

it.each(['value', 'figure'] as const)(
  'TS-019 rejects Document %s steps before local or trusted changes',
  async (kind) => {
    const reference = await quote(kind);
    const { session, submit } = await setup(documentEditorCodec, createDocument());
    try {
      const engine = session.text('text');
      const state = engine.state;
      const node =
        kind === 'value'
          ? documentSchema.nodes.live_quote.create({ id: 'quote', reference })
          : blockNode({ ...makeBlock('image'), liveFigure: reference });
      const tr = state.tr.insert(kind === 'value' ? 1 : state.doc.content.size, node);
      expect(() => engine.dispatch(tr)).toThrow('共有編集は未対応');
      expect(engine.state).toBe(state);
      submit(
        {
          type: 'document.steps',
          target: 'text',
          payload: { version: 0, steps: tr.steps.map((step) => step.toJSON()) },
        },
        ['text'],
      );
    } finally {
      session.close();
    }
  },
);

it.each(['value', 'figure'] as const)(
  'TS-019 rejects Slide %s insertion and field changes at both boundaries',
  async (kind) => {
    const reference = await quote(kind);
    const content = createDeck();
    const page = content.slides[0];
    const existing = makeSlideObject(kind === 'value' ? 'text' : 'image', 0);
    page.objects = [existing];
    const { session, submit } = await setup(slideEditorCodec, content);
    try {
      const insert = insertSlideCitation(page.id, 'quote', reference);
      expect(() => session.execute(insert)).toThrow('共有編集は未対応');
      const collection = 'objects@' + page.id;
      const value = insert.apply(content).slides[0].objects.at(-1)!;
      submit(
        {
          type: 'slide.edit',
          target: '*',
          payload: { reads: [], changes: [{ kind: 'insert', collection, id: value.id, value }] },
        },
        [page.id, value.id],
      );
      expect(() =>
        session.execute({
          type: 'attach-quote',
          label: 'Attach quote',
          apply: (deck) => {
            deck.slides[0].objects[0].liveQuote = reference;
            return deck;
          },
        }),
      ).toThrow('共有編集は未対応');
      submit(
        {
          type: 'slide.edit',
          target: '*',
          payload: {
            reads: [],
            changes: [
              { kind: 'field', collection, id: existing.id, field: 'liveQuote', value: reference },
            ],
          },
        },
        [page.id, existing.id],
      );
    } finally {
      session.close();
    }
  },
);
