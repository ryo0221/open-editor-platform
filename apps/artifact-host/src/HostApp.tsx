import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  createArtifact,
  clone,
  canonicalJson,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  ArtifactEditor,
  EditorHostError,
  HostAccessDisplay,
  scheduleAccessExpiry,
  loadHostArtifact,
  type HostAccessAdapter,
} from '@editor-platform/editor-host';
import { SlideSurface } from '@editor-platform/slide';
import { exportSlideSvg } from '@editor-platform/slide/model';
import type { Region } from '@editor-platform/editor-core';
import { WhiteboardSurface } from '@editor-platform/whiteboard';
import { isWhiteboard } from '@editor-platform/whiteboard/model';
import { DesignSurface } from '@editor-platform/design';
import { isDesign, updateElement, type DesignContent } from '@editor-platform/design/model';
import { DataSurface } from '@editor-platform/structured-data';
import { isStructuredData } from '@editor-platform/structured-data/model';
import { exportDesignReact, acceptDesignConversion } from '@editor-platform/design-react-core';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import {
  EditorExportGuardContext,
  EditorUncommittedInputContext,
} from '@editor-platform/editor-ui';
import {
  hostAdapters,
  domainExecute,
  isCode,
  codeSource,
  nativeResolution,
  isStaticSlide,
  type HostContent,
} from './model';
import { isCadDocument } from '@editor-platform/cad-core';
import type { CadKernelBuild } from '@editor-platform/cad-kernel-occt';
import { compileProject } from './compiler';
import { PreviewFrame } from './PreviewFrame';
import './host.css';

// Three.js and the kernel adapter load only when a CAD artifact opens.
const CadArtifactView = lazy(() => import('./cad'));

