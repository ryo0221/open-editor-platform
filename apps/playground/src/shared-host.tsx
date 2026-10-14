import { useEffect, useState } from 'react';
import { createArtifact } from '@editor-platform/artifact-core';
import { type DomainCodec, type Operation } from '@editor-platform/collaboration-core';
import {
  HttpEditorAdapter,
  SharedEditorSession,
  slideEditorCodec,
  designEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
  documentEditorCodec,
  reviewCodec,
  fileCodec,
  reactUiEditorCodec,
  annotationsToThreads,
  editorAssetCodec,
  type EditorConnectionCredentials,
} from '@editor-platform/collaboration-adapters';
import { practicalProposal } from './practical-agent';
import { ReferenceRecoveryStore, downloadRecoveryEntries } from './recovery-store';
import App, { type SharedPlaygroundConnection } from './App';
import { type Content, type Kind, type StoredArtifact } from './model';
const codecs = {
  'react-ui': reactUiEditorCodec,
  slide: slideEditorCodec,
  design: designEditorCodec,
  whiteboard: whiteboardEditorCodec,
  data: dataEditorCodec,
  document: documentEditorCodec,
  review: reviewCodec,
  file: fileCodec,
};
class ReferenceEditorAdapter extends HttpEditorAdapter<Content> {
  dropNextAcknowledgement = false;
  async submit(op: Operation) {
    const receipt = await super.submit(op);
    if (this.dropNextAcknowledgement) {
      this.dropNextAcknowledgement = false;
      throw new Error('Reference acknowledgement lost; query the receipt on reconnect');
    }
    return receipt;
  }
}

