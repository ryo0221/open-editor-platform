import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { contentHash } from '@editor-platform/artifact-core';
import { ReferenceError, type ReferenceSnapshot } from '@editor-platform/artifact-references';
import { type LiveReferenceConnection } from '@editor-platform/artifact-references/react';
import { EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { DocumentSurface, createDocument } from '@editor-platform/document';
import { SlideSurface, createDeck } from '@editor-platform/slide';
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
createRoot(document.getElementById('root')!).render(
  params.get('kind') === 'slide' ? <SlideFixture /> : <DocumentFixture />,
);
