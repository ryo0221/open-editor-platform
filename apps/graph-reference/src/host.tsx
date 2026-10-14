/** Independent Host: public packages + its own reference fixture/container CSS. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { EditorInputsContext, EditorHistoryContext, isTextInput } from '@editor-platform/editor-ui';
import {
  canonicalJson,
  clone,
  commitVersion,
  contentHash,
  createArtifact,
  IndexedDBStorage,
  serializeArtifact,
  updateDraft,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  EditorSession,
  EditorInputs,
  command,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  DataSurface,
  DataSession,
  isStructuredData,
  restoreDataVersion,
  type StructuredData,
} from '@editor-platform/structured-data';
import { DataGraphSurface, createDataGraphFixture } from '@editor-platform/structured-data-graph';
import {
  GraphSurface,
  GraphSession,
  GraphBinding,
  createRelationGraph,
  relationProfile,
  readGraphArtifact,
  readGraphArtifactFile,
  isGraphDocument,
  graphCommand,
  prepareGraphDefinition,
  validateGraph,
  isGraphProfile,
  type GraphDefinitionSource,
  type GraphDocument,
  type GraphProjection,
  type LayoutSidecar,
  type AdapterProposal,
} from '@editor-platform/structured-graph';
import {
  createDefinitionAdapter,
  publishedDefinition,
  reorderReferencePhase,
  isReferenceDefinition,
  referenceEdgeId,
  type ReferenceDefinition,
} from './definition';
import './host.css';
type Source = GraphDocument | StructuredData | ReferenceDefinition | GraphDefinitionSource;
type Mode = 'native' | 'data' | 'definition' | 'profile';
interface SavedHost extends Artifact<Source> {
  layout?: LayoutSidecar;
}
const storage = new IndexedDBStorage<SavedHost>('independent-graph-host');
const sourceKind = (mode: Mode) =>
  mode === 'native'
    ? 'structured-graph'
    : mode === 'data'
      ? 'data'
      : mode === 'profile'
        ? 'graph-definition-source'
        : 'reference-definition';
const factory = (mode: Mode): Source =>
  mode === 'native'
    ? createRelationGraph()
    : mode === 'data'
      ? createDataGraphFixture()
      : mode === 'profile'
        ? { graph: createRelationGraph(), profile: clone(relationProfile) }
        : clone(publishedDefinition);
const isDefinitionSource = (value: Source): value is GraphDefinitionSource =>
  'graph' in value &&
  'profile' in value &&
  isGraphDocument(value.graph) &&
  isGraphProfile(value.profile) &&
  !validateGraph(value.graph, value.profile).some((diagnostic) => diagnostic.blocking);
const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
      new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
        type: 'application/json',
      }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function HostEditor({ mode, inputs }: { mode: Mode; inputs: EditorInputs }) {
  const inputStatus = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);
  const [record, setRecord] = useState<SavedHost>(() => ({
    ...createArtifact(sourceKind(mode), `Independent ${mode}`, factory(mode)),
    id: `graph-host-${mode}`,
  }));
  const [ready, setReady] = useState(false),
    [readOnly, setReadOnly] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('Loading'),
    [selected, setSelected] = useState<string>(),
    [proposal, setProposal] = useState<AdapterProposal>(),
    [proposalView, setProposalView] = useState<GraphProjection>();
  const [proposedPurpose, setProposedPurpose] = useState('Proposal purpose');
  const [render, setRender] = useState(0),
    [layout, setLayout] = useState<LayoutSidecar>();
  const pending = useRef(record),
    readonlyRef = useRef(readOnly),
    failNext = useRef(false),
    session = useRef<EditorSession<Source> | undefined>(undefined),
    native = useRef<GraphSession | undefined>(undefined),
    data = useRef<DataSession | undefined>(undefined),
    saveQueue = useRef(Promise.resolve()),
    busy = useRef(false),
    importRequest = useRef(0),
    alive = useRef(true);
  readonlyRef.current = readOnly;
  function install(value: SavedHost) {
    pending.current = value;
    setRecord(value);
    setLayout(value.layout);
    if (mode === 'native') {
      if (!isGraphDocument(value.draft.content)) throw new Error('Invalid Graph content');
      native.current = new GraphSession(value.draft.content, relationProfile);
    } else if (mode === 'data') {
      if (!isStructuredData(value.draft.content)) throw new Error('Invalid Data content');
      data.current = new DataSession(value.draft.content);
    } else {
      if (
        mode === 'profile'
          ? !isDefinitionSource(value.draft.content)
          : !isReferenceDefinition(value.draft.content)
      )
        throw new Error('Invalid Definition content');
      session.current = new EditorSession(value.draft.content);
    }
  }
  useEffect(() => {
    let cancelled = false;
    alive.current = true;
    void storage
      .get(record.id)
      .then(async (saved) => {
        if (cancelled) return;
        if (saved?.kind !== undefined && saved.kind !== sourceKind(mode))
          throw new Error('Stored source kind mismatch');
        if (saved?.kind === 'structured-graph')
          await readGraphArtifact(serializeArtifact(saved), (id, version) =>
            id === relationProfile.id && version === relationProfile.version
              ? relationProfile
              : undefined,
          );
        if (cancelled) return;
        install(saved ?? pending.current);
        setReady(true);
        setStatus(saved ? 'Reloaded locally' : 'Ready');
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setStatus('Load failed');
        }
      });
    return () => {
      cancelled = true;
      alive.current = false;
      importRequest.current++;
    };
    // This Host editor is remounted for each source mode.
  }, []);
  const current = () =>
    mode === 'native'
      ? native.current!.content
      : mode === 'data'
        ? data.current!.content
        : session.current!.content;
  const revision = () =>
    canonicalJson(
      mode === 'native'
        ? native.current!.revision
        : mode === 'data'
          ? data.current!.revision
          : session.current!.revision,
    );
  const changed = (content: Source) => {
    const next = updateDraft(pending.current, content);
    pending.current = next;
    setRecord(next);
    setStatus('Unsaved draft');
    setRender((n) => n + 1);
    setError('');
  };
  const execute = <T extends Source>(cmd: EditorCommand<T>) => {
    if (readonlyRef.current || !ready) throw new Error('Host is read only or not ready');
    const next =
      mode === 'native'
        ? native.current!.executeCommand(cmd as EditorCommand<GraphDocument>)
        : mode === 'data'
          ? data.current!.execute(cmd as EditorCommand<StructuredData>)
          : session.current!.execute(cmd as EditorCommand<Source>);
    changed(next);
    return true;
  };
  const latest = useRef({ current, revision, execute, ready, layout });
  latest.current = { current, revision, execute, ready, layout };
  const [binding] = useState(
    () =>
      new GraphBinding<ReferenceDefinition>({
        sourceId: 'fictional-definition',
        adapter: createDefinitionAdapter(),
        read: () => ({
          content: latest.current.current() as ReferenceDefinition,
          revision: latest.current.revision(),
          readOnly: readonlyRef.current || !latest.current.ready,
        }),
        execute: (cmd) => latest.current.execute(cmd),
        getLayout: () => latest.current.layout,
        setLayout: (sidecar) => {
          if (readonlyRef.current) throw new Error('Host is read only');
          setLayout(sidecar);
          const next = { ...pending.current, layout: sidecar };
          pending.current = next;
          setRecord(next);
          setStatus('Unsaved layout');
        },
      }),
  );
  async function persistSnapshot(snapshot: SavedHost) {
    setStatus('Saving');
    const task = saveQueue.current
      .catch(() => {})
      .then(async () => {
        if (failNext.current) {
          failNext.current = false;
          throw new Error('Reference storage failure');
        }
        await storage.put(snapshot);
      });
    saveQueue.current = task;
    try {
      await task;
      setStatus(
        canonicalJson(snapshot) === canonicalJson(pending.current)
          ? 'Saved locally'
          : 'Unsaved draft',
      );
      setError('');
    } catch (e) {
      setError(`${String(e)}. Draft retained; retry Save or Export.`);
      setStatus('Not saved');
    }
  }
  async function save() {
    if (busy.current || readonlyRef.current || !ready) return;
    busy.current = true;
    try {
      flushSync(() => inputs.flush());
      await persistSnapshot(clone(pending.current));
    } catch (error) {
      setError(String(error));
      setStatus('Uncommitted input; save blocked');
    } finally {
      busy.current = false;
    }
  }
  async function commit() {
    if (readonlyRef.current || busy.current || !ready) return;
    try {
      flushSync(() => inputs.flush());
    } catch (error) {
      setError(String(error));
      setStatus('Uncommitted input; save blocked');
      return;
    }
    busy.current = true;
    const snapshot = clone(pending.current);
    setStatus('Creating version');
    try {
      const committed = await commitVersion(snapshot, 'reference-host', 'Reference version');
      if (readonlyRef.current) throw new Error('Host is read only');
      const latest = pending.current;
      const next = {
        ...latest,
        versions: committed.versions,
        draft: { ...latest.draft, baseVersionId: committed.draft.baseVersionId },
      };
      pending.current = next;
      setRecord(next);
      await persistSnapshot(clone(next));
    } catch (e) {
      setError(String(e));
      setStatus('Version not saved; draft retained');
    } finally {
      busy.current = false;
    }
  }
  function history(direction: 'undo' | 'redo') {
    if (readonlyRef.current || !ready) return;
    let handled = false;
    flushSync(() => {
      handled = inputs.history(direction);
    });
    if (handled) return;
    const owner =
      mode === 'native' ? native.current! : mode === 'data' ? data.current! : session.current!;
    changed(owner[direction]());
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
      if (!isTextInput(event.target) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        history(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  async function restore(versionId: string) {
    if (readonlyRef.current || busy.current || !ready) return;
    try {
      flushSync(() => inputs.flush());
    } catch (error) {
      setError(String(error));
      setStatus('Uncommitted input; restore blocked');
      return;
    }
    busy.current = true;
    try {
      if (mode === 'data') {
        const cmd = await restoreDataVersion(versionId, () => ({
          artifact: pending.current as Artifact<StructuredData>,
          revision: revision(),
          readOnly: readonlyRef.current || !ready || !alive.current,
        }));
        execute(cmd);
      } else {
        const version = pending.current.versions.find((v) => v.versionId === versionId);
        if (!version) throw new Error('Saved version is missing');
        execute({
          type: 'host.restore',
          label: 'Restore version',
          apply: () => clone(version.content),
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
    }
  }
  async function importNative(file: File) {
    if (readonlyRef.current || busy.current || !ready || mode !== 'native') return;
    try {
      flushSync(() => inputs.flush());
    } catch (error) {
      setError(String(error));
      return;
    }
    const request = ++importRequest.current,
      target = pending.current.id,
      base = canonicalJson(pending.current),
      sourceRevision = revision();
    try {
      const imported = await readGraphArtifactFile(file, (id, version) =>
        id === 'relations' && version === 1 ? relationProfile : undefined,
      );
      if (!alive.current || request !== importRequest.current) return;
      if (readonlyRef.current) throw new Error('Host is read only');
      if (busy.current) throw new Error('Another save or Commit is in progress');
      if (
        pending.current.id !== target ||
        revision() !== sourceRevision ||
        canonicalJson(pending.current) !== base
      )
        throw new Error('The current draft changed while importing; choose the file again');
      const next = {
        ...imported,
        id: target,
        versions: imported.versions.map((v) => ({ ...v, artifactId: target })),
      };
      install(next);
      setStatus('Imported; save to retain');
      setError('');
    } catch (e) {
      if (alive.current && request === importRequest.current)
        setError(`Import failed: ${String(e)}. Current draft and history retained.`);
    }
  }
  let projection: GraphProjection | undefined;
  let projectionError = '';
  if (ready && mode === 'definition')
    try {
      projection = binding.project();
    } catch (e) {
      projectionError = String(e);
    }
  const owner =
    mode === 'native' ? native.current : mode === 'data' ? data.current : session.current;
  const displayedProjection = proposalView ?? projection;
  return (
    <EditorHistoryContext.Provider
      value={{ undo: () => history('undo'), redo: () => history('redo') }}
    >
      <>
        <div className="graph-host-actions">
          <label>
            <input
              type="checkbox"
              aria-label="Host read only"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
            />
            Read only
          </label>
          <button
            disabled={!ready || readOnly || (!owner?.canUndo && !inputStatus.canUndo)}
            onClick={() => history('undo')}
          >
            Host Undo
          </button>
          <button
            disabled={!ready || readOnly || (!owner?.canRedo && !inputStatus.canRedo)}
            onClick={() => history('redo')}
          >
            Host Redo
          </button>
          <button disabled={!ready || readOnly} onClick={() => void save()}>
            Save draft
          </button>
          <button disabled={!ready || readOnly} onClick={() => void commit()}>
            Commit version
          </button>
          <button
            disabled={!ready}
            onClick={() => {
              try {
                flushSync(() => inputs.flush());
                download('graph-artifact.json', serializeArtifact(pending.current));
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            Export native JSON
          </button>
          <button
            disabled={!ready || readOnly}
            onClick={() => {
              failNext.current = true;
              setStatus('Next save will fail');
            }}
          >
            Fail next save
          </button>
          {mode === 'native' && (
            <label>
              Import native JSON
              <input
                aria-label="Import graph JSON"
                type="file"
                accept=".json"
                disabled={readOnly || !ready || busy.current}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importNative(file);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          {mode === 'definition' && (
            <>
              <button
                disabled={!ready || readOnly}
                onClick={() => {
                  try {
                    execute(reorderReferencePhase('phase-plan', 'phase-research'));
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Move Plan before Research
              </button>
              <button disabled={!ready} onClick={() => download('definition.json', current())}>
                Export Definition
              </button>
              <label>
                Proposed Research purpose
                <input
                  aria-label="Proposed Research purpose"
                  value={proposedPurpose}
                  disabled={!ready || readOnly}
                  onChange={(e) => setProposedPurpose(e.target.value)}
                />
              </label>
              <button
                disabled={!ready || readOnly}
                onClick={() => {
                  try {
                    const view = binding.preview([
                      {
                        type: 'set-attribute',
                        scope: 'node',
                        id: 'phase-research',
                        path: ['purpose'],
                        value: proposedPurpose,
                      },
                    ]);
                    setProposal(view.proposal);
                    setProposalView(view.projection);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Preview reference proposal
              </button>
            </>
          )}
          <span role="status">{status}</span>
          {!!(inputStatus.dirty || inputStatus.composing) && <span>未確定の入力があります</span>}
          <span>Versions: {record.versions.length}</span>
        </div>
        {error && <p role="alert">{error}</p>}
        {projectionError && <p role="alert">{projectionError}</p>}
        {ready && !projectionError && (
          <div className="graph-host-surface" data-render={render}>
            {mode === 'native' && (
              <GraphSurface
                content={current() as GraphDocument}
                profile={relationProfile}
                stamp={native.current!.stamp}
                select={setSelected}
                selectedId={selected}
                readOnly={readOnly}
                sourceActions={{
                  owner: 'Reference Host · relations',
                  readOnlyReason:
                    'このサンプルの定義は固定です。編集可能なProfileを選択すると移行プレビューを確認できます。',
                }}
                onEdit={(intents, base) => {
                  if (readonlyRef.current) throw new Error('Host is read only');
                  changed(native.current!.execute(intents, base));
                }}
              />
            )}
            {mode === 'profile' &&
              isDefinitionSource(current()) &&
              (() => {
                const source = current() as GraphDefinitionSource;
                return (
                  <GraphSurface
                    content={source.graph}
                    profile={source.profile}
                    stamp={revision()}
                    select={setSelected}
                    selectedId={selected}
                    readOnly={readOnly}
                    onEdit={(intents, base) => {
                      if (base !== revision()) throw new Error('Stale Graph source');
                      execute(
                        command<GraphDefinitionSource>(
                          'host.graph',
                          'Edit native Graph source',
                          (current) => {
                            if (base !== revision()) throw new Error('Stale Graph source');
                            return {
                              ...current,
                              graph: graphCommand(current.profile, intents).apply(current.graph),
                            };
                          },
                        ),
                      );
                    }}
                    sourceActions={{
                      owner: 'Reference Host · editable Profile',
                      readOnlyReason: readOnly ? 'このHostでは定義を編集できません。' : undefined,
                      onEditDefinition: (request) => {
                        const currentSource = current() as GraphDefinitionSource;
                        if (canonicalJson(currentSource) !== request.base)
                          throw new Error('Graph or Profile changed before migration');
                        execute(
                          prepareGraphDefinition(
                            currentSource,
                            request.change,
                            () => !readonlyRef.current && ready,
                          ),
                        );
                      },
                    }}
                  />
                );
              })()}
            {mode === 'data' && (
              <DataSurface
                content={current() as StructuredData}
                execute={execute}
                select={(id) => setSelected(id)}
                readOnly={readOnly}
                renderGraph={(props) => <DataGraphSurface {...props} sourceRevision={revision()} />}
              />
            )}
            {mode === 'definition' && displayedProjection && (
              <GraphSurface
                content={displayedProjection.graph}
                profile={displayedProjection.profile}
                stamp={displayedProjection.stamp}
                diagnostics={displayedProjection.diagnostics}
                select={setSelected}
                selectedId={selected}
                edgeId={(from, type) =>
                  referenceEdgeId(
                    type,
                    from,
                    new Set([
                      displayedProjection.graph.id,
                      ...displayedProjection.graph.nodes.map((node) => node.id),
                    ]),
                  )
                }
                readOnly={readOnly || !!proposal}
                onEdit={(intents, base) => binding.apply(intents, base)}
              />
            )}
          </div>
        )}
        {proposal && (
          <section aria-label="Proposal preview">
            <p>Preview has not changed the Definition.</p>
            <button
              disabled={readOnly}
              onClick={() => {
                try {
                  binding.applyProposal(proposal);
                  setProposal(undefined);
                  setProposalView(undefined);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Apply reference proposal
            </button>
            <button
              onClick={() => {
                setProposal(undefined);
                setProposalView(undefined);
              }}
            >
              Reject reference proposal
            </button>
          </section>
        )}
        <details>
          <summary>Saved versions</summary>
          {record.versions.map((v, i) => (
            <article key={v.versionId}>
              <span>
                Version {i + 1}: {v.contentHash}
              </span>
              <button disabled={readOnly} onClick={() => void restore(v.versionId)}>
                Restore version {i + 1}
              </button>
            </article>
          ))}
        </details>
        <details>
          <summary>Canonical source</summary>
          <pre data-testid="graph-source">{canonicalJson(record.draft.content)}</pre>
          <output data-testid="graph-revision">{ready ? revision() : ''}</output>
          <output data-testid="graph-layout">{canonicalJson(layout)}</output>
          <button
            onClick={() =>
              void contentHash(record.draft.content).then((hash) =>
                setStatus(`Content hash: ${hash}`),
              )
            }
          >
            Show content hash
          </button>
        </details>
      </>
    </EditorHistoryContext.Provider>
  );
}
function Host() {
  const [mode, setMode] = useState<Mode>('native');
  const [inputs] = useState(() => new EditorInputs());
  const [error, setError] = useState('');
  return (
    <EditorInputsContext.Provider value={inputs}>
      <main className="graph-reference-host">
        <h1>Independent Structured Graph Host</h1>
        <p>
          Native graph · existing Data · fictional Definition. Save and publication belong to this
          Host.
        </p>
        <label>
          Source
          <select
            aria-label="Graph source"
            value={mode}
            onChange={(e) => {
              try {
                flushSync(() => inputs.flush());
                setMode(e.target.value as Mode);
                setError('');
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            <option value="native">Native Graph</option>
            <option value="data">Data Grid / Form / Graph</option>
            <option value="definition">Fictional Definition adapter</option>
            <option value="profile">Editable Profile / migration preview</option>
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <HostEditor key={mode} mode={mode} inputs={inputs} />
      </main>
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
