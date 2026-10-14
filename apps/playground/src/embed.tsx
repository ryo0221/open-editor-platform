import { guardDataCommand } from '@editor-platform/structured-data/session';
import { isStructuredData } from '@editor-platform/structured-data/model';
/** A separate entrypoint: imports public packages, never Playground App, model or CSS. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  EditorSession,
  EditorInputs,
  type EditorCommand,
  type Region,
} from '@editor-platform/editor-core';
import {
  EditorInputsContext,
  EditorHistoryContext,
  CommitInput,
  type PanelState,
} from '@editor-platform/editor-ui';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import { createDocument, DocumentSurface } from '@editor-platform/document';
import { createData, DataSurface, addRow } from '@editor-platform/structured-data';
import { createDeck, SlideSurface } from '@editor-platform/slide';
import { createDesign, DesignSurface } from '@editor-platform/design';
import { createWhiteboard, WhiteboardSurface } from '@editor-platform/whiteboard';
import {
  createReview,
  createFile,
  ReviewSurface,
  FileSurface,
} from '@editor-platform/review-surfaces';
import { CanvasTextContext, CanvasPresenceContext } from '@editor-platform/canvas-ui';
import {
  SharedEditorSession,
  HttpEditorAdapter,
  slideEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
  documentEditorCodec,
  reviewCodec,
  fileCodec,
} from '@editor-platform/collaboration-adapters';
import type { DomainCodec, Identity } from '@editor-platform/collaboration-core';
import {
  builtinTemplates,
  prepareInsertion,
  previewSharedTemplate,
  applySharedTemplate,
  type NativeContent,
  type PreparedApplication,
} from '@editor-platform/templates';
import { TemplatePreview } from '@editor-platform/template-ui';
import type { Preview } from '@editor-platform/collaboration-core';
import './embed.css';

const factories = {
  document: createDocument,
  data: () => addRow().apply(createData()),
  slide: createDeck,
  design: createDesign,
  whiteboard: createWhiteboard,
  review: createReview,
  file: createFile,
};
type Surface = keyof typeof factories;

function SurfaceHost({
  kind,
  readOnly,
  panels,
  onPanelsChange,
  onEvent,
  shared,
  inputs,
  localSession,
}: {
  kind: Surface;
  shared?: SharedEditorSession<unknown>;
  inputs: EditorInputs;
  localSession?: EditorSession<unknown>;
  readOnly: boolean;
  panels: PanelState;
  onPanelsChange: (state: PanelState) => void;
  onEvent: (message: string) => void;
}) {
  // The session and permission check are owned by this Host, independently of the surface UI.
  const [rejectedDraft, setRejectedDraft] = useState('');
  const [viewDraft, setViewDraft] = useState({ dirty: false, canUndo: false, canRedo: false });
  const [rejectionValue] = useState('original');
  const [localContent, setContent] = useState(() => localSession?.content);
  const [, render] = useState(0);
  useEffect(() => {
    if (!shared) return;
    shared.onChange = () => render((n) => n + 1);
    return () => {
      shared.onChange = () => {};
    };
  }, [shared]);
  const [template, setTemplate] = useState<{
    application: PreparedApplication;
    preview: Preview<NativeContent>;
  }>();
  const [hostBusy, setHostBusy] = useState(false);
  const [hostError, setHostError] = useState('');
  async function hostAction(action: () => Promise<void>) {
    if (hostBusy) return;
    setHostBusy(true);
    setHostError('');
    try {
      await action();
    } catch (e) {
      setHostError(String(e));
      onEvent(String(e));
    } finally {
      setHostBusy(false);
    }
  }
  const content = shared ? shared.viewContent : localContent;
  const session = shared ?? localSession!;
  const writable = !readOnly && !shared?.readOnly;
  const history = (direction: 'undo' | 'redo') => {
    if (!writable) return;
    let handled = false;
    flushSync(() => {
      handled = inputs.history(direction);
    });
    if (handled) return;
    if (shared) void shared.history(direction).catch((e) => onEvent(String(e)));
    else setContent(localSession![direction]());
  };
  function execute<T>(command: EditorCommand<T>) {
    if (!writable) return false;
    try {
      if (shared) shared.executeView(command as EditorCommand<unknown>);
      else
        setContent(
          localSession!.execute({
            ...(command as EditorCommand<unknown>),
            apply: (value) => {
              if (!isStructuredData(value)) return command.apply(value as T);
              return guardDataCommand({
                ...(command as EditorCommand<
                  import('@editor-platform/structured-data').StructuredData
                >),
                apply: (data) => {
                  const next = command.apply(data as T);
                  if (!isStructuredData(next)) throw new Error('Invalid Data command result');
                  return next;
                },
              }).apply(value);
            },
          }),
        );
    } catch (e) {
      onEvent(String(e));
      return false;
    }
    onEvent(`Command: ${command.type}`);
    return true;
  }
  const select = (id: string | string[], region?: Region) => {
    shared?.select({
      addresses: [id]
        .flat()
        .map((elementId) => ({ artifactId: shared.confirmed.artifactId, elementId, region })),
    });
    onEvent(`Selection: ${[id].flat().join(', ')}${region ? ` (${region.type})` : ''}`);
  };
  const common = {
    execute,
    select,
    readOnly: !writable,
    layout: { panels, onPanelsChange, viewKey: `embed-${kind}` },
  };
  return (
    <EditorInputsContext.Provider value={inputs}>
      <OfficeExportHost
        formats={
          new URLSearchParams(location.search).has('no-office')
            ? { pptx: false, docx: false, reason: '独立HostはOffice captureを提供していません。' }
            : undefined
        }
        guard={() => {
          flushSync(() => inputs.flush());
          if (shared && (shared.pendingCount || shared.rejected.length))
            throw new Error('Resolve pending input before export');
        }}
        capture={() =>
          shared
            ? {
                content: shared.confirmed.content,
                basis: {
                  kind: 'confirmed',
                  artifactId: shared.confirmed.artifactId,
                  revision: shared.confirmed.revision,
                },
                name: `host-${kind}`,
              }
            : {
                content: localSession!.content,
                basis: { kind: 'local-draft', artifactId: `host-${kind}` },
                name: `host-${kind}`,
              }
        }
      >
        <CanvasPresenceContext.Provider
          value={
            shared?.presences.flatMap((p) =>
              p.anchor && !p.anchor.orphan && 'elementId' in p.anchor
                ? [{ elementId: p.anchor.elementId, name: p.name, clientId: p.clientId }]
                : [],
            ) ?? []
          }
        >
          <CanvasTextContext.Provider value={shared ? (id) => shared.text(id) : undefined}>
            {new URLSearchParams(location.search).has('rejected-input') && (
              <div>
                <CommitInput
                  label="Rejected field"
                  value={rejectionValue}
                  onCommit={(value) => {
                    setRejectedDraft(value);
                    return false;
                  }}
                />
                <button
                  onClick={() => {
                    try {
                      flushSync(() => inputs.flush());
                      onEvent('Host save accepted');
                    } catch (error) {
                      onEvent(String(error));
                    }
                  }}
                >
                  Host flush inputs
                </button>
                <output aria-label="Rejected input observed">{rejectedDraft}</output>
              </div>
            )}
            <div className="embed-history">
              <button
                disabled={!writable || (!session.canUndo && !viewDraft.canUndo)}
                onClick={() => history('undo')}
              >
                Host Undo
              </button>
              <button
                disabled={!writable || (!session.canRedo && !viewDraft.canRedo)}
                onClick={() => history('redo')}
              >
                Host Redo
              </button>
            </div>
            {shared && (
              <div className="embed-history">
                {hostError && <p role="alert">{hostError}</p>}
                <output aria-label="Host sync status">{shared.status}</output>
                <output aria-label="Host versions">
                  {shared.savedVersions.length} saved version(s)
                </output>
                <button
                  disabled={
                    !writable || hostBusy || !!shared.pendingCount || !!shared.rejected.length
                  }
                  onClick={() =>
                    void hostAction(async () => {
                      flushSync(() => inputs.flush());
                      await shared.save('Independent Host checkpoint');
                      onEvent('Version saved');
                    })
                  }
                >
                  Host save version
                </button>
                {kind === 'slide' && (
                  <button
                    disabled={!writable || hostBusy || !!shared.pendingCount}
                    onClick={() =>
                      void hostAction(async () => {
                        const definition = builtinTemplates.find(
                          (d) => d.templateId === 'slide-comparison-page',
                        )!;
                        const session = shared as SharedEditorSession<NativeContent>;
                        const application = await prepareInsertion(
                          definition,
                          {
                            left: { title: '現状の受付', items: ['記入に時間がかかる'] },
                            right: { title: '改善する受付', items: ['案内をまとめる'] },
                          },
                          session.confirmed,
                          session.adapter.identity,
                        );
                        const preview = await previewSharedTemplate(application, session);
                        setTemplate({ application, preview });
                      })
                    }
                  >
                    Preview comparison template
                  </button>
                )}
              </div>
            )}
            {template && shared && (
              <dialog open aria-label="Host template preview" className="embed-template-preview">
                <TemplatePreview domain="slide" content={template.preview.after} compact />
                <button
                  disabled={hostBusy || !writable}
                  onClick={() =>
                    void hostAction(async () => {
                      await applySharedTemplate(
                        template.application,
                        shared as SharedEditorSession<NativeContent>,
                        template.preview.token,
                      );
                      setTemplate(undefined);
                    })
                  }
                >
                  Apply template
                </button>
                <button
                  disabled={hostBusy}
                  onClick={() =>
                    void hostAction(async () => {
                      await shared.adapter.cancelProposal(template.application.id);
                      setTemplate(undefined);
                    })
                  }
                >
                  Cancel template
                </button>
              </dialog>
            )}
            <EditorHistoryContext.Provider
              value={{ undo: () => history('undo'), redo: () => history('redo') }}
            >
              <div className="embed-surface">
                {kind === 'document' && (
                  <DocumentSurface
                    {...common}
                    textEngine={shared?.text('text')}
                    content={content as ReturnType<typeof createDocument>}
                  />
                )}
                {kind === 'data' && (
                  <DataSurface
                    {...common}
                    onViewDraftChange={setViewDraft}
                    content={content as ReturnType<typeof createData>}
                  />
                )}
                {kind === 'slide' && (
                  <SlideSurface {...common} content={content as ReturnType<typeof createDeck>} />
                )}
                {kind === 'design' && (
                  <DesignSurface {...common} content={content as ReturnType<typeof createDesign>} />
                )}
                {kind === 'whiteboard' && (
                  <WhiteboardSurface
                    {...common}
                    content={content as ReturnType<typeof createWhiteboard>}
                  />
                )}
                {kind === 'review' && (
                  <ReviewSurface
                    {...common}
                    onSelectionClear={() => select([])}
                    readOnly={!!shared || !writable}
                    content={content as ReturnType<typeof createReview>}
                  />
                )}
                {kind === 'file' && (
                  <FileSurface
                    {...common}
                    onSelectionClear={() => select([])}
                    readOnly={!!shared || !writable}
                    content={content as ReturnType<typeof createFile>}
                  />
                )}
              </div>
            </EditorHistoryContext.Provider>
            <details className="embed-content">
              <summary>Host content</summary>
              <pre>{JSON.stringify(content, null, 2)}</pre>
            </details>
          </CanvasTextContext.Provider>
        </CanvasPresenceContext.Provider>
      </OfficeExportHost>
    </EditorInputsContext.Provider>
  );
}
export function IndependentHost({
  shared,
  initialKind = 'slide',
  inputs: suppliedInputs,
}: {
  shared?: SharedEditorSession<unknown>;
  initialKind?: Surface;
  inputs?: EditorInputs;
}) {
  const [ownInputs] = useState(() => new EditorInputs());
  const inputs = suppliedInputs ?? ownInputs;
  const [localSessions] = useState(() => new Map<Surface, EditorSession<unknown>>());
  const [kind, setKind] = useState<Surface>(initialKind);
  const [readOnly, setReadOnly] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [event, setEvent] = useState('No events');
  const [transitionError, setTransitionError] = useState('');
  const [panels, setPanels] = useState<PanelState>({
    left: true,
    right: true,
    rightWidth: 280,
    tab: 'properties',
    focus: false,
  });
  let localSession = localSessions.get(kind);
  if (!shared && !localSession) {
    localSession = new EditorSession<unknown>(factories[kind]());
    localSessions.set(kind, localSession);
  }
  return (
    <main className="embed-host">
      <header className="embed-controls">
        <label>
          Surface{' '}
          <select
            aria-label="Surface"
            disabled={!!shared}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as Surface;
              try {
                flushSync(() => inputs.flush());
                setTransitionError('');
                setKind(next);
              } catch (error) {
                setTransitionError(String(error instanceof Error ? error.message : error));
              }
            }}
          >
            {Object.keys(factories).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => setReadOnly(e.target.checked)}
          />
          Read only
        </label>
        <label>
          <input type="checkbox" checked={narrow} onChange={(e) => setNarrow(e.target.checked)} />
          Narrow container
        </label>
        <button onClick={() => setPanels({ ...panels, left: !panels.left, right: false })}>
          Host navigator
        </button>
        <button onClick={() => setPanels({ ...panels, right: !panels.right, left: false })}>
          Host inspector
        </button>
        <output aria-label="Host event">{event}</output>
        {transitionError && <p role="alert">{transitionError}</p>}
      </header>
      <section className="embed-boundary" style={{ width: narrow ? 'min(100%, 540px)' : '100%' }}>
        <SurfaceHost
          key={kind}
          kind={kind}
          shared={shared}
          inputs={inputs}
          localSession={localSession}
          readOnly={readOnly}
          panels={panels}
          onPanelsChange={setPanels}
          onEvent={setEvent}
        />
      </section>
    </main>
  );
}
interface HostConnection {
  session: SharedEditorSession<unknown>;
  retain: (checkpoint: ReturnType<SharedEditorSession<unknown>['checkpoint']>) => void;
  setConnected: (value: boolean) => void;
}
/** This Host owns polling, checkpoint storage and resource lifetime, including unmount. */
function SharedHost({ create, kind }: { create: () => Promise<HostConnection>; kind: Surface }) {
  const [inputs] = useState(() => new EditorInputs());
  const [attached, setAttached] = useState(true),
    [connection, setConnection] = useState<HostConnection>();
  const [online, setOnline] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    if (!attached) return;
    let disposed = false,
      active: HostConnection | undefined,
      timer: ReturnType<typeof setInterval> | undefined;
    let retainedRevision = -1;
    const retain = () => {
      if (!active || active.session.recoveryRevision === retainedRevision) return;
      active.retain(active.session.checkpoint());
      retainedRevision = active.session.recoveryRevision;
    };
    void create()
      .then((value) => {
        if (disposed) {
          value.session.suspend(value.retain);
          return;
        }
        active = value;
        setConnection(value);
        setOnline(true);
        let polling = false;
        timer = setInterval(() => {
          if (polling || disposed) return;
          polling = true;
          void value.session
            .sync()
            .catch((e) => {
              if (disposed) return;
              value.session.error = String(e);
              value.session.client.status = 'disconnected';
              value.session.onChange();
            })
            .finally(() => {
              polling = false;
              if (!disposed) {
                try {
                  retain();
                } catch (e) {
                  setError(String(e));
                }
              }
            });
        }, 350);
        window.addEventListener('beforeunload', retain);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('beforeunload', retain);
      if (active && active.session.client.status !== 'closed')
        active.session.suspend(active.retain);
      setConnection(undefined);
    };
  }, [attached, create]);
  return (
    <>
      <nav className="embed-history" aria-label="Host connection">
        <button
          onClick={() => {
            try {
              if (attached && connection) {
                flushSync(() => inputs.flush());
                connection.session.suspend(connection.retain);
              }
              setError('');
              setAttached(!attached);
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          {attached ? 'Detach editor' : 'Attach editor'}
        </button>
        {attached && connection && (
          <button
            onClick={() => {
              connection.setConnected(!online);
              setOnline(!online);
              if (!online) void connection.session.reconnect().catch((e) => setError(String(e)));
            }}
          >
            {online ? 'Pause connection' : 'Resume connection'}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </nav>
      {attached && connection && (
        <IndependentHost shared={connection.session} initialKind={kind} inputs={inputs} />
      )}
    </>
  );
}
// An external Host supplies authenticated, opaque credentials. No Room model or reference
// server is imported. Replace the factory below to inject another EditorHostAdapter.
function bootstrap() {
  const configuration = sessionStorage.getItem('ep-independent-host');
  if (!configuration) return <IndependentHost />;
  const injected = JSON.parse(configuration) as {
    domain: Surface;
    identity: Identity;
    token: string;
    base?: string;
  };
  const codecs = {
    slide: slideEditorCodec,
    design: designEditorCodec,
    whiteboard: whiteboardEditorCodec,
    data: dataEditorCodec,
    document: documentEditorCodec,
    review: reviewCodec,
    file: fileCodec,
  };
  const checkpointKey = `ep-independent-pending:${injected.domain}:${injected.identity.sessionId}:${injected.identity.clientId}`;
  const create = async (): Promise<HostConnection> => {
    const adapter = new HttpEditorAdapter<unknown>(
      injected.identity,
      injected.token,
      injected.domain,
      injected.base,
    );
    const session = new SharedEditorSession(
      codecs[injected.domain] as DomainCodec<unknown>,
      adapter,
    );
    const retain: HostConnection['retain'] = (checkpoint) =>
      sessionStorage.setItem(checkpointKey, JSON.stringify(checkpoint));
    const checkpoint = sessionStorage.getItem(checkpointKey);
    if (checkpoint) session.resume(JSON.parse(checkpoint));
    try {
      await session.open();
      if (session.pendingCount) await session.reconnect();
    } catch (e) {
      if (session.client.confirmed) session.suspend(retain);
      else session.client.close();
      throw e;
    }
    return {
      session,
      retain,
      setConnected: (value) => {
        adapter.connected = value;
      },
    };
  };
  return <SharedHost create={create} kind={injected.domain} />;
}
const root = createRoot(document.getElementById('root')!);
try {
  root.render(bootstrap());
} catch (e) {
  root.render(<p role="alert">{String(e)}</p>);
}
