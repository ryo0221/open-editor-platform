import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { command, EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import {
  DesignSurface,
  exportDesignSvg,
  isDesign,
  type DesignContent,
} from '@editor-platform/design';
import { downloadBlob, rasterizeSvg } from '@editor-platform/canvas-ui';
import { insertSmallButton, buttonMode } from './content';
import '@editor-platform/editor-ui/styles.css';

function Host({ initial }: { initial: DesignContent }) {
  const [session] = useState(() => new EditorSession(initial));
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [, refresh] = useState(0);
  const content = session.content;
  const svg = exportDesignSvg(content, undefined, { padding: 0 });
  const execute = (edit: EditorCommand<DesignContent>) => {
    if (readonly) return false;
    session.execute(edit);
    refresh((v) => v + 1);
    return true;
  };
  const mode = async (next: 'light' | 'dark') => {
    setBusy(true);
    try {
      const changed = await buttonMode(session.content, next);
      execute(command('host.mode', 'Change mode', () => changed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}>
        <button disabled={readonly || busy} onClick={() => void mode('dark')}>
          Host dark mode
        </button>
        <button disabled={readonly || busy} onClick={() => void mode('light')}>
          Host light mode
        </button>
        <button
          disabled={readonly}
          onClick={() => {
            session.undo();
            refresh((v) => v + 1);
          }}
        >
          Host undo
        </button>
        <button
          disabled={readonly}
          onClick={() => {
            session.redo();
            refresh((v) => v + 1);
          }}
        >
          Host redo
        </button>
        <button
          onClick={() => {
            sessionStorage.setItem('design-reuse-native', JSON.stringify(content));
            setSaved(true);
          }}
        >
          Host save
        </button>
        <label>
          <input
            type="checkbox"
            aria-label="Host read only"
            checked={readonly}
            onChange={(e) => setReadonly(e.target.checked)}
          />
          Read only
        </label>
        <button
          onClick={() => downloadBlob('button.svg', new Blob([svg], { type: 'image/svg+xml' }))}
        >
          Host export SVG
        </button>
        <button
          onClick={() =>
            void rasterizeSvg(svg, 144, 40).then((bytes) =>
              downloadBlob('button.png', new Blob([new Uint8Array(bytes)], { type: 'image/png' })),
            )
          }
        >
          Host export PNG
        </button>
        {saved && <span role="status">Native saved</span>}
      </div>
      <div style={{ height: 560, minWidth: 0 }}>
        <DesignSurface content={content} execute={execute} select={() => {}} readOnly={readonly} />
      </div>
      <img
        alt="Exported button"
        src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)}
        style={{ margin: 12, maxWidth: 'calc(100% - 24px)' }}
      />
      <pre data-testid="reuse-native" style={{ display: 'none' }}>
        {JSON.stringify(content)}
      </pre>
    </>
  );
}
async function start() {
  const retained = sessionStorage.getItem('design-reuse-native');
  const initial: unknown = retained ? JSON.parse(retained) : (await insertSmallButton()).content;
  if (!isDesign(initial)) throw new Error('Invalid saved Design');
  createRoot(document.getElementById('root')!).render(<Host initial={initial} />);
}
void start();
