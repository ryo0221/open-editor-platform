import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { canonicalJson, clone, contentHash } from '@editor-platform/artifact-core';
import {
  EditorSession,
  EditorInputs,
  previewProposedCommands,
  transaction,
  type EditorCommand,
  type ProposedCommands,
  type ElementAddress,
} from '@editor-platform/editor-core';
import { EditorInputsContext, EditorExportGuardContext } from '@editor-platform/editor-ui';
import {
  ReferenceError,
  ReferenceResolver,
  type ReferenceItem,
  type ReferenceSnapshot,
  type ReferenceOption,
} from '@editor-platform/artifact-references';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import {
  DataSurface,
  createData,
  setCell,
  type StructuredData,
} from '@editor-platform/structured-data';
import {
  GraphSurface,
  createRelationGraph,
  relationProfile,
  graphCommand,
} from '@editor-platform/structured-graph';
import { SlideSurface, createDeck, isDeck, type SlideContent } from '@editor-platform/slide';
import {
  DocumentSurface,
  createDocument,
  isDocument,
  type DocumentContent,
} from '@editor-platform/document';
import { DesignSurface, createDesign, isDesign, type DesignContent } from '@editor-platform/design';
import {
  WhiteboardSurface,
  createWhiteboard,
  isWhiteboard,
  type WhiteboardContent,
} from '@editor-platform/whiteboard';
import './reference-host.css';

type Destination = 'slide' | 'document' | 'design' | 'whiteboard';
type Native = SlideContent | DocumentContent | DesignContent | WhiteboardContent;
const factories = {
  slide: createDeck,
  document: createDocument,
  design: createDesign,
  whiteboard: createWhiteboard,
};
const validators = {
  slide: isDeck,
  document: isDocument,
  design: isDesign,
  whiteboard: isWhiteboard,
};
const items = (d: Native): ReferenceItem[] =>
  isDeck(d)
    ? d.slides.flatMap((p) => p.objects)
    : isDocument(d)
      ? d.blocks
      : isDesign(d)
        ? d.elements
        : d.nodes;
