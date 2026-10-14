import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { Plugin } from 'prosemirror-state';
import { sendableSteps } from 'prosemirror-collab';
import {
  CollaborationClient,
  operation,
  condition,
  uid,
  type Domain,
  type DomainCodec,
  type Action,
  type Snapshot,
  type Proposal,
  type Preview,
  type Receipt,
  type Presence,
  type Anchor,
  type ConfirmedVersion,
} from '@editor-platform/collaboration-core';
import {
  HttpSyncAdapter,
  DocumentReplica,
  slideCodec,
  dataCodec,
  documentCodec,
  designCodec,
  whiteboardCodec,
  reviewCodec,
  fileCodec,
  setField,
  move,
  cell,
} from '@editor-platform/collaboration-adapters';
import { exportMarkdown, type DocumentContent } from '@editor-platform/document/model';
import type { SlideContent } from '@editor-platform/slide/model';
import { exportCsv, type StructuredData } from '@editor-platform/structured-data/model';
import type { DesignContent } from '@editor-platform/design/model';
import type { WhiteboardContent } from '@editor-platform/whiteboard/model';
import { exportSlideSvg } from '@editor-platform/slide/model';
import './style.css';
const codecs = {
  slide: slideCodec,
  data: dataCodec,
  document: documentCodec,
  design: designCodec,
  whiteboard: whiteboardCodec,
  review: reviewCodec,
  file: fileCodec,
};
const params = new URLSearchParams(location.search),
  actor: 'A' | 'B' = params.get('actor') === 'B' ? 'B' : 'A',
  room = params.get('room') ?? 'welcome';
