import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { DocumentSurface, type DocumentContent } from '@editor-platform/document';
import '@editor-platform/editor-ui/styles.css';
const source: DocumentContent = {
  schemaVersion: 2,
  blocks: Array.from({ length: 400 }, (_, i) => [
    {
      id: `heading-${i}`,
      type: 'heading' as const,
      level: 2,
      text: `Section ${i}: editable document`,
    },
    {
      id: `body-${i}`,
      type: 'paragraph' as const,
      text: 'This independent Host keeps native editing, Undo and external content replacement. 日本語の長い本文も入力した部分だけを更新します。 '.repeat(
        2,
      ),
    },
  ]).flat(),
};
declare global {
  interface Window {
    documentInputProbe: {
      samples: number[];
      commits: { retained: number; hostMs: number }[];
      native(): DocumentContent;
      sourceBytes: number;
      blocks: number;
      skipped(): string[];
    };
  }
}
const samples: number[] = [],
  commits: { retained: number; hostMs: number }[] = [];
const skipped = new Set<string>();
document.addEventListener(
  'contentvisibilityautostatechange',
  (event) => {
    const id = event.target instanceof HTMLElement ? event.target.dataset.blockId : undefined;
    if (!id) return;
    if ((event as Event & { skipped: boolean }).skipped) skipped.add(id);
    else skipped.delete(id);
  },
  true,
);
document.addEventListener(
  'beforeinput',
  () => {
    const start = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => samples.push(performance.now() - start)),
    );
  },
  true,
);
function Host() {
  const [session] = useState(() => new EditorSession(source));
  const [snapshot, setSnapshot] = useState(() => deepFreeze(session.content));
  const current = useRef(snapshot);
  const copy = new URLSearchParams(location.search).has('copy');
  const [selectedId, setSelectedId] = useState<string>();
  window.documentInputProbe = {
    samples,
    commits,
    native: () => session.content,
    sourceBytes: new TextEncoder().encode(source.blocks.map((block) => block.text).join('\n'))
      .length,
    blocks: source.blocks.length,
    skipped: () =>
      [...skipped].filter((id) => {
        const node = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
        return node && getComputedStyle(node).contentVisibility === 'auto';
      }),
  };
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div>
        <button
          onClick={() => {
            const next = session.undo();
            current.current = deepFreeze(next);
            setSnapshot(copy ? clone(next) : current.current);
          }}
        >
          Host undo
        </button>
        <button
          onClick={() => {
            const next = session.redo();
            current.current = deepFreeze(next);
            setSnapshot(copy ? clone(next) : current.current);
          }}
        >
          Host redo
        </button>
        <button
          onClick={() => {
            const next = session.executeView({
              type: 'host.external',
              label: 'External edit',
              apply: (value) => ({
                ...value,
                blocks: value.blocks.map((block, index) =>
                  index === 3
                    ? { ...block, text: 'External content', rich: [{ text: 'External content' }] }
                    : block,
                ),
              }),
            });
            current.current = next;
            setSnapshot(copy ? clone(next) : next);
          }}
        >
          Host external edit
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DocumentSurface
          content={snapshot}
          selectedId={selectedId}
          select={setSelectedId}
          execute={(command) => {
            const start = performance.now();
            const next = session.executeView(command);
            commits.push({
              retained: next.blocks.filter(
                (block, index) => block === current.current.blocks[index],
              ).length,
              hostMs: performance.now() - start,
            });
            current.current = next;
            setSnapshot(copy ? clone(next) : next);
          }}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('strict') ? (
    <StrictMode>
      <Host />
    </StrictMode>
  ) : (
    <Host />
  ),
);