async function capture(d: Native, resolver: ReferenceResolver, live = true): Promise<Native> {
  const captured = await resolver.capture(items(d), live);
  if (isDeck(d)) {
    let offset = 0;
    return {
      ...d,
      slides: d.slides.map((p) => {
        const objects = captured.slice(offset, offset + p.objects.length) as typeof p.objects;
        offset += p.objects.length;
        return { ...p, objects };
      }),
    };
  }
  if (isDocument(d)) return { ...d, blocks: captured as typeof d.blocks };
  if (isDesign(d)) return { ...d, elements: captured as typeof d.elements };
  return { ...d, nodes: captured as typeof d.nodes };
}
function hours(): StructuredData {
  const d = createData();
  d.columns = [
    { id: 'name', name: '業務', type: 'text' },
    { id: 'hours', name: '時間', type: 'number' },
  ];
  d.rows = [{ id: 'work', values: { name: '定型作業', hours: 95 } }];
  return d;
}
function Host() {
  const [kind, setKind] = useState<Destination>(() => {
      const saved = localStorage.getItem('reference-host-kind');
      return saved && saved in factories ? (saved as Destination) : 'slide';
    }),
    [editing, setEditing] = useState<'data' | 'structured-graph'>(),
    [tick, render] = useState(0),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [focus, setFocus] = useState<ElementAddress>(),
    [selectedId, setSelectedId] = useState<string>(),
    [preview, setPreview] = useState<ProposedCommands<StructuredData>>();
  const [access, setAccess] = useState<'online' | 'offline' | 'forbidden'>('online');
  const accessRef = useRef(access);
  accessRef.current = access;
  const sources = useRef(new Map<string, ReferenceSnapshot>()),
    listeners = useRef(new Set<(id: string) => void>());
  const sessions = useRef(new Map<Destination, EditorSession<Native>>());
  const sourceData = useRef(new EditorSession(hours())),
    sourceGraph = useRef(new EditorSession(createRelationGraph()));
  const returnAddress = useRef<ElementAddress | undefined>(undefined);
  const sourceSave = useRef(Promise.resolve());
  const inputs = useMemo(() => new EditorInputs(), [kind, editing]);
  const versions = useRef<Native[]>([]);
  const histories = useRef(new Map<Destination, Native[]>());
  const resolver = useMemo(
    () =>
      new ReferenceResolver(
        {
          async list() {
            assertSourceAccess();
            const options: ReferenceOption[] = [];
            for (const s of sources.current.values()) {
              if (s.domain === 'data')
                for (const kind of ['table', 'chart'])
                  options.push({
                    label: `作業時間 · ${kind}`,
                    source: {
                      artifactId: s.artifactId,
                      domain: s.domain,
                      target: { kind, viewId: 'default' },
                    },
                  });
              else
                options.push({
                  label: '自動化の関係図',
                  source: {
                    artifactId: s.artifactId,
                    domain: s.domain,
                    target: { kind: 'graph', viewId: sourceGraph.current.content.id },
                  },
                });
            }
            return options;
          },
          checkAccess: assertSourceAccess,
          async read(source) {
            if (accessRef.current !== 'online')
              throw new ReferenceError(accessRef.current, 'Hostの参照取得が利用できません。');
            const s = sources.current.get(source.artifactId);
            if (!s) throw new ReferenceError('missing-source', '参照元が削除されました。');
            return s;
          },
          subscribe(listener) {
            listeners.current.add(listener);
            return () => {
              listeners.current.delete(listener);
            };
          },
          open(source, elementId, pageId) {
            assertSourceAccess();
            inputs.flush();
            returnAddress.current = { artifactId: `destination-${kind}`, elementId, pageId };
            setEditing(source.domain as 'data' | 'structured-graph');
          },
        },
        nativeReferenceAdapters,
        `destination-${kind}`,
      ),
    [kind, inputs],
  );
  const guard = () => inputs.flush();
  function assertSourceAccess() {
    if (accessRef.current === 'forbidden')
      throw new ReferenceError('forbidden', 'Hostが参照権限を取り消しました。');
  }
  const connection = useRef({ kind, resolver });
  connection.current = { kind, resolver };
  function changed() {
    render((n) => n + 1);
  }
  async function persistSource(domain: 'data' | 'structured-graph') {
    assertSourceAccess();
    guard();
    const artifactId = domain === 'data' ? 'hours' : 'relations',
      content = clone(domain === 'data' ? sourceData.current.content : sourceGraph.current.content);
    const pending = sourceSave.current.then(async () => {
      assertSourceAccess();
      const revision = (sources.current.get(artifactId)?.revision ?? 0) + 1;
      const snapshot: ReferenceSnapshot = {
        artifactId,
        domain,
        versionId: `${artifactId}-v${revision}`,
        revision,
        contentHash: await contentHash(content),
        content,
        dependencies:
          domain === 'structured-graph'
            ? [
                {
                  id: `profile:${relationProfile.id}:${relationProfile.version}`,
                  content: relationProfile,
                  contentHash: await contentHash(relationProfile),
                },
              ]
            : [],
      };
      // Persistence precedes publication. No draft/proposal callback can reach this notification.
      assertSourceAccess();
      localStorage.setItem(`reference-host-source:${artifactId}`, JSON.stringify(snapshot));
      sources.current.set(artifactId, snapshot);
      for (const l of listeners.current) l(artifactId);
      changed();
    });
    // A failed persistence does not publish or consume a version, nor block retries.
    sourceSave.current = pending.catch(() => {});
    return pending;
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        for (const k of Object.keys(factories) as Destination[]) {
          const saved = localStorage.getItem(`reference-host:${k}`),
            content = saved ? JSON.parse(saved) : factories[k]();
          if (!validators[k](content)) throw new Error('Invalid stored destination');
          const scopedResolver = resolver.forDestination(`destination-${k}`);
          await capture(content, scopedResolver, false);
          const history: unknown = JSON.parse(
            localStorage.getItem(`reference-host-versions:${k}`) ?? '[]',
          );
          if (!Array.isArray(history)) throw new Error('Invalid stored destination history');
          for (const version of history) {
            if (!validators[k](version)) throw new Error('Invalid stored destination version');
            await capture(version, scopedResolver, false);
          }
          histories.current.set(k, history);
          sessions.current.set(k, new EditorSession(content));
        }
        for (const id of ['hours', 'relations']) {
          const saved = localStorage.getItem(`reference-host-source:${id}`);
          if (saved) sources.current.set(id, JSON.parse(saved));
        }
        if (sources.current.has('hours'))
          sourceData.current = new EditorSession(
            sources.current.get('hours')!.content as StructuredData,
          );
        else await persistSource('data');
        if (sources.current.has('relations'))
          sourceGraph.current = new EditorSession(
            sources.current.get('relations')!.content as ReturnType<typeof createRelationGraph>,
          );
        else await persistSource('structured-graph');
        versions.current = histories.current.get(kind)!;
        if (alive) setReady(true);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // Initial storage bootstrap owns its immutable copy; later navigation never reloads drafts.
  }, []);
  function execute<T extends Native>(cmd: EditorCommand<T>) {
    const session = sessions.current.get(kind)!;
    const next = session.execute(cmd as EditorCommand<Native>);
    if (!validators[kind](next)) throw new Error('Invalid destination command');
    localStorage.setItem(`reference-host:${kind}`, JSON.stringify(next));
    changed();
  }
  async function saveDestination() {
    try {
      guard();
      const session = sessions.current.get(kind)!,
        initial = session.content;
      const history = versions.current;
      const revision = session.revision.sequence;
      const saved = await capture(initial, resolver);
      if (
        connection.current.kind !== kind ||
        connection.current.resolver !== resolver ||
        versions.current !== history
      )
        throw new Error('保存中に埋め込み先または参照接続が変わりました。再実行してください。');
      if (
        revision !== session.revision.sequence ||
        inputs.getSnapshot().dirty ||
        inputs.getSnapshot().composing
      )
        throw new Error('入力が変わりました。再実行してください。');
      history.push(clone(saved));
      localStorage.setItem(`reference-host-versions:${kind}`, JSON.stringify(history));
      localStorage.setItem(`reference-host:${kind}`, JSON.stringify(initial));
      changed();
    } catch (e) {
      setError(String(e));
    }
  }
  function exportNative() {
    void (async () => {
      try {
        guard();
        const initialRevision = sessions.current.get(kind)!.revision.sequence;
        const history = versions.current;
        const initial = sessions.current.get(kind)!.content,
          content = await capture(initial, resolver);
        if (
          connection.current.kind !== kind ||
          connection.current.resolver !== resolver ||
          versions.current !== history
        )
          throw new Error('出力中に埋め込み先または参照接続が変わりました。再実行してください。');
        if (
          initialRevision !== sessions.current.get(kind)!.revision.sequence ||
          inputs.getSnapshot().dirty ||
          inputs.getSnapshot().composing
        )
          throw new Error('入力が変わりました。');
        const a = document.createElement('a'),
          url = URL.createObjectURL(
            new Blob([JSON.stringify({ content, versions: history })], {
              type: 'application/json',
            }),
          );
        a.href = url;
        a.download = `${kind}-references.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError(String(e));
      }
    })();
  }
  const destinationContent = useMemo(
    () => sessions.current.get(kind)?.content,
    [kind, tick, ready],
  );
  if (!ready) return <p role="status">{error || 'Preparing reference Host…'}</p>;
  const content = destinationContent!;
  return (
    <EditorInputsContext.Provider value={inputs}>
      <EditorExportGuardContext.Provider value={guard}>
        <main className="reference-host">
          <header>
            <strong>Artifact Reference Host</strong>
            <label>
              埋め込み先
              <select
                aria-label="埋め込み先の種類"
                disabled={!!editing}
                value={kind}
                onChange={(e) => {
                  guard();
                  localStorage.setItem('reference-host-kind', e.target.value);
                  versions.current = histories.current.get(e.target.value as Destination)!;
                  setSelectedId(undefined);
                  setKind(e.target.value as Destination);
                  setFocus(undefined);
                }}
              >
                {Object.keys(factories).map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            {editing ? (
              <>
                <button
                  onClick={() => {
                    guard();
                    setEditing(undefined);
                    setFocus(returnAddress.current);
                  }}
                >
                  埋め込み先に戻る
                </button>
                <button
                  disabled={access === 'forbidden'}
                  onClick={() => void persistSource(editing).catch((e) => setError(String(e)))}
                >
                  参照元を保存
                </button>
              </>
            ) : (
              <>
                <button onClick={() => void saveDestination()}>埋め込み先を保存</button>
                <button onClick={exportNative}>参照付きJSONを出力</button>
                <button
                  onClick={() => {
                    guard();
                    sessions.current.get(kind)!.undo();
                    changed();
                  }}
                >
                  Undo
                </button>
                <button
                  onClick={() => {
                    guard();
                    sessions.current.get(kind)!.redo();
                    changed();
                  }}
                >
                  Redo
                </button>
              </>
            )}
            <label>
              取得状態
              <select
                aria-label="参照元の接続状態"
                value={access}
                onChange={(e) => {
                  const value = e.target.value as typeof access;
                  accessRef.current = value;
                  setAccess(value);
                  for (const l of listeners.current) for (const id of ['hours', 'relations']) l(id);
                }}
              >
                <option value="online">online</option>
                <option value="offline">offline</option>
                <option value="forbidden">forbidden</option>
              </select>
            </label>
            <span role="status">
              保存版 {versions.current.length} · {tick}
              {editing &&
                ` · 元の保存版 ${sources.current.get(editing === 'data' ? 'hours' : 'relations')?.revision}`}
            </span>
          </header>
          {error && <p role="alert">{error}</p>}
          {editing && access === 'forbidden' && (
            <p role="alert">参照権限がありません。埋め込み先に戻ってください。</p>
          )}
          {editing === 'data' && access !== 'forbidden' && (
            <>
              <nav>
                <button
                  onClick={() => {
                    assertSourceAccess();
                    setPreview({
                      id: 'hours-80',
                      summary: '作業時間を80にする',
                      commands: [setCell('work', 'hours', 80)],
                    });
                  }}
                >
                  外部提案をプレビュー
                </button>
                {preview && (
                  <>
                    <output>
                      {
                        previewProposedCommands(sourceData.current.content, preview).content.rows[0]
                          .values.hours
                      }
                    </output>
                    <button onClick={() => setPreview(undefined)}>提案を却下</button>
                    <button
                      onClick={() => {
                        assertSourceAccess();
                        sourceData.current.execute(transaction(preview.summary, preview.commands));
                        setPreview(undefined);
                        changed();
                      }}
                    >
                      提案を採用
                    </button>
                  </>
                )}
              </nav>
              <DataSurface
                content={sourceData.current.content}
                execute={(cmd) => {
                  assertSourceAccess();
                  sourceData.current.execute(cmd);
                  changed();
                }}
                select={() => {}}
              />
            </>
          )}
          {editing === 'structured-graph' && access !== 'forbidden' && (
            <GraphSurface
              content={sourceGraph.current.content}
              profile={relationProfile}
              stamp={canonicalJson(sourceGraph.current.revision)}
              onEdit={(intents, base) => {
                assertSourceAccess();
                if (base !== canonicalJson(sourceGraph.current.revision))
                  throw new Error('Stale Graph revision');
                sourceGraph.current.execute(graphCommand(relationProfile, intents));
                changed();
              }}
              select={() => {}}
            />
          )}
          {!editing && isDeck(content) && (
            <SlideSurface
              references={resolver}
              content={content}
              execute={execute}
              select={() => {}}
              focusAddress={focus}
            />
          )}
          {!editing && isDocument(content) && (
            <DocumentSurface
              references={resolver}
              content={content}
              execute={execute}
              select={setSelectedId}
              selectedId={selectedId}
              focusAddress={focus}
            />
          )}
          {!editing && isDesign(content) && (
            <DesignSurface
              references={resolver}
              content={content}
              execute={execute}
              select={() => {}}
              focusReferenceId={focus?.elementId}
            />
          )}
          {!editing && isWhiteboard(content) && (
            <WhiteboardSurface
              references={resolver}
              content={content}
              execute={execute}
              select={() => {}}
              focusReferenceId={focus?.elementId}
            />
          )}
        </main>
      </EditorExportGuardContext.Provider>
    </EditorInputsContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(<Host />);
