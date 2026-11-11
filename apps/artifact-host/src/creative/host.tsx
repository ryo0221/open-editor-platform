import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { serializeArtifact, contentHash, type Artifact } from '@editor-platform/artifact-core';
import { EditorInputs } from '@editor-platform/editor-core';
import {
  Dialog,
  EditorInputsContext,
  EditorHistoryContext,
  EditorExportGuardContext,
  isTextInput,
  useEditorWorkspace,
} from '@editor-platform/editor-ui';
import { DesignSurface } from '@editor-platform/design';
import { isDesignWithPaths } from '@editor-platform/design/model';
import { DocumentSurface } from '@editor-platform/document';
import { isDocument } from '@editor-platform/document/model';
import type { CreativeLayerConnection } from './generation';
import { CreativeCanvas } from './canvas';
import { CreativeProject } from './project';
import { CreativeNotesField } from './notes-field';
import type { CreativeSourceCard } from './types';
import { useCreativeNavigationState, type CreativeNavigationState } from './navigation-state';
import './host.css';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RelatedArtifacts<T>({
  project,
  card,
  changed,
  onError,
}: {
  project: CreativeProject<T>;
  card: CreativeSourceCard;
  changed(): void;
  onError(error: unknown): void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact<unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [versionId, setVersionId] = useState('');
  const [preview, setPreview] = useState<{ artifact: Artifact<unknown>; versionId: string }>();
  const [busy, setBusy] = useState(false);
  const refresh = () => project.availableArtifacts().then(setArtifacts, onError);
  useEffect(() => {
    void refresh();
  }, [project]); // List only on entry/explicit refresh, not a second catalog.
  const artifact = artifacts.find((a) => a.id === selected);
  const binding = project.binding(card);
  async function open(artifactId: string, version: string) {
    try {
      const a = await project.relatedArtifact(artifactId);
      const v = a?.versions.find((v) => v.versionId === version);
      if (!a || !v) throw Error('関連成果物の保存版が見つかりません。参照は保持されています。');
      if ((await contentHash(v.content)) !== v.contentHash)
        throw Error('関連成果物の保存版が破損しています。');
      setPreview({ artifact: a, versionId: version });
    } catch (error) {
      onError(error);
    }
  }
  const saved = preview?.artifact.versions.find((v) => v.versionId === preview.versionId);
  return (
    <details className="creative-related">
      <summary>関連成果物の参照</summary>
      <p>保存済みの成果物を参照できます。設定画の候補を複製して、複数の案を比較できます。</p>
      <ul>
        {binding?.related?.map((r) => (
          <li key={`${r.artifactId}:${r.versionId}`}>
            <button onClick={() => void open(r.artifactId, r.versionId)}>
              {artifacts.find((a) => a.id === r.artifactId)?.name ?? r.artifactId} /{' '}
              {r.versionId.slice(0, 12)}
            </button>
            <button
              disabled={project.source.readOnly || project.saving}
              onClick={() => {
                try {
                  project.unlinkRelated(card, r.artifactId, r.versionId);
                  changed();
                } catch (e) {
                  onError(e);
                }
              }}
            >
              参照を外す
            </button>
          </li>
        ))}
      </ul>
      <fieldset disabled={project.source.readOnly || project.saving || busy || !binding}>
        <label>
          関連成果物
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setVersionId('');
            }}
          >
            <option value="">保存済みの成果物を選ぶ</option>
            {artifacts
              .filter((a) => a.versions.length)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.kind})
                </option>
              ))}
          </select>
        </label>
        <label>
          参照する保存版
          <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
            <option value="">版を選ぶ</option>
            {artifact?.versions.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                {v.createdAt} / {v.versionId.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!selected || !versionId}
          onClick={async () => {
            setBusy(true);
            try {
              await project.linkRelated(card, selected, versionId);
              changed();
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          参照を追加
        </button>
      </fieldset>
      <button onClick={() => void refresh()}>成果物一覧を更新</button>
      {preview && saved && (
        <Dialog title="関連成果物の保存版" onClose={() => setPreview(undefined)}>
          <div className="creative-related-dialog">
            <header>
              <strong>{preview.artifact.name} / 保存版</strong>
              <button onClick={() => setPreview(undefined)}>参照を閉じる</button>
            </header>
            <p>
              {saved.versionId} · {saved.createdAt}
            </p>
            <EditorHistoryContext.Provider value={undefined}>
              <div className="creative-related-surface">
                {isDesignWithPaths(saved.content) ? (
                  <DesignSurface
                    content={saved.content}
                    execute={() => false}
                    select={() => {}}
                    readOnly
                  />
                ) : isDocument(saved.content) ? (
                  <DocumentSurface
                    content={saved.content}
                    execute={() => false}
                    select={() => {}}
                    readOnly
                  />
                ) : (
                  <>
                    <p>この形式はnative JSONで確認できます。</p>
                    <pre>{JSON.stringify(saved.content, null, 2)}</pre>
                  </>
                )}
              </div>
            </EditorHistoryContext.Provider>
            <button
              onClick={() =>
                download(`${preview.artifact.name}.json`, serializeArtifact(preview.artifact))
              }
            >
              元の成果物をJSONで取得
            </button>
          </div>
        </Dialog>
      )}
    </details>
  );
}

/** Independent consuming Host. Data/Document and Design remain native ArtifactEditors. */
export function CreativeHost<T>({
  project,
  connectSource,
  sources = [],
  initialItemId,
  focusArtwork = false,
  generation,
  returnToScene,
  worldContext,
  onActiveItem,
  onNavigationStateChange,
  canRead = () => true,
}: {
  project: CreativeProject<T>;
  worldContext?: ReactNode | ((activeItemId: string) => ReactNode);
  onActiveItem?(itemId: string): void;
  onNavigationStateChange?(state: CreativeNavigationState): void;
  generation?: CreativeLayerConnection;
  initialItemId?: string;
  focusArtwork?: boolean;
  returnToScene?: { label: string; leave(): void | Promise<void> };
  /** Trusted Host authority, rechecked when card navigation renders cached artwork. */
  canRead?(): boolean;
  connectSource?(id: string): void;
  sources?: { id: string; name: string }[];
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [inputs] = useState(() => new EditorInputs());
  const inputState = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot, inputs.getSnapshot);
  const [activeId, setActiveId] = useState(initialItemId ?? project.cards[0]?.id ?? '');
  useEffect(() => {
    onActiveItem?.(activeId);
  }, [activeId, onActiveItem]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newSource, setNewSource] = useState('');
  const workspace = useEditorWorkspace<'design' | 'source'>('design', {}, inputs, {
    pointerSelector: '.ep-canvas',
  });
  const card = project.cards.find((c) => c.id === activeId);
  const editor = card && project.editor(card);
  const contextSurface = useMemo(
    () => (typeof document === 'undefined' ? null : document.createElement('div')),
    [project],
  );
  const contextMount = useRef<HTMLDivElement | null>(null);
  const readable = canRead();
  const currentRead = useRef(readable);
  currentRead.current = readable;
  const mountContext = useCallback(
    (node: HTMLDivElement | null) => {
      contextMount.current = node;
      if (node && currentRead.current && contextSurface) node.append(contextSurface);
      else contextSurface?.remove();
    },
    [contextSurface],
  );
  useLayoutEffect(() => {
    if (readable && contextSurface) contextMount.current?.append(contextSurface);
    else contextSurface?.remove();
    return () => contextSurface?.remove();
  }, [contextSurface, readable, editor?.id, workspace.displayed]);
  const persistentContext =
    contextSurface &&
    createPortal(
      typeof worldContext === 'function' ? worldContext(activeId) : worldContext,
      contextSurface,
    );
  // Keep reference forms/controllers and their input guards mounted when native
  // content must be masked. The private DOM is detached, never merely CSS-hidden.
  const withInputs = (content: ReactNode) => (
    <EditorInputsContext.Provider value={inputs}>
      {persistentContext}
      {content}
    </EditorInputsContext.Provider>
  );
  const hostRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusArtwork)
      hostRoot.current?.querySelector('.creative-canvas')?.scrollIntoView({ block: 'start' });
  }, [focusArtwork, editor?.id]);
  const [historyOwner, setHistoryOwner] = useState<'source' | 'design'>('design');
  const historyOwnerRef = useRef(historyOwner);
  const activateHistory = (owner: 'source' | 'design') => {
    historyOwnerRef.current = owner;
    setHistoryOwner(owner);
  };
  const activeEditor = () =>
    historyOwnerRef.current === 'source' || !editor ? project.source : editor;
  const activateCanvas = (event: { target: EventTarget | null }) => {
    if (event.target instanceof Element && event.target.closest('.creative-canvas'))
      activateHistory('design');
  };
  const current = historyOwner === 'source' || !editor ? project.source : editor;
  useEffect(() => {
    activateHistory(workspace.displayed === 'source' || !editor ? 'source' : 'design');
  }, [workspace.displayed, editor?.id]);
  const fail = (e: unknown) => {
    setError(message(e));
    setNotice('');
  };
  const changed = () => {
    setError('');
    setNotice('');
    refresh();
  };
  const run = (action: () => unknown) => {
    try {
      action();
      changed();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  useEffect(() => {
    const editors = [project.source, ...project.designs.values()];
    const dispose = editors.flatMap((e) => [
      e.attach(refresh),
      e.registerInputBoundary(() => inputs.flush()),
    ]);
    return () => dispose.forEach((f) => f());
  }, [project, project.designs.size, inputs]);
  useSyncExternalStore(
    generation?.world?.subscribe ?? (() => () => {}),
    generation?.world?.getSnapshot ?? (() => 0),
    () => 0,
  );
  const dirty =
    !!name ||
    !!description ||
    !!generation?.world?.pending ||
    project.mappingDirty ||
    project.source.snapshot.dirty ||
    [...project.designs.values()].some((e) => e.snapshot.dirty) ||
    !!inputState.dirty ||
    !!inputState.composing ||
    !!inputState.settling;
  useCreativeNavigationState(
    { dirty, busy: busy || project.saving || !!generation?.world?.pending },
    onNavigationStateChange,
  );
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  const history = (direction: 'undo' | 'redo') =>
    run(() => {
      if (project.saving || busy) throw Error('保存が完了してから操作してください。');
      if (activeEditor().readOnly) throw Error('閲覧のみのため変更できません。');
      if (inputs.history(direction)) return;
      inputs.flush();
      // A pending note/property commit may activate its native owner during the flush.
      const target = activeEditor();
      if (direction === 'undo') target.undo();
      else target.redo();
    });
  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      inputs.flush();
      let nativeError: unknown;
      try {
        await project.save();
      } catch (error) {
        nativeError = error;
      }
      await generation?.world?.flush();
      if (nativeError) throw nativeError;
      setNotice('保存しました');
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const readOnly = project.source.readOnly || project.saving || busy;
  async function exportNative(which: 'source' | 'design') {
    try {
      const target = which === 'source' ? project.source : editor;
      if (!target) throw Error('設定画を開いてください。');
      const value = await target.export('native-json');
      if (typeof value !== 'string') throw Error('native JSONを取得できません。');
      download(`${target.artifact.name}.json`, value);
    } catch (e) {
      fail(e);
    }
  }
  if (!readable)
    return withInputs(
      <div className="creative-host">
        <p role="alert">正本または設定画の参照権限がありません。編集画面を表示できません。</p>
        {returnToScene && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                inputs.flush();
                await returnToScene.leave();
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {returnToScene.label}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </div>,
    );
  return withInputs(
    <>
      <EditorExportGuardContext.Provider value={() => inputs.flush()}>
        <EditorHistoryContext.Provider
          value={{
            undo: () => {
              history('undo');
            },
            redo: () => {
              history('redo');
            },
          }}
        >
          <div
            ref={hostRoot}
            className="creative-host"
            {...workspace.events}
            onKeyDown={(event) => {
              if (event.target instanceof Element && event.target.closest('dialog')) return;
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void save();
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === 'z' &&
                !isTextInput(event.target)
              ) {
                event.preventDefault();
                history(event.shiftKey ? 'redo' : 'undo');
              }
            }}
          >
            <header className="creative-header">
              <div>
                <a href="/">Editor Platform</a>
                <h1>{project.mode.title}</h1>
                <p>短い説明とラフから、設定をかたちに。</p>
              </div>
              <div
                className="creative-actions"
                data-history-owner={current.id === project.source.id ? 'source' : 'design'}
              >
                {returnToScene && (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        inputs.flush();
                        if (
                          project.mappingDirty ||
                          project.source.snapshot.dirty ||
                          [...project.designs.values()].some((e) => e.snapshot.dirty)
                        )
                          throw Error('設定と設定画を保存してからSceneへ戻ってください。');
                        await returnToScene.leave();
                      } catch (e) {
                        fail(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {returnToScene.label}
                  </button>
                )}
                <span aria-label="履歴の対象">
                  履歴：{current.id === project.source.id ? project.mode.sourceLabel : '設定画'}
                </span>
                <button
                  disabled={readOnly || (!current.canUndo && !inputState.canUndo)}
                  onClick={() => history('undo')}
                >
                  元に戻す
                </button>
                <button
                  disabled={readOnly || (!current.canRedo && !inputState.canRedo)}
                  onClick={() => history('redo')}
                >
                  やり直す
                </button>
                <button disabled={readOnly} onClick={() => void save()}>
                  設定と設定画を保存
                </button>
                <span role="status">
                  {busy ? '保存中…' : dirty ? '未保存の変更' : notice || '保存済み'}
                  {project.source.readOnly ? ' · 閲覧のみ' : ''}
                </span>
              </div>
            </header>
            {error && (
              <p role="alert" className="creative-error">
                {error}
                <button onClick={() => setError('')}>閉じる</button>
              </p>
            )}
            <div className="creative-body">
              <aside className="creative-cards" aria-label={`${project.mode.itemLabel}カード`}>
                <h2>{project.mode.itemLabel}</h2>
                <nav>
                  {project.cards.map((c) => (
                    <button
                      className={c.id === activeId ? 'active' : ''}
                      key={c.elementId}
                      aria-pressed={c.id === activeId}
                      onClick={async () => {
                        try {
                          inputs.flush();
                          await generation?.world?.assertSettled();
                          setActiveId(c.id);
                          changed();
                        } catch (error) {
                          fail(error);
                        }
                      }}
                    >
                      <small>{c.id}</small>
                      <strong>{c.name || '名前なし'}</strong>
                      <span>{c.summary || '説明を加えて始めましょう'}</span>
                    </button>
                  ))}
                </nav>
                <details>
                  <summary>{project.mode.itemLabel}を追加</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      run(() => {
                        inputs.flush();
                        project.source.execute(
                          project.mode.create(project.source.content, name, description),
                        );
                        activateHistory('source');
                        setActiveId(project.cards.at(-1)!.id);
                        setName('');
                        setDescription('');
                      });
                    }}
                  >
                    <fieldset disabled={readOnly}>
                      <label>
                        名前
                        <input required value={name} onChange={(e) => setName(e.target.value)} />
                      </label>
                      <label>
                        短い説明
                        <textarea
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                        />
                      </label>
                      <button type="submit">追加する</button>
                    </fieldset>
                  </form>
                </details>
                {connectSource && (
                  <details>
                    <summary>既存の{project.mode.sourceLabel}に接続</summary>
                    <p>
                      元の成果物をそのまま編集します。同じ成果物を別のタブで同時編集しないでください。
                    </p>
                    <label>
                      正本の成果物
                      <select value={newSource} onChange={(e) => setNewSource(e.target.value)}>
                        <option value="">選択してください</option>
                        {sources.map((s) => (
                          <option value={s.id} key={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={!newSource || dirty || busy}
                      onClick={() => connectSource(newSource)}
                    >
                      接続する
                    </button>
                    {dirty && <p>変更を保存してから接続を切り替えてください。</p>}
                  </details>
                )}
              </aside>
              <main
                className="creative-studio"
                onFocusCapture={activateCanvas}
                onPointerDownCapture={activateCanvas}
                onClickCapture={activateCanvas}
              >
                {card ? (
                  <>
                    <div className="creative-item-heading">
                      <div>
                        <small>{card.id}</small>
                        <h2>{card.name}</h2>
                      </div>
                      <div role="group" aria-label="制作画面">
                        <button
                          aria-pressed={workspace.requested === 'design'}
                          onClick={() => workspace.request('design')}
                        >
                          設定とビジュアル
                        </button>
                        <button
                          aria-pressed={workspace.requested === 'source'}
                          onClick={() => workspace.request('source')}
                        >
                          {project.mode.sourceLabel}を開く
                        </button>
                      </div>
                    </div>
                    {workspace.pending && <p role="status">{workspace.reason}</p>}
                    {workspace.displayed === 'source' ? (
                      <div
                        className="creative-source"
                        onFocusCapture={() => activateHistory('source')}
                        onPointerDownCapture={() => activateHistory('source')}
                        onClickCapture={() => activateHistory('source')}
                      >
                        {project.mode.sourceView({
                          content: project.source.content,
                          readOnly,
                          execute: (cmd) =>
                            run(() => {
                              activateHistory('source');
                              project.source.execute(cmd);
                            }),
                          focus: { artifactId: project.source.id, elementId: card.elementId },
                        })}
                      </div>
                    ) : (
                      <>
                        <details className="creative-notes" open>
                          <summary>設定メモ · {project.mode.sourceLabel}と同期</summary>
                          <fieldset disabled={readOnly}>
                            {card.fields
                              .filter((f) => f.editable)
                              .map((field) => (
                                <CreativeNotesField
                                  key={`${card.elementId}:${field.id}`}
                                  {...{ project, card, field, changed }}
                                  activateSource={() => activateHistory('source')}
                                  onError={fail}
                                />
                              ))}
                          </fieldset>
                          {card.fields.some(
                            (f) => !f.editable && f.value && f.value !== card.id,
                          ) && (
                            <div className="creative-source-notes">
                              <p>次の項目は元の{project.mode.sourceLabel}で確認・編集できます。</p>
                              <dl>
                                {card.fields
                                  .filter((f) => !f.editable && f.value && f.value !== card.id)
                                  .map((field) => (
                                    <div key={field.id}>
                                      <dt>{field.label}</dt>
                                      <dd>{field.value}</dd>
                                    </div>
                                  ))}
                              </dl>
                            </div>
                          )}
                        </details>
                        {editor ? (
                          <>
                            {project.problem(card) && (
                              <p role="alert" className="creative-error">
                                {project.problem(card)} 保存して対応を確認できます。
                              </p>
                            )}
                            <CreativeCanvas
                              worldContext={<div ref={mountContext} />}
                              generation={{
                                ...generation,
                                mayRead: () => canRead() && (generation?.mayRead?.() ?? true),
                              }}
                              key={`${card.id}:${editor.id}`}
                              project={project}
                              card={card}
                              changed={() => {
                                activateHistory('design');
                                changed();
                              }}
                              onError={fail}
                            />
                            <RelatedArtifacts
                              project={project}
                              card={card}
                              changed={changed}
                              onError={fail}
                            />
                          </>
                        ) : (
                          <div className="creative-start">
                            <h3>この{project.mode.itemLabel}の設定画を作りましょう</h3>
                            <p>
                              ラフを描き、部位を選び、衣装や雰囲気の候補を比べられます。後から自由に描き足せます。
                            </p>
                            <button
                              disabled={readOnly}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  inputs.flush();
                                  await project.ensureDesign(card);
                                  changed();
                                } catch (e) {
                                  fail(e);
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              設定画を作る
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    <details className="creative-export">
                      <summary>成果物を保存・持ち出す</summary>
                      <p>
                        設定メモは{project.mode.sourceLabel}
                        、ビジュアルはDesignとして保存されます。選択候補と関連参照はこのHostが保存します。
                      </p>
                      <button onClick={() => void exportNative('source')}>正本のnative JSON</button>
                      {editor && (
                        <button onClick={() => void exportNative('design')}>
                          設定画のnative JSON
                        </button>
                      )}
                      <button
                        onClick={() =>
                          download(
                            'creative-host-references.json',
                            JSON.stringify(project.mapping, null, 2),
                          )
                        }
                      >
                        候補と参照の対応表
                      </button>
                    </details>
                  </>
                ) : (
                  <p>{project.mode.itemLabel}を追加して制作を始めてください。</p>
                )}
              </main>
            </div>
          </div>
        </EditorHistoryContext.Provider>
      </EditorExportGuardContext.Provider>
    </>,
  );
}