function compileDesignPreview(content: DesignContent, files: Record<string, string>) {
  const pages = content.web?.pages;
  const page = pages?.find((p) => p.path === '/') ?? pages?.[0];
  if (!page) throw Error('Designに宣言されたページがありません。');
  return compileProject(files, `${page.symbol}.tsx`, page.symbol);
}
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const labels: Record<string, string> = {
  slide: 'Slide',
  whiteboard: 'Whiteboard',
  design: 'React / Design',
  code: 'Code (Host拡張)',
  data: 'Data / Kanban',
  cad: '3D CAD',
};
export interface HostAppProps {
  samples: Artifact<HostContent>[];
  storage: StorageAdapter<Artifact<HostContent>>;
  previewDocument: string;
  accessAdapter?: HostAccessAdapter;
  codeSurface?(host: ArtifactEditor<HostContent>): ReactNode;
  header?: ReactNode;
  /** Verified CAD kernel build; without it CAD artifacts stay readable but cannot evaluate. */
  cadKernel?: CadKernelBuild | null;
}
function EditorView({
  host,
  previewDocument,
  codeSurface,
  cadKernel,
  onError,
}: {
  host: ArtifactEditor<HostContent>;
  previewDocument: string;
  codeSurface?: HostAppProps['codeSurface'];
  cadKernel?: CadKernelBuild | null;
  onError(error: unknown): void;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.attach(refresh), [host]);
  const { content, readOnly } = host.snapshot;
  const select = (ids: string[], region?: Region) =>
    host.select({
      addresses: ids.map((elementId) => ({
        artifactId: host.id,
        elementId,
        ...(region ? { region } : {}),
      })),
    });
  const panels = host.viewState.get('panels') as
    | { left: boolean; right: boolean; rightWidth: number; tab: 'properties'; focus: boolean }
    | undefined;
  const layout = {
    viewKey: 'artifact-' + host.id,
    panels,
    onPanelsChange: (value: unknown) => {
      host.viewState.set('panels', value);
      refresh();
    },
    defaultPanels: { left: true, right: window.innerWidth > 1050 },
  };
  if (host.artifact.kind === 'slide' && isStaticSlide(content))
    return (
      <OfficeExportHost
        formats={{ pptx: false, reason: 'Office出力はこのHostの対象外です。SVGをご利用ください。' }}
        capture={() => {
          throw Error('Office出力はこのHostの対象外です。SVGをご利用ください。');
        }}
      >
        <SlideSurface
          content={content}
          readOnly={readOnly}
          execute={domainExecute(host, isStaticSlide)}
          select={(ids, region) => select(Array.isArray(ids) ? ids : [ids], region)}
          layout={layout}
        />
      </OfficeExportHost>
    );
  if (host.artifact.kind === 'whiteboard' && isWhiteboard(content))
    return (
      <WhiteboardSurface
        content={content}
        readOnly={readOnly}
        execute={domainExecute(host, isWhiteboard)}
        select={select}
        layout={layout}
      />
    );
  if (host.artifact.kind === 'data' && isStructuredData(content))
    return (
      <DataSurface
        content={content}
        readOnly={readOnly}
        execute={domainExecute(host, isStructuredData)}
        select={(id, region) => select([id], region)}
        layout={layout}
      />
    );
  if (host.artifact.kind === 'design' && isDesign(content))
    return (
      <DesignSurface
        content={content}
        readOnly={readOnly}
        execute={domainExecute(host, isDesign)}
        select={select}
        layout={layout}
      />
    );
  if (host.artifact.kind === 'code' && isCode(content))
    return codeSurface ? (
      codeSurface(host)
    ) : (
      <CodeView host={host} previewDocument={previewDocument} />
    );
  if (host.artifact.kind === 'cad' && isCadDocument(content))
    return (
      <Suspense fallback={<p>3D CADを読み込んでいます…</p>}>
        <CadArtifactView host={host} kernel={cadKernel ?? null} onError={onError} />
      </Suspense>
    );
  return <p role="alert">このnative contentを表示できません。</p>;
}
function CodeView({
  host,
  previewDocument,
}: {
  host: ArtifactEditor<HostContent>;
  previewDocument: string;
}) {
  const { content, readOnly } = host.snapshot;
  const [project, setProject] = useState<ReturnType<typeof compileProject>>(),
    [error, setError] = useState('');
  const caret = useRef<[number, number]>([0, 0]);
  if (!isCode(content)) return null;
  return (
    <div className="host-code">
      <label>
        React TSXソース
        <textarea
          aria-label="React TSXソース"
          readOnly={readOnly}
          value={content.source}
          maxLength={150000}
          onSelect={(e) => {
            const next: [number, number] = [
              e.currentTarget.selectionStart,
              e.currentTarget.selectionEnd,
            ];
            if (next.some((value, i) => value !== caret.current[i])) host.breakHistoryGroup();
            caret.current = next;
          }}
          onBlur={() => host.flushInputs()}
          onChange={(e) => {
            caret.current = [e.currentTarget.selectionStart, e.currentTarget.selectionEnd];
            try {
              domainExecute(host, isCode)(codeSource(e.target.value));
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      </label>
      <button
        onClick={() => {
          try {
            host.flushInputs();
            setProject(compileProject({ [content.filename]: content.source }, content.filename));
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        隔離プレビューを実行
      </button>
      {error && <p role="alert">{error}</p>}
      {project && (
        <PreviewFrame
          project={project}
          previewDocument={previewDocument}
          title="Code隔離プレビュー"
        />
      )}
    </div>
  );
}
function DesignTools({
  host,
  previewDocument,
  onError,
}: {
  host: ArtifactEditor<HostContent>;
  previewDocument: string;
  onError(e: unknown): void;
}) {
  const { content, readOnly } = host.snapshot;
  const [project, setProject] = useState<ReturnType<typeof compileProject>>();
  if (!isDesign(content)) return null;
  const title = content.elements.find((e) => e.id === 'product-heading');
  return (
    <div className="host-design-tools">
      {title && (
        <label>
          ページ見出し
          <input
            aria-label="ページ見出し"
            value={title.text}
            readOnly={readOnly}
            onChange={(e) =>
              domainExecute(host, isDesign)(updateElement(title.id, { text: e.target.value }))
            }
          />
        </label>
      )}
      <button
        disabled={readOnly}
        onClick={() => {
          try {
            host.flushInputs();
            const current = host.snapshot.content;
            if (!isDesign(current)) throw Error('Not native Design');
            const bundle = exportDesignReact(current, nativeResolution);
            const compiled = compileDesignPreview(current, bundle.files);
            domainExecute(host, isDesign)(acceptDesignConversion(bundle));
            setProject(compiled);
          } catch (e) {
            onError(e);
          }
        }}
      >
        React生成を採用・プレビュー
      </button>
      {project && (
        <PreviewFrame
          project={project}
          previewDocument={previewDocument}
          title="Designから生成したReact"
        />
      )}
    </div>
  );
}

/** Independent reference Host; samples, routes, persistence, permission and runtime are injectable. */
export function HostApp({
  samples,
  storage,
  previewDocument,
  accessAdapter,
  codeSurface,
  header,
  cadKernel,
}: HostAppProps) {
  const [artifacts, setArtifactState] = useState(samples),
    [active, setActive] = useState<string>(),
    [ready, setReady] = useState(false);
  const artifactsRef = useRef(samples);
  const setArtifacts = useCallback((update: SetStateAction<Artifact<HostContent>[]>) => {
    const next = typeof update === 'function' ? update(artifactsRef.current) : update;
    artifactsRef.current = next;
    setArtifactState(next);
  }, []);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const sessions = useRef(new Map<string, ArtifactEditor<HostContent>>()),
    permissions = useRef(new Map<string, boolean>());
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [discard, setDiscard] = useState(false);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const unpersistedIds = useRef(new Set<string>());
  const [reused, setReused] = useState<{
    id: string;
    project: ReturnType<typeof compileProject>;
  }>();
  const [access, setAccess] = useState('共有設定はHostで確認');
  const [privateInputs] = useState(() => new Set<object>());
  const [accessRefresh, bumpAccessRefresh] = useReducer((n: number) => n + 1, 0);
  const accessRequest = useRef(0);
  const accessDisplay = useMemo(
    () =>
      new HostAccessDisplay(
        accessAdapter ?? {
          async read() {
            return undefined;
          },
        },
      ),
    [accessAdapter],
  );
  const refreshAccess = useCallback(async () => {
    const request = ++accessRequest.current;
    setAccess('共有設定はHostで確認');
    const label = await accessDisplay.refresh();
    if (request !== accessRequest.current) return;
    setAccess(label);
    bumpAccessRefresh();
  }, [accessDisplay]);
  const contentArea = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    file = useRef<HTMLInputElement>(null);
  const host = active ? sessions.current.get(active) : undefined;
  const fail = (e: unknown) => {
    setError(e instanceof EditorHostError ? `${e.code}: ${e.message}` : String(e));
    setNotice('');
  };
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    storage.list().then(
      (stored) => {
        if (!cancelled) {
          setArtifacts([...samples.filter((a) => !stored.some((s) => s.id === a.id)), ...stored]);
          const savedDesign = stored.find((a) => a.kind === 'design' && a.versions.length > 0);
          if (savedDesign && isDesign(savedDesign.draft.content)) {
            try {
              const output = exportDesignReact(savedDesign.draft.content, nativeResolution);
              setReused({
                id: savedDesign.id,
                project: compileDesignPreview(savedDesign.draft.content, output.files),
              });
            } catch (e) {
              fail(e);
            }
          }
          setReady(true);
        }
      },
      (e) => {
        if (!cancelled) {
          fail(e);
          setNotice(
            '保存データの検証に失敗しました。元データを保持してEditor起動を停止しています。',
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [storage, samples]);
  useEffect(() => {
    void refreshAccess();
    const release = accessAdapter?.subscribe?.(() => {
      accessDisplay.invalidate();
      void refreshAccess();
    });
    return () => {
      accessRequest.current++;
      release?.();
      accessDisplay.invalidate();
    };
  }, [accessAdapter, accessDisplay, refreshAccess]);
  useEffect(() => {
    return scheduleAccessExpiry(accessDisplay, setAccess);
  }, [accessDisplay, accessRefresh]);
  useEffect(() => {
    if (!host) return;
    const detach = host.attach(refresh);
    const unbuffer = host.registerInputBoundary(() => {
      if (
        composing.current ||
        contentArea.current?.querySelector(
          'dialog[open]:not([data-editor-export-scope]), [role="dialog"]:not([data-editor-menu]):not([data-editor-export-scope]), [role="alertdialog"]',
        )
      )
        throw new EditorHostError(
          'input-pending',
          host.id,
          '入力・ダイアログを確定または取消してから移動してください。',
        );
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && contentArea.current?.contains(focused)) focused.blur();
      if (privateInputs.size)
        throw new EditorHostError(
          'input-pending',
          host.id,
          '本文の確定処理中です。入力を保持しています。確定後にもう一度操作してください。',
        );
    });
    return () => {
      detach();
      unbuffer();
    };
  }, [host, privateInputs]);
  useEffect(() => {
    if (discard) discardDialog.current?.showModal();
  }, [discard]);
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (
        unpersistedIds.current.size > 0 ||
        [...sessions.current.values()].some((s) => s.snapshot.dirty || s.snapshot.saving)
      ) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  function open(id: string) {
    try {
      host?.flushInputs();
      if (!sessions.current.has(id)) {
        const artifact = artifacts.find((a) => a.id === id);
        if (!artifact || !hostAdapters[artifact.kind]) throw Error('Unknown artifact');
        sessions.current.set(
          id,
          new ArtifactEditor(
            artifact,
            hostAdapters[artifact.kind],
            storage,
            () => permissions.current.get(id) !== false,
          ),
        );
      }
      setActive(id);
      setError('');
      setNotice('');
    } catch (e) {
      fail(e);
    }
  }
  const back = () => {
    try {
      host?.flushInputs();
      setActive(undefined);
      setError('');
      setNotice('未保存の編集と履歴は、このタブで保持しています。');
    } catch (e) {
      fail(e);
    }
  };
  async function saveAndBack() {
    if (!host) return;
    try {
      const result = await host.save({ commitVersion: true });
      unpersistedIds.current.delete(result.artifactId);
      setArtifacts((values) =>
        values.map((a) => (a.id === result.artifactId ? result.artifact : a)),
      );
      if (result.kind === 'design' && isDesign(result.artifact.draft.content)) {
        try {
          const bundle = exportDesignReact(result.artifact.draft.content, nativeResolution);
          setReused({
            id: result.artifactId,
            project: compileDesignPreview(result.artifact.draft.content, bundle.files),
          });
        } catch (e) {
          fail(e);
          setNotice('保存済み。React再利用の診断を修正してください。');
          return;
        }
      }
      if (result.dirty) {
        setNotice('保存中に追加した編集が未保存です。再度保存できます。');
        return;
      }
      // An unrelated navigation during the async save must not be hijacked.
      setActive((id) => (id === result.artifactId ? undefined : id));
      setError('');
      setNotice('保存済みの成果物をアプリに返しました。');
    } catch (e) {
      fail(e);
    }
  }
  function duplicate(artifact: Artifact<HostContent>) {
    if (!ready) return;
    const copy = createArtifact(
      artifact.kind,
      artifact.name + ' (copy)',
      clone(artifact.draft.content),
    );
    unpersistedIds.current.add(copy.id);
    setArtifacts((values) => [...values, copy]);
  }
  async function importArtifact(selected: File | undefined) {
    if (!ready || !selected) return;
    try {
      if (selected.size > 16 * 1024 * 1024) throw Error('JSONは16 MiB以内です');
      const text = await selected.text(),
        raw: unknown = JSON.parse(text);
      const kind = raw && typeof raw === 'object' && 'kind' in raw ? String(raw.kind) : '';
      const adapter = hostAdapters[kind];
      if (!adapter) throw Error('Unknown artifact kind');
      const imported = await loadHostArtifact(text, adapter);
      const current = sessions.current.get(imported.id);
      const existing = current?.artifact ?? artifactsRef.current.find((a) => a.id === imported.id);
      if (permissions.current.get(imported.id) === false || current?.snapshot.readOnly)
        throw Error('閲覧モードの成果物は置き換えできません。既存の内容を保持しています。');
      if (current?.snapshot.dirty || current?.snapshot.saving)
        throw Error(
          '同じIDに未保存または保存待ちの編集があります。現在の内容を保持しています。保存・破棄後に再読込してください。',
        );
      if (existing) {
        if (existing.kind !== imported.kind)
          throw Error('同じIDのkindが異なります。既存成果物を保持しています。');
        for (const version of existing.versions) {
          const other = imported.versions.find((v) => v.versionId === version.versionId);
          if (other && canonicalJson(other) !== canonicalJson(version))
            throw Error('保存済みの版が衝突しています。既存版を保持しています。');
          if (!other) imported.versions.push(clone(version));
        }
        current?.close();
        sessions.current.delete(imported.id);
      }
      setArtifacts((values) => [...values.filter((a) => a.id !== imported.id), imported]);
      unpersistedIds.current.add(imported.id);
      setError('');
    } catch (e) {
      fail(e);
    }
  }
  const snap = host?.snapshot;
  return (
    <main className="artifact-host">
      {header ?? (
        <header className="host-header">
          <strong>Editor Platform — Artifact Host</strong>
        </header>
      )}
      <div className="host-access">
        <span aria-label="共有範囲">{access}</span>
        <button onClick={refreshAccess}>共有表示を再確認</button>
        <span>編集データ：このブラウザーに保存 · 共同編集なし</span>
      </div>
      {error && (
        <p className="host-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!host ? (
        <section aria-label="成果物一覧" className="host-list">
          <h1>成果物を、アプリから編集する。</h1>
          <p>開く → 編集 → 保存してアプリに戻る。未保存で戻った編集はこのタブに保持します。</p>
          {!ready && <p>成果物を読み込み中…</p>}
          <div className="host-artifacts">
            {artifacts.map((a) => {
              const current = sessions.current.get(a.id)?.snapshot;
              return (
                <article key={a.id} data-artifact-id={a.id}>
                  <span>{labels[a.kind]}</span>
                  <h2>{a.name}</h2>
                  <small>{a.id}</small>
                  <p>
                    {current?.dirty
                      ? '未保存の編集あり'
                      : unpersistedIds.current.has(a.id)
                        ? 'ブラウザー未保存'
                        : a.versions.length
                          ? '保存済み'
                          : 'Hostサンプル'}{' '}
                    · {a.versions.length} versions
                  </p>
                  {a.kind === 'slide' &&
                    a.versions.length > 0 &&
                    isStaticSlide(a.draft.content) &&
                    a.draft.content.slides.length > 0 && (
                      <figure className="host-saved-slide">
                        <img
                          alt={'保存した企画書 ' + a.id}
                          src={
                            'data:image/svg+xml;charset=utf-8,' +
                            encodeURIComponent(
                              exportSlideSvg(a.draft.content, a.draft.content.slides[0]),
                            )
                          }
                        />
                        <figcaption>
                          {a.draft.content.slides.length} pages · 保存したnative内容のプレビュー
                        </figcaption>
                      </figure>
                    )}
                  <button
                    disabled={!ready}
                    onClick={() => open(a.id)}
                    aria-label={a.name + 'を開く'}
                  >
                    Editorで開く ↗
                  </button>
                  <button disabled={!ready} onClick={() => duplicate(a)}>
                    複製
                  </button>
                </article>
              );
            })}
          </div>
          <button disabled={!ready} onClick={() => file.current?.click()}>
            成果物JSONを開く
          </button>
          <p>
            同じIDのJSONは未保存編集がない場合にSessionを閉じて読み込みます。保存済み版の衝突は拒否し、保存は明示操作です。
          </p>
          {reused && (
            <section aria-label="アプリで再利用したReact">
              <h2>保存した製品ページをアプリで表示</h2>
              <p>成果物 {reused.id} の生成TSX/CSSを使用。Editor runtimeは含みません。</p>
              <PreviewFrame
                project={reused.project}
                previewDocument={previewDocument}
                title="アプリで再利用したReact出力"
              />
            </section>
          )}
        </section>
      ) : (
        <section
          className="host-editor"
          aria-label="成果物Editor"
          onCompositionStartCapture={() => {
            composing.current = true;
          }}
          onCompositionEndCapture={() => {
            composing.current = false;
          }}
        >
          <nav aria-label="開く成果物を変更">
            {artifacts.map((a) => (
              <button
                key={a.id}
                aria-pressed={a.id === active}
                onPointerDown={(e) => {
                  if (composing.current) e.preventDefault();
                }}
                onClick={() => open(a.id)}
              >
                {a.name}
              </button>
            ))}
          </nav>
          <div className="host-toolbar">
            <strong>{host.artifact.name}</strong>
            <code>{host.id}</code>
            <span>
              {snap?.dirty ? '未保存' : '保存内容と一致'} · Revision {snap?.revision.sequence}
            </span>
            <button
              aria-label="Host Undo"
              disabled={!snap?.canUndo || snap.readOnly}
              onClick={() => {
                try {
                  host.undo();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Undo
            </button>
            <button
              aria-label="Host Redo"
              disabled={!snap?.canRedo || snap.readOnly}
              onClick={() => {
                try {
                  host.redo();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Redo
            </button>
            <button disabled={snap?.saving || snap?.readOnly} onClick={saveAndBack}>
              保存してアプリに戻る
            </button>
            <button onClick={back}>編集を保持して戻る</button>
            <button
              disabled={snap?.saving}
              onClick={() => {
                try {
                  host.flushInputs();
                  setDiscard(true);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              取消
            </button>
            <button
              onClick={() => {
                try {
                  host.close();
                  sessions.current.delete(host.id);
                  setActive(undefined);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Sessionを閉じる
            </button>
            <label>
              <input
                type="checkbox"
                checked={snap?.readOnly}
                onChange={(e) => {
                  try {
                    host.flushInputs();
                    permissions.current.set(host.id, !e.target.checked);
                    host.refreshPermission();
                  } catch (error) {
                    fail(error);
                  }
                }}
              />
              閲覧モード
            </label>
            <button
              onClick={async () => {
                try {
                  download(host.id + '.json', (await host.export('native-json')) as string);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              成果物JSON保存
            </button>
            {host.capabilities.formats.map((format) => (
              <button
                key={format}
                onClick={async () => {
                  try {
                    const value = await host.export(format);
                    if (
                      format === 'react' &&
                      value &&
                      typeof value === 'object' &&
                      'files' in value
                    ) {
                      const { zipSync, strToU8 } = await import('fflate');
                      const blob = new Blob(
                        [
                          zipSync(
                            Object.fromEntries(
                              Object.entries(value.files as Record<string, string>).map(
                                ([name, text]) => [name, strToU8(text)],
                              ),
                            ),
                          ) as Uint8Array<ArrayBuffer>,
                        ],
                        { type: 'application/zip' },
                      );
                      const url = URL.createObjectURL(blob),
                        link = document.createElement('a');
                      link.href = url;
                      link.download = 'react-output.zip';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } else if (Array.isArray(value))
                      value.forEach((f) => download(f.filename, f.text, 'image/svg+xml'));
                    else download(host.id + '.' + format, String(value), 'text/plain');
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                {format.toUpperCase()}出力
              </button>
            ))}
          </div>
          <div
            ref={contentArea}
            className={
              host.artifact.kind === 'code' && codeSurface
                ? 'host-surface host-custom-code'
                : 'host-surface'
            }
            onCompositionStartCapture={() => {
              composing.current = true;
            }}
            onCompositionEndCapture={() => {
              composing.current = false;
            }}
          >
            <EditorUncommittedInputContext.Provider value={privateInputs}>
              <EditorExportGuardContext.Provider value={() => host.flushInputs()}>
                <EditorView
                  key={host.id}
                  host={host}
                  previewDocument={previewDocument}
                  codeSurface={codeSurface}
                  cadKernel={cadKernel}
                  onError={fail}
                />
              </EditorExportGuardContext.Provider>
            </EditorUncommittedInputContext.Provider>
          </div>
          {host.artifact.kind === 'design' && (
            <DesignTools
              key={host.id}
              host={host}
              previewDocument={previewDocument}
              onError={fail}
            />
          )}
          <p className="host-capabilities">
            能力：local Undo / native JSON / {host.capabilities.formats.join(', ')} ·
            共有編集なし。React/Designはnative Design、CodeはHost拡張、KanbanはData projection。
          </p>
        </section>
      )}
      {discard && host && (
        <dialog
          ref={discardDialog}
          onCancel={() => setDiscard(false)}
          className="host-discard"
          role="dialog"
          aria-modal="true"
          aria-label="未保存の編集を破棄"
        >
          <p>未保存の編集を破棄し、このSessionと履歴を閉じます。保存した版は残ります。</p>
          <button autoFocus onClick={() => setDiscard(false)}>
            編集に戻る
          </button>
          <button
            onClick={() => {
              try {
                host.close('discard');
                sessions.current.delete(host.id);
                setActive(undefined);
                setDiscard(false);
                setError('');
              } catch (e) {
                fail(e);
              }
            }}
          >
            破棄してアプリに戻る
          </button>
        </dialog>
      )}
      <input
        hidden
        ref={file}
        type="file"
        accept=".json"
        onChange={(e) => {
          void importArtifact(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </main>
  );
}
