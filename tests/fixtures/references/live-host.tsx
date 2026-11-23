import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { contentHash } from '@editor-platform/artifact-core';
import {
  createLiveReference,
  ReferenceError,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { type LiveReferenceConnection } from '@editor-platform/artifact-references/react';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { DocumentSurface, createDocument } from '@editor-platform/document';
import { SlideSurface, createDeck } from '@editor-platform/slide';
import {
  insertSlideCitation,
  slideMotionCommand,
  type SlideContent,
} from '@editor-platform/slide/model';
import { Authority, Conflict, initial, type Principal } from '@editor-platform/collaboration-core';
import {
  createSharedSlideReferenceCodec,
  prepareEditorCommand,
} from '@editor-platform/collaboration-adapters';
import '@editor-platform/editor-ui/styles.css';

const params = new URLSearchParams(location.search);
const figures = [1, 2].map((revision) => {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 88;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e4f3ea';
  ctx.fillRect(0, 0, 160, 88);
  ctx.fillStyle = '#267453';
  [24, revision * 20, 44].forEach((height, i) =>
    ctx.fillRect(30 + i * 38, 74 - height, 24, height),
  );
  return canvas.toDataURL('image/png');
});
const artifact = { artifactId: 'budget', domain: 'fixture', label: '収支モデル' };
const snapshots: ReferenceSnapshot[] = await Promise.all(
  [1, 2].map(async (revision) => {
    const content = { value: revision === 1 ? 0.25 : 0.5 };
    return {
      artifactId: artifact.artifactId,
      domain: artifact.domain,
      revision,
      versionId: `v${revision}`,
      content,
      contentHash: await contentHash(content),
      dependencies: [],
    };
  }),
);
let forbidden = false;
let missing = false;
const connection: LiveReferenceConnection = {
  destinationArtifactId: 'local',
  listArtifacts: async () => [artifact],
  listVersions: async () => snapshots,
  latest: async () => snapshots[1],
  provider: {
    checkAccess() {
      if (forbidden) throw new ReferenceError('forbidden', 'forbidden');
    },
    checkSnapshot(_source, snapshot) {
      if (
        !snapshots.some(
          (entry) =>
            entry.versionId === snapshot.versionId && entry.contentHash === snapshot.contentHash,
        )
      )
        throw new Error('保存版が一致しません。');
    },
    list(snapshot) {
      return [
        ...(!missing || snapshot.revision === 1
          ? [{ kind: 'value', targetId: 'base', metricId: 'npv', label: 'NPV' } as const]
          : []),
        { kind: 'figure', figureId: 'map', label: '事業地図' },
      ];
    },
    resolve(snapshot, target) {
      return target.kind === 'value'
        ? { kind: 'value', value: snapshot.revision === 1 ? 0.25 : 0.5 }
        : {
            kind: 'figure',
            label: '事業地図',
            src: figures[snapshot.revision - 1],
          };
    },
  },
};

declare global {
  interface Window {
    liveQuoteFixture: {
      snapshot(): { sequence: number; content: unknown; canUndo: boolean; canRedo: boolean };
      setReadOnly(on: boolean): void;
      forbid(): void;
      removeLatestValue(): void;
      undo(): void;
      redo(): void;
    };
  }
}

function useFixture<T>(session: EditorSession<T>) {
  const [content, setContent] = useState(() => session.content);
  const [readOnly, setReadOnly] = useState(false);
  window.liveQuoteFixture = {
    snapshot: () => ({
      sequence: session.revision.sequence,
      content: session.content,
      canUndo: session.canUndo,
      canRedo: session.canRedo,
    }),
    setReadOnly,
    forbid: () => {
      forbidden = true;
    },
    removeLatestValue: () => {
      missing = true;
    },
    undo: () => setContent(session.undo()),
    redo: () => setContent(session.redo()),
  };
  return {
    content,
    readOnly,
    liveReferences: connection,
    execute: (cmd: EditorCommand<T>) => {
      if (readOnly) return false;
      setContent(session.executeView(cmd));
      return true;
    },
    select: () => {},
  };
}
const doc = createDocument();
doc.blocks[1].text = 'Before after';
const documentSession = new EditorSession(doc);
const slideSession = new EditorSession(createDeck());
function DocumentFixture() {
  return <DocumentSurface {...useFixture(documentSession)} />;
}
function SlideFixture() {
  return <SlideSurface {...useFixture(slideSession)} />;
}
async function sharedMotionDeck() {
  const reference = await createLiveReference(
    { ...artifact, target: { kind: 'value', targetId: 'base', metricId: 'npv' } },
    snapshots[0],
    connection.provider,
    { style: 'percent', digits: 1, unit: '' },
  );
  const deck = createDeck();
  const slideId = deck.slides[0].id;
  const targetId = 'animated-fixed-quote';
  return slideMotionCommand({
    type: 'slide.step.insert',
    slideId,
    effects: [
      {
        value: {
          targetId,
          phase: 'enter',
          effect: 'fade',
          trigger: 'on-click',
          delayMs: 200,
          durationMs: 500,
        },
      },
    ],
  }).apply(insertSlideCitation(slideId, targetId, reference).apply(deck));
}
function sharedSlideFixture(content = createDeck()) {
  const authorize = ({
    liveQuote,
  }: import('@editor-platform/collaboration-adapters').SlideReferenceObject) =>
    !forbidden &&
    !!liveQuote &&
    snapshots.some(
      (version) =>
        version.versionId === liveQuote.snapshot.versionId &&
        version.contentHash === liveQuote.snapshot.contentHash &&
        JSON.stringify(version.content) === JSON.stringify(liveQuote.snapshot.content),
    );
  const codec = createSharedSlideReferenceCodec({ authorize, authorizeDetachment: authorize });
  try {
    const authority = new Authority(codec, initial('destination', codec, content));
    return <SharedSlideEditors authority={authority} codec={codec} />;
  } catch (error) {
    if (error instanceof Conflict && error.message === codec.unsupportedContentReason?.(content))
      return <p role="alert">{error.message}</p>;
    throw error;
  }
}
function SharedSlideEditors({
  authority,
  codec,
}: {
  authority: Authority<SlideContent>;
  codec: ReturnType<typeof createSharedSlideReferenceCodec>;
}) {
  const [snapshot, setSnapshot] = useState(() => authority.snapshot());
  const [current, setCurrent] = useState('A');
  const [last, setLast] = useState('');
  useEffect(() => authority.subscribe((event) => setSnapshot(event.snapshot)), [authority]);
  const principal = (actorId: string): Principal => ({
    actorId,
    clientId: actorId,
    sessionId: actorId,
    scopes: ['*'],
    writable: true,
  });
  return (
    <>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button onClick={() => setCurrent('A')}>Editor A</button>
        <button onClick={() => setCurrent('B')}>Editor B</button>
        <button onClick={() => authority.undo(principal('B'), last)}>Undo B</button>
        <output aria-label="Shared revision">{snapshot.revision}</output>
      </div>
      {['A', 'B'].map((editor) => (
        <div key={editor} hidden={current !== editor} style={{ height: 'calc(100dvh - 32px)' }}>
          <SlideSurface
            sharedReferences
            liveReferences={connection}
            content={snapshot.content}
            select={() => {}}
            execute={(command) => {
              const actor = principal(editor);
              const op = prepareEditorCommand(codec, snapshot, actor, command);
              if (!op) return false;
              const result = authority.commit(actor, op);
              if (result.status !== 'accepted') return false;
              if (editor === 'B') setLast(op.operationId);
              return true;
            }}
          />
        </div>
      ))}
    </>
  );
}
const kind = params.get('kind');
createRoot(document.getElementById('root')!).render(
  kind === 'shared-slide' || kind === 'shared-slide-motion' ? (
    sharedSlideFixture(kind === 'shared-slide-motion' ? await sharedMotionDeck() : undefined)
  ) : kind === 'slide' ? (
    <SlideFixture />
  ) : (
    <DocumentFixture />
  ),
);
