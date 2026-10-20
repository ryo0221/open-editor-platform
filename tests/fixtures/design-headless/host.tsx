import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputs, EditorSession, type EditorCommand } from '@editor-platform/editor-core';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import { DesignSurface } from '@editor-platform/design';
import {
  createDesign,
  makeDesignElement,
  assertDesignContent,
  guardDesignCommand,
  updateElement,
  exportDesignSvg,
  previewDesignIntents,
  prepareDesignIntentApplication,
  type DesignContent,
  type DesignIntentPreview,
} from '@editor-platform/design/model';

function Host() {
  const [session] = useState(() => {
    const saved = sessionStorage.getItem('design-headless-content');
    const initial = saved
      ? JSON.parse(saved)
      : {
          ...createDesign(),
          elements: [
            {
              ...makeDesignElement('frame'),
              id: 'frame',
              name: 'Main frame',
              bounds: { x: 0, y: 0, width: 600, height: 400 },
            },
          ],
        };
    assertDesignContent(initial);
    return new EditorSession<DesignContent>(initial);
  });
  const [inputs] = useState(() => new EditorInputs());
  const access = useRef(true);
  const [readOnly, setReadOnly] = useState(false);
  const [, refresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<DesignIntentPreview>();
  const [json, setJson] = useState(
    JSON.stringify(
      [
        {
          type: 'insert',
          elementType: 'text',
          options: {
            id: 'agent-title',
            parentId: 'frame',
            bounds: { x: 40, y: 50, width: 240, height: 80 },
          },
        },
        { type: 'update', id: 'agent-title', patch: { text: 'Agent title', name: 'Agent title' } },
      ],
      null,
      2,
    ),
  );
  function execute(cmd: EditorCommand<DesignContent>): boolean {
    try {
      session.execute(guardDesignCommand(cmd, () => access.current));
      setError('');
      refresh((n) => n + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  function action(fn: () => void) {
    try {
      setError('');
      inputs.flush();
      fn();
      refresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const history = (direction: 'undo' | 'redo') =>
    action(() => {
      if (!access.current) throw Error('Design is read only');
      session[direction](assertDesignContent);
    });
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorHistoryContext.Provider
        value={{ undo: () => history('undo'), redo: () => history('redo') }}
      >
        <header style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <label>
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => {
                access.current = !e.target.checked;
                setReadOnly(e.target.checked);
              }}
            />
            Host read only
          </label>
          <button onClick={() => history('undo')}>Host undo</button>
          <button onClick={() => history('redo')}>Host redo</button>
          <button
            onClick={() =>
              action(() => {
                execute(updateElement('frame', { fill: '#ddeeff' }));
              })
            }
          >
            Host edit base
          </button>
          <button
            onClick={() =>
              action(() => {
                sessionStorage.setItem('design-headless-content', JSON.stringify(session.content));
                setStatus('Saved');
              })
            }
          >
            Host save
          </button>
        </header>
        <section
          aria-label="Headless Design proposal"
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 6 }}
        >
          <label>
            Design JSON intents
            <textarea
              aria-label="Design JSON intents"
              rows={5}
              style={{ width: '100%', boxSizing: 'border-box' }}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </label>
          <div>
            <button
              onClick={() =>
                action(() => {
                  setPreview(undefined);
                  setPreview(
                    previewDesignIntents(session.content, JSON.parse(json), {
                      baseLocalRevision: session.revision,
                    }),
                  );
                })
              }
            >
              Preview intents
            </button>
            <button
              disabled={!preview}
              onClick={() =>
                action(() => {
                  if (!preview) return;
                  const command = prepareDesignIntentApplication(
                    JSON.parse(JSON.stringify(preview.intentProposal)),
                    { writable: () => access.current, readRevision: () => session.revision },
                  );
                  if (execute(command)) {
                    setPreview(undefined);
                    setStatus('Applied');
                  }
                })
              }
            >
              Apply intents
            </button>
            <button onClick={() => setPreview(undefined)}>Cancel intents</button>
          </div>
          {preview && (
            <>
              <img
                alt="Proposed Design preview"
                style={{ maxWidth: '100%', maxHeight: 160 }}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(preview.content))}`}
              />
              <pre data-testid="intent-preview" style={{ maxWidth: '100%', overflow: 'auto' }}>
                {canonicalJson(preview.content)}
              </pre>
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <output aria-label="Host action status">{status}</output>
          <output aria-label="Host history state">
            {JSON.stringify({
              sequence: session.revision.sequence,
              canUndo: session.canUndo,
              canRedo: session.canRedo,
            })}
          </output>
          <output aria-label="Host selection">{JSON.stringify(selected)}</output>
        </section>
        <div style={{ height: 600, width: '100%' }}>
          <DesignSurface
            content={session.content}
            execute={execute}
            select={(ids) => setSelected(Array.isArray(ids) ? ids : [ids])}
            readOnly={readOnly}
          />
        </div>
        <pre data-testid="design-source" style={{ maxWidth: '100%', overflow: 'auto' }}>
          {canonicalJson(session.content)}
        </pre>
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