const startingDomain = (params.get('domain') ?? 'slide') as Domain;
type Session = {
  adapter: HttpSyncAdapter<unknown>;
  agent: HttpSyncAdapter<unknown>;
  client?: CollaborationClient<unknown>;
  document?: DocumentReplica;
  codec: DomainCodec<unknown>;
};
function App() {
  const [domain, setDomain] = useState<Domain>(startingDomain in codecs ? startingDomain : 'slide'),
    [session, setSession] = useState<Session>(),
    [tick, setTick] = useState(0),
    [message, setMessage] = useState('Connecting…'),
    [selected, setSelected] = useState('shape1'),
    [online, setOnline] = useState(true),
    [presences, setPresences] = useState<Presence[]>([]),
    [zoom, setZoom] = useState(100),
    [proposal, setProposal] = useState<Proposal>(),
    [preview, setPreview] = useState<Preview<unknown>>(),
    [lastOwn, setLastOwn] = useState<string>(),
    [lastUndo, setLastUndo] = useState<string>(),
    [note, setNote] = useState(''),
    [panel, setPanel] = useState(true);
  const [savedVersions, setSavedVersions] = useState<ConfirmedVersion<unknown>[]>([]);
  const sessionRef = useRef<Session | undefined>(undefined),
    presencesRef = useRef<Presence[]>([]),
    viewRef = useRef<EditorView | null>(null),
    editorRef = useRef<HTMLDivElement>(null);
  presencesRef.current = presences;
  const snapshot: Snapshot<unknown> | undefined =
    session?.document?.confirmed ?? session?.client?.optimistic;
  const confirmed = session?.document?.confirmed ?? session?.client?.confirmed;
  const refresh = () => setTick((t) => t + 1);
  function report(error: unknown) {
    setMessage(error instanceof Error ? error.message : String(error));
  }
  async function sync(s = sessionRef.current) {
    if (!s) return;
    if (s.document) await s.document.sync();
    else await s.client!.sync();
    refresh();
  }
  function showReceipt(receipt: Receipt) {
    setMessage(
      receipt.status === 'accepted'
        ? `Accepted · revision ${receipt.revision} · in memory`
        : `${receipt.code}: ${receipt.message}`,
    );
    if (receipt.status === 'accepted') {
      setLastOwn(receipt.operationId);
      setLastUndo(undefined);
    }
  }
  useEffect(() => {
    let cancelled = false,
      polling = false;
    setSession(undefined);
    sessionRef.current = undefined;
    setMessage('Connecting…');
    setSavedVersions([]);
    setProposal(undefined);
    setPreview(undefined);
    setLastOwn(undefined);
    setOnline(true);
    void (async () => {
      const adapter = await HttpSyncAdapter.connect(actor, room, domain),
        agent = await HttpSyncAdapter.connect('C', room, domain),
        codec = codecs[domain as keyof typeof codecs] as DomainCodec<unknown>;
      const s: Session = { adapter, agent, codec };
      if (domain === 'document') {
        s.document = new DocumentReplica(adapter as HttpSyncAdapter<DocumentContent>);
        await s.document.open();
        s.document.onChange = () => {
          if (viewRef.current && viewRef.current.state !== s.document!.state)
            viewRef.current.updateState(s.document!.state);
          refresh();
        };
      } else {
        s.client = new CollaborationClient(codec, adapter);
        s.client.onChange = refresh;
        await s.client.open();
      }
      if (cancelled) {
        adapter.close();
        agent.close();
        return;
      }
      sessionRef.current = s;
      setSession(s);
      setSelected(
        domain === 'slide'
          ? 'shape1'
          : domain === 'design'
            ? 'child'
            : domain === 'whiteboard'
              ? 'one'
              : 'row1',
      );
      setMessage('Connected · independent client state');
    })().catch(report);
    const timer = setInterval(() => {
      const s = sessionRef.current;
      if (!s || !s.adapter.connected || polling) return;
      polling = true;
      void (async () => {
        await sync(s);
        const position = s.document?.presencePosition() ?? {
          basis: s.client!.confirmed.revision,
          anchor: currentAnchor(s),
        };
        const values = await s.adapter.presence({
          name: `Human ${actor}`,
          color: actor === 'A' ? '#356b50' : '#315ab5',
          page: domain,
          ...position,
        });
        await sync(s);
        setPresences(values);
        if (viewRef.current) viewRef.current.updateState(s.document!.state);
      })()
        .catch(report)
        .finally(() => {
          polling = false;
        });
    }, 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
      sessionRef.current?.adapter.close();
      sessionRef.current?.agent.close();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [domain]);
  useEffect(() => {
    if (!session?.document || !editorRef.current) return;
    const replica = session.document;
    const decorations = new Plugin({
      props: {
        decorations(state) {
          const values: Decoration[] = [];
          for (const p of presencesRef.current) {
            if (
              p.clientId === session.adapter.identity.clientId ||
              p.anchor?.type !== 'text' ||
              p.anchor.orphan
            )
              continue;
            const anchor = replica.localAnchor(p.anchor, p.basis);
            if (anchor.type !== 'text' || anchor.orphan) continue;
            const at = Math.min(anchor.from, state.doc.content.size);
            values.push(
              Decoration.widget(
                at,
                () => {
                  const span = document.createElement('span');
                  span.className = 'remote-caret';
                  span.style.borderColor = p.color;
                  span.title = p.name;
                  span.setAttribute('aria-label', p.name);
                  return span;
                },
                { side: 1, key: `${p.clientId}:${p.sessionId}:${p.color}:${p.name}` },
              ),
            );
          }
          for (const thread of replica.confirmed.threads) {
            const a = replica.localAnchor(thread.anchor);
            if (a.type === 'text' && !a.orphan && a.to > a.from && a.to <= state.doc.content.size)
              values.push(
                Decoration.inline(a.from, a.to, {
                  class: 'comment-range',
                  'data-thread': thread.id,
                }),
              );
          }
          return DecorationSet.create(state.doc, values);
        },
      },
    });
    replica.state = replica.state.reconfigure({ plugins: [...replica.state.plugins, decorations] });
    const view = new EditorView(editorRef.current, {
      state: replica.state,
      editable: () => replica.permissions?.writable !== false,
      attributes: { 'aria-label': 'Shared document', role: 'textbox', 'aria-multiline': 'true' },
      dispatchTransaction(transaction) {
        replica.dispatch(transaction);
        if (transaction.docChanged)
          void replica
            .flush()
            .then(() => {
              if (replica.lastReceipt) showReceipt(replica.lastReceipt);
            })
            .catch(report);
      },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [session]);
  function currentAnchor(s: Session): Anchor | undefined {
    if (s.document)
      return {
        type: 'text',
        from: s.document.state.selection.from,
        to: s.document.state.selection.to,
      };
    const ids: Record<string, string> = {
      slide: 'shape1',
      design: 'child',
      whiteboard: 'one',
      data: 'row1',
    };
    if (ids[domain]) return { type: 'element', elementId: ids[domain] };
    if (domain === 'review')
      return { type: 'fixed', elementId: 'source', versionId: 'new-v1', side: 'new' };
    if (domain === 'file') return { type: 'fixed', elementId: 'file-v1', versionId: 'file-v1' };
  }
  async function submit(actions: Action[]) {
    try {
      const s = sessionRef.current;
      if (!s?.client) return;
      const op = operation(s.codec, s.client.confirmed, s.adapter.identity, actions);
      showReceipt(await s.client.submit(op));
    } catch (error) {
      report(error);
    }
  }
  async function toggleConnection() {
    const s = sessionRef.current;
    if (!s) return;
    if (s.adapter.connected) {
      await s.adapter.presence(null);
      s.adapter.connected = false;
      setOnline(false);
      setMessage('Disconnected · pending edits remain on this client');
    } else {
      s.adapter.connected = true;
      setOnline(true);
      try {
        if (s.document) await s.document.flush();
        else await s.client!.reconnect();
        setMessage('Reconnected · pending receipts reconciled');
      } catch (error) {
        report(error);
      }
    }
    refresh();
  }
  async function undo(redo = false) {
    if (!session) return;
    try {
      const receipt = await session.adapter.request<Receipt>('/undo', {
        id: redo ? lastUndo : lastOwn,
        redo,
      });
      if (receipt.status === 'accepted') {
        if (redo) {
          setLastOwn(receipt.operationId);
          setLastUndo(undefined);
        } else setLastUndo(receipt.operationId);
      }
      setMessage(
        receipt.status === 'accepted'
          ? `${redo ? 'Redo' : 'Undo'} accepted · revision ${receipt.revision}`
          : `${receipt.code}: ${receipt.message}`,
      );
      await sync();
    } catch (error) {
      report(error);
    }
  }
  async function generate() {
    if (!session) return;
    try {
      const state = await session.agent.open();
      let actions: Action[], reads: string[];
      if (domain === 'data') {
        actions = [cell('row2', 'name', 'Agent C reviewed')];
        reads = ['cell/row1/value'];
      } else if (domain === 'slide') {
        actions = [setField('shape2', 'fill', '#cf7a46')];
        reads = ['shape1/fill'];
      } else if (domain === 'design') {
        actions = [setField('child', 'fill', '#cf7a46')];
        reads = ['child/bounds'];
      } else if (domain === 'whiteboard') {
        actions = [setField('two', 'color', '#cf7a46')];
        reads = ['one/color'];
      } else {
        actions = [
          { type: 'thread.create', target: uid(), payload: { anchor: currentAnchor(session) } },
        ];
        reads = ['*'];
      }
      const op = operation(session.codec, state, session.agent.identity, actions, 'agent');
      const p: Proposal = {
        schema: 1,
        id: uid(),
        artifactId: state.artifactId,
        sourceActorId: 'C',
        baseRevision: state.revision,
        summary: 'Deterministic agent C: review the referenced value and propose one change.',
        actions,
        reads: reads.map((k) => condition(session.codec, state, k)),
        writes: op.conditions,
        external: [],
      };
      await session.agent.request('/proposal/register', p);
      setProposal(p);
      setPreview(undefined);
      setMessage('Agent C proposal ready · no content changed');
    } catch (error) {
      report(error);
    }
  }
  async function previewProposal() {
    if (!session || !proposal) return;
    try {
      setPreview(await session.adapter.request('/proposal/preview', { id: proposal.id }));
      setMessage('Preview ready · editing remains available');
    } catch (error) {
      report(error);
    }
  }
  async function applyProposal() {
    if (!session || !proposal || !preview) return;
    try {
      const receipt = await session.adapter.request<Receipt>('/proposal/apply', {
        id: proposal.id,
        token: preview.token,
      });
      showReceipt(receipt);
      await sync();
    } catch (error) {
      report(error);
    }
  }
  async function cancelProposal() {
    if (!session || !proposal) return;
    try {
      const state = await session.adapter.request<{ state: string }>('/proposal/cancel', {
        id: proposal.id,
      });
      setMessage(`Proposal ${state.state}`);
      setPreview(undefined);
    } catch (error) {
      report(error);
    }
  }
  function previewValue(content: unknown): string {
    if (domain === 'slide')
      return (content as SlideContent).slides[0].objects.find((o) => o.id === 'shape2')?.fill ?? '';
    if (domain === 'data')
      return String(
        (content as StructuredData).rows.find((r) => r.id === 'row2')?.values.name ?? '',
      );
    if (domain === 'design')
      return (content as DesignContent).elements.find((e) => e.id === 'child')?.fill ?? '';
    if (domain === 'whiteboard')
      return (content as WhiteboardContent).nodes.find((n) => n.id === 'two')?.color ?? '';
    return 'Original content remains unchanged; the proposal adds an anchored annotation.';
  }
  async function saveVersion() {
    if (!session) return;
    try {
      const saved = await session.adapter.request<ConfirmedVersion<unknown>>('/version', {});
      setSavedVersions((values) => [...values, saved]);
      setMessage(`Saved immutable version from confirmed revision ${saved.confirmedRevision}`);
    } catch (error) {
      report(error);
    }
  }
  function download() {
    if (!confirmed) return;
    const content = confirmed.content;
    let text = JSON.stringify(content, null, 2),
      name = `${domain}.json`,
      mime = 'application/json';
    if (domain === 'slide') {
      const deck = content as SlideContent;
      text = exportSlideSvg(deck, deck.slides[0]);
      name = 'slide.svg';
      mime = 'image/svg+xml';
    }
    if (domain === 'data') {
      text = exportCsv(content as StructuredData);
      name = 'data.csv';
      mime = 'text/csv';
    }
    if (domain === 'document') {
      text = exportMarkdown(content as DocumentContent);
      name = 'document.md';
      mime = 'text/markdown';
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    setMessage(`Exported confirmed revision ${confirmed.revision}`);
  }
  const pending = session?.document
    ? (sendableSteps(session.document.state)?.steps.length ?? 0)
    : (session?.client?.pending.length ?? 0);
  let shapes: {
    id: string;
    fill: string;
    bounds: { x: number; y: number; width: number; height: number };
  }[] = [];
  if (snapshot && domain === 'slide') shapes = (snapshot.content as SlideContent).slides[0].objects;
  if (snapshot && domain === 'design') shapes = (snapshot.content as DesignContent).elements;
  if (snapshot && domain === 'whiteboard')
    shapes = (snapshot.content as WhiteboardContent).nodes.map((n) => ({ ...n, fill: n.color }));
  return (
    <div className="collaboration-shell" data-render={tick}>
      <header>
        <a href="/">EDITOR PLATFORM</a>
        <span className="badge">COLLABORATION LAB</span>
        <span className="identity">
          Human {actor} · room {room}
        </span>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">SHARED WORK, INDEPENDENT CLIENTS</p>
            <h1>Make room for another perspective.</h1>
            <p>
              Open this room as A and B in separate browser contexts. Agent C uses the same
              operation contract.
            </p>
          </div>
          <a
            className="secondary"
            href={`?room=${encodeURIComponent(room)}&actor=${actor === 'A' ? 'B' : 'A'}&domain=${domain}`}
            target="_blank"
            rel="noreferrer"
          >
            Open human {actor === 'A' ? 'B' : 'A'}
          </a>
        </div>
        <div className="toolbar">
          <label>
            Surface{' '}
            <select
              aria-label="Surface"
              value={domain}
              onChange={(e) => setDomain(e.target.value as Domain)}
            >
              {Object.keys(codecs).map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <button onClick={() => void toggleConnection()}>
            {online ? 'Disconnect' : 'Reconnect'}
          </button>
          <button disabled={!lastOwn || !online || pending > 0} onClick={() => void undo()}>
            Undo my edit
          </button>
          <button disabled={!lastUndo || !online || pending > 0} onClick={() => void undo(true)}>
            Redo my edit
          </button>
          <button disabled={!confirmed} onClick={download}>
            Export confirmed
          </button>
          <button disabled={!confirmed || !online} onClick={() => void saveVersion()}>
            Save confirmed version
          </button>
          <label>
            Zoom{' '}
            <input
              aria-label="Private zoom"
              type="range"
              min="60"
              max="130"
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            {zoom}%
          </label>
          <button onClick={() => setPanel(!panel)}>Toggle agent panel</button>
          {!!savedVersions.length && ['slide', 'design', 'whiteboard', 'data'].includes(domain) && (
            <button
              onClick={() => {
                if (!session || !confirmed) return;
                void session.adapter
                  .request<Receipt>('/restore-version', {
                    versionId: savedVersions.at(-1)!.version.versionId,
                    expectedRevision: confirmed.revision,
                  })
                  .then(async (receipt) => {
                    showReceipt(receipt);
                    await sync();
                  })
                  .catch(report);
              }}
            >
              Restore last saved version
            </button>
          )}
        </div>
        <div className="sync-line">
          <span className={online ? 'dot' : 'dot offline'} />
          <span role="status">{message}</span>
          <span data-testid="revision">Revision {confirmed?.revision ?? 0}</span>
          <span data-testid="pending">Pending {pending}</span>
          <span>{presences.map((p) => p.name).join(' · ')}</span>
        </div>
        <div className={`workspace ${panel ? '' : 'wide'}`}>
          <section className="surface" aria-label="Shared surface">
            <div className="surface-heading">
              <strong>{domain.toUpperCase()}</strong>
              <span>Confirmed state and pending changes are shown separately</span>
            </div>
            {domain === 'document' ? (
              <div className="document-page" style={{ fontSize: `${zoom}%` }}>
                <div ref={editorRef} />
              </div>
            ) : shapes.length ? (
              <>
                <div className="canvas-tools">
                  <label>
                    Selection{' '}
                    <select
                      aria-label="Selected shape"
                      value={selected}
                      onChange={(e) => setSelected(e.target.value)}
                    >
                      {shapes.map((s) => (
                        <option key={s.id}>{s.id}</option>
                      ))}
                    </select>
                  </label>
                  <button onClick={() => void submit([move(selected, 20, 0)])}>Move right</button>
                  <button
                    onClick={() =>
                      void submit([
                        setField(
                          selected,
                          domain === 'whiteboard' ? 'color' : 'fill',
                          actor === 'A' ? '#cf5548' : '#4268bb',
                        ),
                      ])
                    }
                  >
                    Set my color
                  </button>
                  <button disabled title="Group resizing is not supported in this shared reference">
                    Resize group
                  </button>
                </div>
                <div className="canvas-scroll">
                  <svg
                    aria-label="Shared canvas"
                    viewBox="0 0 960 540"
                    style={{ width: `${zoom}%` }}
                  >
                    {domain === 'whiteboard' &&
                      (snapshot?.content as WhiteboardContent).connectors.map((c) => (
                        <line
                          key={c.id}
                          x1="100"
                          y1="50"
                          x2="200"
                          y2="50"
                          stroke="#55665d"
                          strokeWidth="3"
                        />
                      ))}
                    {shapes.map((s) => (
                      <g key={s.id} data-testid={s.id}>
                        <rect
                          x={s.bounds.x}
                          y={s.bounds.y}
                          width={s.bounds.width}
                          height={s.bounds.height}
                          fill={s.fill}
                          stroke={selected === s.id ? '#172e23' : 'none'}
                          strokeWidth="3"
                          onClick={() => setSelected(s.id)}
                        />
                        <text x={s.bounds.x + 12} y={s.bounds.y + 26} fill="#fff">
                          {s.id}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>
              </>
            ) : domain === 'data' && snapshot ? (
              <table>
                <thead>
                  <tr>
                    {(snapshot.content as StructuredData).columns.map((c) => (
                      <th key={c.id}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.content as StructuredData).rows.map((r) => (
                    <tr key={r.id}>
                      {(snapshot.content as StructuredData).columns.map((c) => (
                        <td key={c.id}>
                          <input
                            key={String(r.values[c.id])}
                            aria-label={`${r.id} ${c.id}`}
                            defaultValue={String(r.values[c.id] ?? '')}
                            onBlur={(e) => {
                              const value =
                                c.type === 'number' ? Number(e.target.value) : e.target.value;
                              if (value !== r.values[c.id]) void submit([cell(r.id, c.id, value)]);
                            }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <pre>{JSON.stringify(snapshot?.content, null, 2)}</pre>
            )}
            <div className="comments">
              <h2>Shared annotations</h2>
              <div>
                <input
                  aria-label="Comment text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a note for this surface"
                />
                <button
                  disabled={!note || !session}
                  onClick={() => {
                    if (!session) return;
                    const id = uid();
                    void (async () => {
                      const actions: Action[] = [
                        {
                          type: 'thread.create',
                          target: id,
                          payload: { anchor: currentAnchor(session) },
                        },
                        { type: 'thread.reply', target: id, payload: { id: uid(), text: note } },
                      ];
                      if (session.document) {
                        await session.document.flush();
                        const state = session.document.confirmed;
                        showReceipt(
                          await session.adapter.submit(
                            operation(session.codec, state, session.adapter.identity, actions),
                          ),
                        );
                        await sync();
                      } else await submit(actions);
                      setNote('');
                    })().catch(report);
                  }}
                >
                  Add comment
                </button>
              </div>
              {snapshot?.threads.map((t) => (
                <article key={t.id}>
                  <span>
                    {t.anchor.orphan ? 'Orphaned anchor' : t.resolved ? 'Resolved' : 'Open'} ·{' '}
                    {t.anchor.type}
                  </span>
                  {t.replies.map((r) => (
                    <p key={r.id}>
                      <b>{r.actorId}</b> {r.text}
                    </p>
                  ))}
                </article>
              ))}
            </div>
          </section>
          {panel && (
            <aside>
              <p className="eyebrow">AGENT C</p>
              <h2>A proposal, with context.</h2>
              <p>
                The deterministic agent reads a declared dependency. Preview is separate from
                applying the change.
              </p>
              <button disabled={!session || !online} onClick={() => void generate()}>
                Generate proposal
              </button>
              {proposal && (
                <div className="proposal">
                  <p>{proposal.summary}</p>
                  <p className="muted">Reads: {proposal.reads?.map((r) => r.key).join(', ')}</p>
                  <button onClick={() => void previewProposal()}>Preview proposal</button>
                  <button onClick={() => void cancelProposal()}>Cancel proposal</button>
                  {preview && (
                    <>
                      <p data-testid="proposal-diff">Changed: {preview.changedKeys.join(', ')}</p>
                      <p>
                        <b>Before:</b> {previewValue(preview.before)}
                      </p>
                      <p>
                        <b>After:</b> {previewValue(preview.after)}
                      </p>
                      <button className="primary" onClick={() => void applyProposal()}>
                        Apply proposal
                      </button>
                    </>
                  )}
                </div>
              )}
              <hr />
              <h2>Reference capabilities</h2>
              <p>
                In-memory authority, ordered operations, checked proposals and selective Undo.
                Long-term offline merging and production authentication are outside this demo.
              </p>
              <p>
                Shared canvas text editing, group resizing and advanced layout commands are
                unavailable here. The main editor retains its single-user features.
              </p>
            </aside>
          )}
        </div>
        <details>
          <summary>Confirmed content for verification</summary>
          <pre data-testid="confirmed-content">{JSON.stringify(confirmed?.content)}</pre>
        </details>
      </main>
      <footer>LOCAL REFERENCE · NO AI PROVIDER · NO API KEY</footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
