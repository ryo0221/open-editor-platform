import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createArtifact,
  MemoryStorage,
  canonicalJson,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  ArtifactEditor,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import {
  DesignSurface,
  createDesign,
  isDesignWithPaths,
  patchDesign,
  insertElement,
  reparentElement,
  type DesignContent,
} from '@editor-platform/design';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext, EditorHistoryContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
const adapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
};
function Host() {
  const access = useRef(true),
    fail = useRef(false),
    [inputs] = useState(() => new EditorInputs()),
    [storage] = useState(() => {
      const store = new MemoryStorage<Artifact<DesignContent>>(),
        put = store.put.bind(store);
      store.put = async (a) => {
        if (fail.current) throw Error('Injected storage failure');
        return put(a);
      };
      return store;
    });
  const make = (artifact: Artifact<DesignContent>) =>
    new ArtifactEditor(artifact, adapter, storage, () => access.current);
  const [host, setHost] = useState(() =>
      make(createArtifact('design', 'Independent path', createDesign())),
    ),
    [plain] = useState(() => {
      const text = sessionStorage.getItem('plain-native');
      if (!text) return undefined;
      const value: unknown = JSON.parse(text);
      if (!isDesignWithPaths(value)) throw Error('Invalid plain fixture');
      return new EditorSession<DesignContent>(value);
    }),
    [mutable] = useState<DesignContent | undefined>(() => {
      const text = sessionStorage.getItem('mutable-native');
      if (!text) return undefined;
      const value: unknown = JSON.parse(text);
      if (!isDesignWithPaths(value)) throw Error('Invalid mutable fixture');
      return value;
    }),
    [, render] = useState(0),
    [status, setStatus] = useState('Unsaved'),
    [error, setError] = useState('');
  useEffect(() => host.attach(() => render((n) => n + 1)), [host]);
  useEffect(() => host.registerInputBoundary(() => inputs.flush()), [host, inputs]);
  const run = (action: () => unknown) => {
    try {
      action();
      setError('');
    } catch (e) {
      setError(String(e));
    }
  };
  const content = mutable ?? plain?.content ?? host.content;
  async function output() {
    const json = (await host.export('native-json')) as string;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'path.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <>
      <header style={{ display: 'flex', flexWrap: 'wrap' }}>
        {mutable && (
          <button
            onClick={() => {
              const e = mutable.elements.find((e) => e.path)!;
              const path = structuredClone(e.path!);
              path.subpaths[0].anchors[0].x += 25;
              e.path = path;
              render((n) => n + 1);
            }}
          >
            Host mutate path
          </button>
        )}
        <button onClick={() => run(() => host.undo())}>Host Undo</button>
        <button onClick={() => run(() => host.redo())}>Host Redo</button>
        <button
          onClick={async () => {
            try {
              await host.save({ commitVersion: true });
              setStatus('Saved');
              setError('');
            } catch (e) {
              setStatus('Not saved');
              setError(String(e));
            }
          }}
        >
          Host Save
        </button>
        <button
          onClick={async () => {
            const saved = await storage.get(host.id);
            if (saved) setHost(make(saved));
          }}
        >
          Host Reload
        </button>
        <button onClick={() => void output()}>Host Native JSON</button>
        <label>
          Host Import
          <input
            type="file"
            onChange={async (e) => {
              try {
                const value = await loadHostArtifact(await e.target.files![0].text(), adapter);
                setHost(make(value));
                setError('');
              } catch (error) {
                setError(String(error));
              }
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            onChange={(e) => {
              access.current = !e.target.checked;
              host.refreshPermission();
              render((n) => n + 1);
            }}
          />
          Host Read only
        </label>
        <label>
          <input
            type="checkbox"
            onChange={(e) => {
              fail.current = e.target.checked;
            }}
          />
          Host Fail saves
        </label>
        <button
          onClick={() =>
            run(() => {
              const path = content.elements.find((e) => e.path);
              if (path) host.execute(patchDesign([path.id], { rotation: 35, flipX: true }));
            })
          }
        >
          Host rotate flip
        </button>
        <button
          onClick={() =>
            run(() => {
              const frame = insertElement('frame', {
                id: 'parent',
                bounds: { x: 20, y: 20, width: 700, height: 500 },
              });
              host.execute(frame);
              const path = content.elements.find((e) => e.path);
              if (path) host.execute(reparentElement(path.id, 'parent'));
            })
          }
        >
          Host parent frame
        </button>
        <output data-testid="host-status">{status}</output>
        <output data-testid="host-error">{error}</output>
      </header>
      <EditorInputsContext.Provider value={inputs}>
        <EditorHistoryContext.Provider
          value={{
            undo: () => (plain ? (plain.undo(), render((n) => n + 1)) : host.undo()),
            redo: () => (plain ? (plain.redo(), render((n) => n + 1)) : host.redo()),
          }}
        >
          <div style={{ height: 680 }}>
            <DesignSurface
              content={content}
              execute={(c) => {
                if (mutable) {
                  Object.assign(mutable, c.apply(mutable));
                  render((n) => n + 1);
                } else if (plain) {
                  if (!access.current) throw Error('Read only');
                  plain.execute(c);
                  render((n) => n + 1);
                } else host.execute(c);
                return true;
              }}
              readOnly={host.readOnly}
              select={() => {}}
              layout={{ compactBreakpoint: 0 }}
            />
          </div>
        </EditorHistoryContext.Provider>
      </EditorInputsContext.Provider>
      <pre data-testid="native" style={{ maxWidth: '100%', overflow: 'auto' }}>
        {canonicalJson(content)}
      </pre>
      <output data-testid="revision">{(plain ?? host).revision.sequence}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
