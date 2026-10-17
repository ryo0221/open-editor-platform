import { expect, it } from 'vitest';
import { canonicalJson, clone, contentHash } from '@editor-platform/artifact-core';
import { command, transaction } from '@editor-platform/editor-core';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createData } from '@editor-platform/structured-data';
import { createDeck, makeSlideObject } from '@editor-platform/slide';
import { createDocument, makeBlock } from '@editor-platform/document';
import { createDesign, makeDesignElement } from '@editor-platform/design';
import { createWhiteboard, makeWhiteboardNode } from '@editor-platform/whiteboard';
import { artifactReferenceItems } from './artifact-references';
import { createLocalSession, validContent, type Content } from './model';

async function fixture(kind: string): Promise<Content> {
  const data = createData();
  const resolver = new ReferenceResolver(
    {
      list: async () => [],
      subscribe: () => () => {},
      read: async () => ({
        artifactId: 'source',
        domain: 'data',
        versionId: 'v1',
        revision: 1,
        content: data,
        contentHash: await contentHash(data),
        dependencies: [],
      }),
    },
    nativeReferenceAdapters,
  );
  const reference = await resolver.create(
    { artifactId: 'source', domain: 'data', target: { kind: 'table', viewId: 'default' } },
    'follow',
  );
  const image = {
    reference,
    src: resolver.project(reference.snapshot, reference.source.target).src,
  };
  if (kind === 'slide') {
    const content = createDeck();
    content.slides[0].objects = [{ ...makeSlideObject('image', 0), ...image }];
    return content;
  }
  if (kind === 'document')
    return { ...createDocument(), blocks: [{ ...makeBlock('image'), ...image }] };
  if (kind === 'design')
    return { ...createDesign(), elements: [{ ...makeDesignElement('image'), ...image }] };
  return { ...createWhiteboard(), nodes: [{ ...makeWhiteboardNode('image'), ...image }] };
}

for (const kind of ['slide', 'document', 'design', 'whiteboard']) {
  for (const field of ['schemaVersion', 'fit', 'source']) {
    for (const origin of ['local', 'proposal'] as const) {
      it(`rejects malformed ${kind} reference ${field} from ${origin} before history changes`, async () => {
        const initial = await fixture(kind);
        const session = createLocalSession(initial);
        const before = canonicalJson(session.content);
        const revision = session.revision;
        const corrupt = command<Content>('test.corrupt', 'Corrupt reference', (value) => {
          const next = clone(value);
          Object.assign(artifactReferenceItems(next)[0].reference!, {
            [field]: field === 'schemaVersion' ? 2 : field === 'fit' ? 'stretch' : null,
          });
          return next;
        });
        const proposal = transaction('Apply proposal', [corrupt], {
          origin: 'proposal',
          transactionId: 'test-proposal',
        });
        expect(() => session.execute(origin === 'proposal' ? proposal : corrupt)).toThrow(
          '参照埋め込み',
        );
        expect(canonicalJson(session.content)).toBe(before);
        expect(session.revision).toEqual(revision);
        expect(session.canUndo).toBe(false);
        expect(session.canRedo).toBe(false);
      });
    }
  }
  it(`keeps valid ${kind} commands and Undo/Redo working after a rejected reference`, async () => {
    const initial = await fixture(kind);
    const session = createLocalSession(initial);
    session.execute(
      command('test.valid', 'Valid image', (value) => {
        const next = clone(value);
        artifactReferenceItems(next)[0].src = 'data:image/png;base64,AA==';
        return next;
      }),
    );
    const changed = session.content;
    expect(validContent(kind, changed)).toBe(true);
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(session.content).toEqual(initial);
    expect(session.canRedo).toBe(true);
    expect(() =>
      session.execute(
        command('test.bad-after-undo', 'Invalid reference', (value) => {
          const next = clone(value);
          Object.assign(artifactReferenceItems(next)[0].reference!, { fit: 'stretch' });
          return next;
        }),
      ),
    ).toThrow('参照埋め込み');
    expect(session.content).toEqual(initial);
    expect(session.canRedo).toBe(true);
    session.redo();
    expect(session.content).toEqual(changed);
  });
}