/** Demo identity selection and share links belong only to this reference Host. */
async function connect(
  artifactId: string,
  domain: Kind,
  actor: 'A' | 'B' | 'C',
  initial?: StoredArtifact,
) {
  if (domain === 'structured-graph')
    throw new Error('Structured Graph is local-only; shared editing is not supported');
  const storageKey = `ep-shared-host:${artifactId}:${actor}`;
  let credentials: EditorConnectionCredentials | undefined;
  try {
    credentials = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') ?? undefined;
  } catch {
    /* missing credential */
  }
  const codec = editorAssetCodec(codecs[domain] as DomainCodec<Content>);
  if (credentials) {
    const adapter = new HttpEditorAdapter<Content>(credentials.identity, credentials.token, domain);
    try {
      await adapter.open();
    } catch {
      credentials = undefined;
    }
  }
  if (!credentials) {
    const response = await fetch('/collaboration-api/editor/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor,
        artifactId,
        domain,
        ...(initial
          ? {
              initial: {
                name: initial.name,
                content: initial.draft.content,
                versions: initial.versions,
                threads: annotationsToThreads(domain, initial.draft.content, initial.annotations),
              },
            }
          : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    credentials = result as EditorConnectionCredentials;
    sessionStorage.setItem(storageKey, JSON.stringify(credentials));
  }
  const adapter = new ReferenceEditorAdapter(
    credentials.identity,
    credentials.token,
    domain,
    undefined,
    { immutableContent: true },
  );
  const session = new SharedEditorSession(codec, adapter);
  const checkpointKey = `ep-shared-pending:${artifactId}:${actor}`;
  const recovery = await ReferenceRecoveryStore.open<ReturnType<typeof session.checkpoint>>(
    checkpointKey,
    sessionStorage,
  );
  try {
    const checkpoint = await recovery.load();
    if (checkpoint !== undefined) {
      try {
        session.resume(checkpoint);
      } catch {
        throw new Error(
          'The retained checkpoint belongs to an unavailable session. Download it for recovery before reopening this artifact.',
        );
      }
    }
    await session.open();
    if (session.pendingCount) await session.reconnect();
  } catch (error) {
    recovery.close();
    // All input came from the checkpoint still retained on disk. No live session
    // was exposed: detach resources without overwriting a failed/foreign recovery.
    session.suspend(() => {});
    throw error;
  }
  const record: StoredArtifact = {
    ...createArtifact(domain, credentials.name, session.content),
    id: artifactId,
    annotations: [],
  };
  const params = new URLSearchParams({
    shared: artifactId,
    kind: domain,
    actor: actor === 'B' ? 'A' : 'B',
  });
  const connection: SharedPlaygroundConnection = {
    session,
    record,
    peerUrl: `/?${params}`,
    leave: () => {
      stop();
      window.location.assign('/');
    },
    hostActions: [
      {
        label: 'Pause transport (reference)',
        run: () => {
          adapter.connected = false;
        },
      },
      {
        label: 'Resume transport (reference)',
        run: async () => {
          adapter.connected = true;
          await session.reconnect();
        },
      },
      {
        label: 'Lose next acknowledgement (reference)',
        run: () => {
          adapter.dropNextAcknowledgement = true;
        },
      },
      {
        label: 'Make session read only (reference)',
        run: async () => {
          await adapter.request('/editor/reference-permissions', { writable: false });
          await session.sync();
        },
      },
      {
        label: 'Restore write access (reference)',
        run: async () => {
          await adapter.request('/editor/reference-permissions', {
            writable: true,
            expiresAt: Date.now() + 3600000,
          });
          await session.sync();
        },
      },
      {
        label: 'Expire session (reference)',
        run: async () => {
          await adapter.request('/editor/reference-permissions', {
            writable: false,
            expiresAt: Date.now() - 1,
          });
          await session.sync();
        },
      },
    ],
    async requestProposal() {
      // Deterministic external client C uses exactly the public prepare/transaction API.
      const agent = await connect(artifactId, domain, 'C');
      try {
        const proposal = practicalProposal(
          agent.connection.session.confirmed,
          agent.connection.session.adapter.identity,
        );
        await agent.connection.session.adapter.registerProposal(proposal);
        return proposal.id;
      } finally {
        agent.stop();
      }
    },
  };
  let retainedRevision = -1;
  let recoveryError: string | undefined;
  const reportRecoveryError = (error: unknown) => {
    recoveryError = `Recovery checkpoint could not be saved: ${String(error)}`;
    session.error = recoveryError;
    session.onChange();
  };
  const retain = async () => {
    const revision = session.recoveryRevision;
    if (revision === retainedRevision) return;
    await recovery.write(session.captureCheckpoint());
    retainedRevision = revision;
    if (!stopped && recoveryError && session.error === recoveryError) {
      session.error = '';
      session.onChange();
    }
    recoveryError = undefined;
  };
  let polling = false,
    stopped = false;
  let cancelPreparation: (() => void) | undefined;
  const prepareAfterPaint = () =>
    new Promise<void>((resolve) => {
      const ready = () => {
        cancelPreparation = undefined;
        resolve();
      };
      // Structured storage still serializes on the main thread. Let pending input
      // paint first; the timeout bounds persistence delay under continuous activity.
      if (window.requestIdleCallback) {
        const id = window.requestIdleCallback(ready, { timeout: 1000 });
        cancelPreparation = () => {
          window.cancelIdleCallback(id);
          ready();
        };
      } else {
        const id = window.setTimeout(ready, 0);
        cancelPreparation = () => {
          window.clearTimeout(id);
          ready();
        };
      }
    });
  const timer = window.setInterval(() => {
    if (polling) return;
    polling = true;
    void session
      .sync()
      .catch((error) => {
        if (stopped) return;
        session.error = String(error);
        session.client.status = 'disconnected';
        session.onChange();
      })
      .finally(async () => {
        if (!stopped) {
          try {
            await prepareAfterPaint();
            if (!stopped) await retain();
          } catch (error) {
            if (!stopped) reportRecoveryError(error);
          }
        }
        polling = false;
      });
  }, 350);
  const beforeUnload = (event: BeforeUnloadEvent) => {
    let failed = false;
    try {
      if (session.recoveryRevision !== retainedRevision) recovery.retainSync(session.checkpoint());
    } catch (error) {
      failed = true;
      reportRecoveryError(error);
    }
    if (failed || session.pendingCount) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  function stop() {
    if (stopped) return;
    session.suspend((checkpoint) => recovery.retainSync(checkpoint));
    stopped = true;
    cancelPreparation?.();
    clearInterval(timer);
    window.removeEventListener('beforeunload', beforeUnload);
    recovery.close();
  }
  return {
    connection,
    stop,
  };
}
export function ReferencePlayground() {
  const [shared, setShared] = useState<SharedPlaygroundConnection>();
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(new URLSearchParams(location.search).has('shared'));
  useEffect(() => {
    const params = new URLSearchParams(location.search),
      id = params.get('shared'),
      kind = params.get('kind') as Kind;
    if (!id || !Object.hasOwn(codecs, kind)) {
      setOpening(false);
      return;
    }
    let disposed = false,
      stop: (() => void) | undefined;
    void connect(id, kind, params.get('actor') === 'B' ? 'B' : 'A')
      .then((result) => {
        if (disposed) {
          result.stop();
          return;
        }
        stop = result.stop;
        setShared(result.connection);
        setOpening(false);
      })
      .catch((e) => {
        setError(String(e));
        setOpening(false);
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  if (opening) return <p role="status">Opening shared artifact…</p>;
  if (error)
    return (
      <main>
        <p role="alert">{error}</p>
        <button
          onClick={() => {
            void downloadRecoveryEntries(sessionStorage)
              .then((data) => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data)], { type: 'application/json' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = 'editor-recovery-checkpoints.json';
                link.click();
                URL.revokeObjectURL(url);
              })
              .catch((cause) => setError(`Recovery download failed: ${String(cause)}`));
          }}
        >
          Download retained checkpoints
        </button>
        <a href="/">Return to local library</a>
      </main>
    );
  return (
    <App
      shared={shared}
      onStartShared={async (record) => {
        const result = await connect(record.id, record.kind as Kind, 'A', record);
        result.stop();
        window.location.assign(
          `/?${new URLSearchParams({ shared: record.id, kind: record.kind, actor: 'A' })}`,
        );
      }}
    />
  );
}
