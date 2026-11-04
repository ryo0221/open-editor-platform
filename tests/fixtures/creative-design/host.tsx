import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, createArtifact, type Artifact } from '@editor-platform/artifact-core';
import { EditorInputs, type EditorCommand } from '@editor-platform/editor-core';
import { EditorHistoryContext, EditorInputsContext } from '@editor-platform/editor-ui';
import {
  ArtifactEditor,
  loadHostArtifact,
  serializeHostNativeArtifact,
  type EditorHostAdapter,
  type HostPendingProposal,
} from '@editor-platform/editor-host';
import { DesignSurface } from '@editor-platform/design';
import { exportDesignSvg, isDesign, type DesignContent } from '@editor-platform/design/model';
import {
  createCreativeDesignHostAdapter,
  creativeDesignAddressKey,
  creativeDesignEditCommand,
  creativeDesignFocus,
  designCreativeProposalDiff,
  prepareCreativeDesignProposal,
  type CreativeDesignAddress,
} from '@editor-platform/design/creative-proposal-diff';
import { creativeDesignFixture, replacementCoatSource } from './content';
const storageKey = 'creative-design-browser-artifact';
const adapter: EditorHostAdapter<DesignContent> = createCreativeDesignHostAdapter({
  kind: 'design',
  validate: isDesign,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none',
    shared: false,
    proposals: true,
  },
});
function Host({ artifact }: { artifact: Artifact<DesignContent> }) {
  const access = useRef(true),
    counter = useRef(0);
  const [inputs] = useState(() => new EditorInputs());
  const [editor] = useState(
    () =>
      new ArtifactEditor(
        artifact,
        adapter,
        {
          async put(value) {
            sessionStorage.setItem(storageKey, serializeHostNativeArtifact(value));
          },
        },
        () => access.current,
      ),
  );
  const [, refresh] = useState(0);
  const [readOnly, setReadOnly] = useState(false),
    [scope, setScope] = useState('A'),
    [operation, setOperation] = useState('bangs');
  const [pending, setPending] = useState<HostPendingProposal<DesignContent>>();
  const [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [focus, setFocus] = useState<ReturnType<typeof creativeDesignFocus>>();
  useEffect(() => editor.attach(() => refresh((n) => n + 1)), [editor]);
  useEffect(() => editor.registerInputBoundary(() => inputs.flush()), [editor, inputs]);
  async function action(run: () => void | Promise<void>) {
    try {
      setError('');
      await run();
      refresh((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  function address(): CreativeDesignAddress {
    return {
      componentId: 'person',
      elementId: operation,
      ...(scope === 'shared' ? {} : { instanceId: scope }),
    };
  }
  function preview() {
    if (pending && editor.proposals.some((p) => p.id === pending.id))
      editor.rejectProposal(pending.id);
    const target = address(),
      part = editor.content.components[0].elements!.find((e) => e.id === operation)!;
    const patch =
      operation === 'bangs'
        ? { bounds: { ...part.bounds, x: part.bounds.x + 25 } }
        : operation === 'eyes'
          ? { fill: '#ee7733' }
          : { src: replacementCoatSource };
    const proposal = prepareCreativeDesignProposal(
      {
        id: `creative-${++counter.current}`,
        summary: `Edit ${operation}`,
        baseLocalRevision: editor.revision,
        commands: [creativeDesignEditCommand(target, patch)],
      },
      { required: [target] },
      () => access.current,
    );
    setPending(editor.propose(proposal));
    setStatus('Preview ready');
  }
  const history = (direction: 'undo' | 'redo') => {
    void action(() => {
      editor[direction]();
    });
  };
  const execute = (value: EditorCommand<DesignContent>) => {
    try {
      editor.execute(value);
      setError('');
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  const diff =
    pending &&
    designCreativeProposalDiff.diff(pending.preview.baseContent, pending.preview.content);
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorHistoryContext.Provider
        value={{ undo: () => history('undo'), redo: () => history('redo') }}
      >
        <main style={{ maxWidth: '100%', minWidth: 0 }}>
          <h1>Creative Design API test host</h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <label>
              Scope{' '}
              <select
                aria-label="Creative scope"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="A">Instance A</option>
                <option value="shared">Shared component</option>
              </select>
            </label>
            <label>
              Part{' '}
              <select
                aria-label="Creative part"
                value={operation}
                onChange={(event) => setOperation(event.target.value)}
              >
                <option value="bangs">Bangs position</option>
                <option value="eyes">Vector eyes fill</option>
                <option value="coat">Coat image</option>
              </select>
            </label>
            <button
              onClick={() => {
                void action(preview);
              }}
            >
              Preview change
            </button>
            <button
              disabled={!pending}
              onClick={() => {
                void action(() => {
                  if (!pending) return;
                  editor.acceptProposal(pending.id);
                  setPending(undefined);
                  setStatus('Applied');
                });
              }}
            >
              Apply change
            </button>
            <button
              disabled={!pending}
              onClick={() => {
                void action(() => {
                  if (pending && editor.proposals.some((p) => p.id === pending.id))
                    editor.rejectProposal(pending.id);
                  setPending(undefined);
                  setStatus('Rejected');
                });
              }}
            >
              Reject change
            </button>
            <button onClick={() => history('undo')}>Host undo</button>
            <button onClick={() => history('redo')}>Host redo</button>
            <button
              onClick={() => {
                void action(async () => {
                  await editor.save({ commitVersion: true });
                  setStatus('Saved');
                });
              }}
            >
              Host save
            </button>
            <button
              onClick={() => {
                void action(() => {
                  editor.execute(creativeDesignEditCommand({ elementId: 'A' }, { opacity: 0.6 }));
                });
              }}
            >
              Host edit base
            </button>
            <button
              onClick={() => {
                void action(() => {
                  const next = creativeDesignFocus(editor.content, address());
                  setFocus(next);
                  editor.select({
                    addresses: [{ artifactId: editor.id, elementId: next.key }],
                  });
                });
              }}
            >
              Focus part
            </button>
            <label>
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(event) => {
                  access.current = !event.target.checked;
                  setReadOnly(event.target.checked);
                }}
              />
              Host read only
            </label>
          </div>
          {error && <p role="alert">{error}</p>}
          <output aria-label="Host action status">{status}</output>
          <output aria-label="Host history state">
            {JSON.stringify({
              sequence: editor.revision.sequence,
              canUndo: editor.canUndo,
              canRedo: editor.canRedo,
            })}
          </output>
          <output aria-label="Qualified focus">{focus ? JSON.stringify(focus) : ''}</output>
          {pending && (
            <section aria-label="Creative proposal preview">
              <img
                alt="Creative proposed preview"
                style={{ maxWidth: '100%', maxHeight: 170 }}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportDesignSvg(pending.preview.content))}`}
              />
              <pre data-testid="creative-preview" style={{ maxHeight: 100, overflow: 'auto' }}>
                {canonicalJson(pending.preview.content)}
              </pre>
              <output aria-label="Qualified changed parts">
                {JSON.stringify([...new Set(diff!.changes.map((change) => change.elementId))])}
              </output>
              <output aria-label="Creative fallback count">{diff!.fallback.length}</output>
            </section>
          )}
          <div style={{ height: 480, width: '100%', minWidth: 0 }}>
            <DesignSurface
              content={editor.content}
              execute={execute}
              select={(ids) =>
                editor.select({
                  addresses: ids.map((id) => ({
                    artifactId: editor.id,
                    elementId: creativeDesignAddressKey({ elementId: id }),
                  })),
                })
              }
              readOnly={readOnly}
              focusRequest={focus?.focusElementId ? { id: focus.focusElementId } : undefined}
            />
          </div>
          <pre
            data-testid="creative-source"
            style={{ maxWidth: '100%', maxHeight: 160, overflow: 'auto' }}
          >
            {canonicalJson(editor.content)}
          </pre>
        </main>
      </EditorHistoryContext.Provider>
    </EditorInputsContext.Provider>
  );
}
async function boot() {
  const saved = sessionStorage.getItem(storageKey);
  const artifact = saved
    ? await loadHostArtifact(saved, adapter)
    : createArtifact('design', 'Creative test', creativeDesignFixture());
  createRoot(document.getElementById('root')!).render(<Host artifact={artifact} />);
}
void boot();
