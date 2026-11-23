import { describe, expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceResolver,
  type EmbeddedReference,
  type LiveReference,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { Authority, initial, type Action } from '@editor-platform/collaboration-core';
import { command } from '@editor-platform/editor-core';
import {
  changeSlideCitation,
  createDeck,
  detachSlideReference,
  duplicateSlide,
  insertObject,
  insertSlideCitation,
  replaceSlideImageReference,
  updateObject,
  type SlideContent,
} from '@editor-platform/slide/model';
import {
  createSharedSlideReferenceCodec,
  prepareEditorCommand,
  slideEditorCodec,
} from './editor-transactions';
import { person } from './fixtures';

const a = person('A'),
  b = person('B');
const figure = 'data:image/png;base64,iVBORw0KGgo=';
async function saved(revision: number): Promise<ReferenceSnapshot> {
  const content = { value: revision * 10 };
  return {
    artifactId: 'source',
    domain: 'test',
    versionId: 'saved-' + revision,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
function live(snapshot: ReferenceSnapshot, kind: 'value' | 'figure'): LiveReference {
  return {
    schemaVersion: 2,
    mode: 'fixed',
    snapshot,
    source: {
      artifactId: snapshot.artifactId,
      domain: snapshot.domain,
      target:
        kind === 'value'
          ? { kind, targetId: 'row', metricId: 'column' }
          : { kind, figureId: 'figure' },
    },
    presentation:
      kind === 'value'
        ? {
            kind,
            value: (snapshot.content as { value: number }).value,
            format: { style: 'decimal', digits: 0, unit: '' },
          }
        : { kind, label: 'Figure' },
  };
}
function legacy(snapshot: ReferenceSnapshot): EmbeddedReference {
  return {
    schemaVersion: 1,
    mode: 'follow',
    fit: 'contain',
    snapshot,
    source: {
      artifactId: snapshot.artifactId,
      domain: snapshot.domain,
      target: { kind: 'chart', viewId: 'main' },
    },
  };
}

async function setup() {
  const versions = await Promise.all([1, 2, 3].map(saved));
  let permitted = true;
  const authorize = ({
    reference,
    liveQuote,
    src,
  }: Parameters<Parameters<typeof createSharedSlideReferenceCodec>[0]['authorize']>[0]) => {
    const quote = reference ?? liveQuote!;
    const expected = versions.find((version) => version.versionId === quote.snapshot.versionId);
    return (
      permitted &&
      !!expected &&
      quote.snapshot.contentHash === expected.contentHash &&
      JSON.stringify(quote.snapshot.content) === JSON.stringify(expected.content) &&
      (!reference || src === figure) &&
      (liveQuote?.presentation.kind !== 'value' ||
        liveQuote.presentation.value === expected.revision * 10)
    );
  };
  const policy = {
    authorize,
    authorizeDetachment: (
      ...[quoted, ordinary]: Parameters<
        Parameters<typeof createSharedSlideReferenceCodec>[0]['authorizeDetachment']
      >
    ) => authorize(quoted) && (quoted.type === 'text' || ordinary.src === figure),
  };
  const codec = createSharedSlideReferenceCodec(policy);
  let deck = createDeck();
  const page = deck.slides[0].id;
  deck = insertObject(page, 'text').apply(deck);
  const body = deck.slides[0].objects[0].id;
  const first = initial('destination', codec, deck);
  const authority = new Authority(codec, first);
  const prepare = (
    who: typeof a,
    cmd: Parameters<typeof prepareEditorCommand<SlideContent>>[3],
    basis = authority.snapshot(),
  ) => prepareEditorCommand(codec, basis, who, cmd)!;
  return {
    versions,
    page,
    body,
    first,
    authority,
    prepare,
    codec,
    revoke: () => {
      permitted = false;
    },
  };
}

describe('opt-in Slide reference transactions', () => {
  it('carries verified image bytes across distinct inline client and authority codecs', async () => {
    const source = legacy(await saved(1));
    const authorize = () => true;
    const policy = { authorize, authorizeDetachment: authorize };
    const client = createSharedSlideReferenceCodec(policy, { assets: false });
    const trusted = createSharedSlideReferenceCodec(policy, { assets: false });
    const deck = createDeck(),
      page = deck.slides[0].id;
    const state = initial('destination', trusted, deck);
    const authority = new Authority(trusted, state);
    const operation = prepareEditorCommand(
      client,
      state,
      a,
      insertObject(page, 'image', { reference: source, src: figure }),
    )!;
    expect(authority.commit(a, JSON.parse(JSON.stringify(operation))).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects[0]).toMatchObject({
      reference: source,
      src: figure,
    });
  });

  it.each(['value', 'figure'] as const)(
    'shares a %s update with a peer move and text and undoes only the reference',
    async (kind) => {
      const { versions, page, body, authority, prepare } = await setup();
      const initialQuote = live(versions[0], kind),
        updated = live(versions[1], kind);
      expect(
        authority.commit(a, prepare(a, insertSlideCitation(page, 'quote', initialQuote))).status,
      ).toBe('accepted');
      const basis = authority.snapshot();
      expect(slideEditorCodec.validate(basis.content)).toBe(false);
      const move = prepare(
        a,
        updateObject(page, 'quote', { bounds: { x: 100, y: 120, width: 250, height: 140 } }),
        basis,
      );
      const edit = prepare(b, changeSlideCitation(page, 'quote', initialQuote, updated), basis);
      const competing = prepare(
        a,
        changeSlideCitation(page, 'quote', initialQuote, live(versions[2], kind)),
        basis,
      );
      const text = prepare(a, updateObject(page, body, { text: 'Peer notes' }), basis);
      expect(authority.commit(b, edit).status).toBe('accepted');
      expect(authority.commit(a, competing)).toMatchObject({
        status: 'rejected',
        code: 'stale-precondition',
      });
      expect(authority.commit(a, move).status).toBe('accepted');
      expect(authority.commit(a, text).status).toBe('accepted');
      expect(authority.undo(b, edit.operationId).status).toBe('accepted');
      const objects = authority.snapshot().content.slides[0].objects;
      expect(objects.find((object) => object.id === 'quote')).toMatchObject({
        liveQuote: initialQuote,
        bounds: { x: 100, y: 120 },
      });
      expect(objects.find((object) => object.id === body)?.text).toBe('Peer notes');
      expect(authority.snapshot().revision).toBe(5);
    },
  );

  it('validates full source and projection on insert, replace and copy of a legacy follow image', async () => {
    const { versions, page, authority, prepare } = await setup();
    const old = legacy(versions[0]),
      next = legacy(versions[1]);
    const insertion = prepare(
      a,
      insertObject(page, 'image', { reference: old, src: figure, alt: 'old figure' }),
    );
    expect(authority.commit(a, insertion).status).toBe('accepted');
    const object = authority.snapshot().content.slides[0].objects.at(-1)!;
    const replacement = prepare(
      a,
      replaceSlideImageReference(page, object.id, old, next, figure, 'new figure'),
    );
    expect(authority.commit(a, replacement).status).toBe('accepted');
    const copy = prepare(b, duplicateSlide(page));
    expect(authority.commit(b, copy).status).toBe('accepted');
    for (const slide of authority.snapshot().content.slides)
      expect(slide.objects.at(-1)?.reference).toEqual(next);
    expect(authority.undo(b, copy.operationId).status).toBe('accepted');
    expect(authority.snapshot().content.slides).toHaveLength(1);
  });

  it('rejects forged closure, field writes and normal text steps, and reauthorizes after revocation', async () => {
    const { versions, page, authority, prepare, codec, revoke } = await setup();
    const quote = live(versions[0], 'value');
    const insertion = prepare(a, insertSlideCitation(page, 'quote', quote));
    const forged = structuredClone(insertion);
    const inserted = (
      forged.actions[0].payload.changes as { value: { liveQuote: LiveReference } }[]
    )[0].value;
    inserted.liveQuote.snapshot.contentHash = '0'.repeat(64);
    expect(authority.commit(a, { ...forged, operationId: 'forged' }).status).toBe('rejected');
    expect(authority.snapshot().revision).toBe(0);
    expect(authority.commit(a, insertion).status).toBe('accepted');
    const next = live(versions[1], 'value');
    const update = prepare(a, changeSlideCitation(page, 'quote', quote, next));
    const wrongValue = structuredClone(update);
    (wrongValue.actions[0].payload.changes as { value: { text: string } }[])[0].value.text = '3000';
    expect(authority.commit(a, { ...wrongValue, operationId: 'wrong-value' }).status).toBe(
      'rejected',
    );
    const rawText: Action = {
      type: 'canvas.text-steps',
      target: 'quote',
      payload: { version: 0, steps: [] },
    };
    expect(() => codec.applyReadonly!(authority.snapshot().content, rawText, 0)).toThrow(
      'detached',
    );
    expect(authority.snapshot().revision).toBe(1);
    revoke();
    expect(codec.validate(authority.snapshot().content)).toBe(false);
    expect(authority.commit(a, update)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(authority.snapshot().revision).toBe(1);
  });

  it('keeps another editor’s description of a detached image when Undo would replace it', async () => {
    const { versions, page, authority, prepare } = await setup();
    const quote = legacy(versions[0]);
    const inserted = prepare(
      a,
      insertObject(page, 'image', { reference: quote, src: figure, alt: 'Original figure' }),
    );
    expect(authority.commit(a, inserted).status).toBe('accepted');
    const object = authority.snapshot().content.slides[0].objects.at(-1)!;
    const detach = prepare(a, detachSlideReference(page, object.id, quote, figure));
    expect(authority.commit(a, detach).status).toBe('accepted');
    const peer = prepare(b, updateObject(page, object.id, { alt: 'A description from B' }));
    expect(authority.commit(b, peer).status).toBe('accepted');
    expect(authority.undo(a, detach.operationId)).toMatchObject({
      status: 'rejected',
      code: 'undo-conflict',
    });
    expect(authority.snapshot().content.slides[0].objects.at(-1)?.alt).toBe('A description from B');
    expect(authority.snapshot().revision).toBe(3);
  });

  it('distinguishes deleting an object from detaching it and restores the exact quote with Undo', async () => {
    const { versions, page, authority, prepare } = await setup();
    const quote = live(versions[0], 'value');
    expect(authority.commit(a, prepare(a, insertSlideCitation(page, 'quote', quote))).status).toBe(
      'accepted',
    );
    const detach = prepare(a, detachSlideReference(page, 'quote', quote));
    expect(authority.commit(a, detach).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects.at(-1)).toMatchObject({
      id: 'quote',
      text: '10',
    });
    expect(authority.snapshot().content.slides[0].objects.at(-1)?.liveQuote).toBeUndefined();
    expect(authority.undo(a, detach.operationId).status).toBe('accepted');
    const remove = prepare(a, changeSlideCitation(page, 'quote', quote));
    expect(authority.commit(a, remove).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects.some((o) => o.id === 'quote')).toBe(
      false,
    );
    expect(authority.undo(a, remove.operationId).status).toBe('accepted');
    expect(authority.snapshot().content.slides[0].objects.at(-1)?.liveQuote).toEqual(quote);
    expect(() =>
      prepare(
        b,
        command('illegal-value', 'Edit quoted value', (state) => {
          state.slides[0].objects.at(-1)!.text = 'Different';
          return state;
        }),
      ),
    ).toThrow('invalid domain content');
  });

  it('projects and captures the adopted follow snapshot even while the source is newer', async () => {
    const old = await saved(1),
      next = await saved(2);
    const resolver = new ReferenceResolver(
      {
        list: async () => [],
        read: async () => next,
        subscribe: () => () => {},
        checkSnapshot: (_source, snapshot) => {
          expect(snapshot.versionId).toBe(old.versionId);
        },
      },
      [
        {
          domain: 'test',
          validate() {},
          project: (snapshot) => ({ src: figure, label: snapshot.versionId }),
        },
      ],
    );
    const retained = resolver.forRetainedVersions();
    const reference = legacy(old);
    expect(await retained.refresh(reference)).toMatchObject({
      status: 'ready',
      snapshot: old,
      projection: { label: old.versionId },
    });
    const [captured] = await retained.capture([{ id: 'image', reference }]);
    expect(captured.reference).toEqual(reference);
  });
});
