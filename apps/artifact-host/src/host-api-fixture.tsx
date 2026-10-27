import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createArtifact,
  newId,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import { EditorInputs, type EditorCommand } from '@editor-platform/editor-core';
import {
  EditorExportGuardContext,
  EditorHistoryContext,
  EditorInputsContext,
} from '@editor-platform/editor-ui';
import {
  ArtifactEditor,
  EditorHostError,
  loadHostArtifact,
  type EditorHostAdapter,
  type HostProposalResult,
  type HostPendingProposal,
  type HostSavedEvent,
} from '@editor-platform/editor-host';
import { DocumentSurface } from '@editor-platform/document';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import {
  documentText,
  documentTextAccess,
  documentTextEditCommand,
  findDocumentText,
} from '@editor-platform/document/text';
import { DataSurface } from '@editor-platform/structured-data';
import {
  createData,
  displayCell,
  isStructuredData,
  setCell,
  type StructuredData,
} from '@editor-platform/structured-data/model';

/** Independent Host fixture for the public Host API (#400). It imports public packages
 * only: no Playground state, CSS or build-time source replacement. The "external tool"
 * panel stands in for a Host-owned AI/MCP caller and uses the same headless API. */
type Content = DocumentContent | StructuredData;
const capabilities = {
  undo: true,
  nativeJson: true,
  formats: [],
  preview: 'none' as const,
  shared: false as const,
  proposals: true,
};
const documentAdapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  capabilities,
  text: documentTextAccess,
};
const dataAdapter: EditorHostAdapter<StructuredData> = {
  kind: 'data',
  validate: isStructuredData,
  capabilities,
};
const PREFIX = 'host-api-fixture:';
class FixtureStorage<T> implements StorageAdapter<Artifact<T>> {
  /** Fixture controls: fail or hold the next put. */
  failNext = false;
  holdNext = false;
  private release?: () => void;
  constructor(private readonly changed: () => void) {}
  async list() {
    return [];
  }
  async get(id: string) {
    const json = localStorage.getItem(PREFIX + id);
    return json ? (JSON.parse(json) as Artifact<T>) : undefined;
  }
  async remove(id: string) {
    localStorage.removeItem(PREFIX + id);
  }
  get holding() {
    return !!this.release;
  }
  finish() {
    this.release?.();
  }
  async put(value: Artifact<T>) {
    if (this.failNext) {
      this.failNext = false;
      this.changed();
      throw new Error('Fixture storage failed');
    }
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>((resolve) => {
        this.release = resolve;
        this.changed();
      });
      this.release = undefined;
    }
    localStorage.setItem(PREFIX + value.id, JSON.stringify(value));
    this.changed();
  }
}
const documentSeed = (): DocumentContent => ({
  schemaVersion: 2,
  blocks: [
    { id: 'doc-title', type: 'heading', level: 1, text: 'Launch plan' },
    {
      id: 'doc-body',
      type: 'paragraph',
      text: 'Kickoff on Monday.\nReview on Friday.\nShip next week.',
    },
    { id: 'doc-note', type: 'paragraph', text: 'Owners confirm the dates.' },
  ],
});
function dataSeed(): StructuredData {
  const data = createData();
  const [name, status] = data.columns;
  for (const [i, title] of ['Design review', 'Release notes'].entries())
    data.rows.push({
      id: 'row-' + (i + 1),
      values: Object.fromEntries(
        data.columns
          .filter((c) => c.type !== 'formula')
          .map((c) => [
            c.id,
            c.id === name.id ? title : c.id === status.id ? 'Planned' : (c.defaultValue ?? null),
          ]),
      ),
    });
  return data;
}
async function open<T>(
  id: string,
  name: string,
  seed: () => T,
  adapter: EditorHostAdapter<T>,
  storage: FixtureStorage<T>,
): Promise<Artifact<T>> {
  const stored = await storage.get(id);
  if (stored) return loadHostArtifact(JSON.stringify(stored), adapter);
  const created = createArtifact(adapter.kind, name, seed());
  return { ...created, id };
}
const errorText = (error: unknown) =>
  error instanceof EditorHostError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

interface Editors {
  document: ArtifactEditor<DocumentContent>;
  data: ArtifactEditor<StructuredData>;
}
type Kind = keyof Editors;

function Fixture({
  editors,
  storages,
  permission,
}: {
  editors: Editors;
  storages: { document: FixtureStorage<DocumentContent>; data: FixtureStorage<StructuredData> };
  permission: { edit: boolean };
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [kind, setKind] = useState<Kind>('document');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<HostSavedEvent[]>([]);
  const [results, setResults] = useState<HostProposalResult[]>([]);
  const [find, setFind] = useState('Review on Friday.\nShip');
  const [replace, setReplace] = useState('Review on Thursday.\nShip');
  const [pendingInput, setPendingInput] = useState(false);
  const pendingInputRef = useRef(false);
  pendingInputRef.current = pendingInput;
  // Native Surface input buffers (Data view drafts, dialogs) and IME composition.
  const [inputs] = useState(() => new EditorInputs());
  const composing = useRef(false);
  const host = editors[kind] as ArtifactEditor<Content>;
  // Attach exactly one set of listeners for the visible editor; detach on switch.
  useEffect(() => {
    const release = [
      host.attach(refresh),
      host.onSaved((event) => setSaved((list) => [...list, event])),
      host.onProposalResolved((result) => setResults((list) => [...list, result])),
      host.registerInputBoundary(() => {
        if (pendingInputRef.current || composing.current)
          throw new EditorHostError('input-pending', host.id, 'Confirm or cancel the input first');
        try {
          inputs.flush();
        } catch (error) {
          throw new EditorHostError(
            'input-pending',
            host.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    ];
    return () => release.forEach((fn) => fn());
  }, [host, inputs]);
  const run = (fn: () => unknown) => {
    try {
      const value = fn();
      if (value instanceof Promise)
        value.then(
          () => setError(''),
          (e) => setError(errorText(e)),
        );
      else setError('');
    } catch (e) {
      setError(errorText(e));
    }
    refresh();
  };
  const { content, readOnly, dirty, saving } = host.snapshot;
  const execute = (cmd: EditorCommand<Content>) => run(() => host.execute(cmd));
  const select = (id: string) =>
    host.select({ addresses: [{ artifactId: host.id, elementId: id }] });
  const lastSaved = saved.at(-1);
  // Keyboard Undo/Redo in the Surface reaches the retained Host history (private drafts first).
  const history = {
    undo: () => run(() => inputs.history('undo') || host.undo()),
    redo: () => run(() => inputs.history('redo') || host.redo()),
  };

  // External tool: reads the saved version named by the last saved event, then proposes.
  function proposeFromTool() {
    run(() => {
      const event = saved.filter((e) => e.artifactId === host.id).at(-1);
      if (!event) throw new Error('Save first: the tool reads only persisted content');
      if (kind === 'document') {
        const editor = editors.document;
        const savedContent = editor.readSaved(event.versionId ?? undefined).content;
        const range = findDocumentText(savedContent, find);
        return editor.propose({
          id: newId('proposal'),
          summary: `Replace “${find.replace(/\n/g, '⏎')}”`,
          source: 'fixture-tool',
          baseLocalRevision: event.revision,
          commands: [documentTextEditCommand(savedContent, [{ ...range, text: replace }])],
        });
      }
      const editor = editors.data;
      const data = editor.readSaved(event.versionId ?? undefined).content;
      const status = data.columns[1];
      return editor.propose({
        id: newId('proposal'),
        summary: 'Mark the first record Active',
        source: 'fixture-tool',
        baseLocalRevision: event.revision,
        commands: [setCell(data.rows[0].id, status.id, 'Active')],
      });
    });
  }
  const preview = (review: HostPendingProposal<Content>) => {
    const after = review.preview.content;
    if (isDocument(after)) return documentText(after).text;
    if (isStructuredData(after))
      return after.rows
        .map((row) => after.columns.map((c) => displayCell(after, row, c)).join(' | '))
        .join('\n');
    return '';
  };
  const textOf = () => {
    try {
      return host.readText('draft').text;
    } catch (e) {
      return errorText(e);
    }
  };
  const storage = storages[kind] as FixtureStorage<Content>;
  return (
    <main className="host-api">
      <header>
        <h1>Host API fixture</h1>
        <p>Independent Host using public packages only. The tool panel stands in for a Host AI.</p>
        <nav aria-label="Artifacts">
          {(['document', 'data'] as const).map((k) => (
            <button
              key={k}
              aria-pressed={kind === k}
              onClick={() =>
                run(() => {
                  // Switching unmounts the Surface: commit or refuse its pending input first.
                  host.flushInputs();
                  setKind(k);
                })
              }
            >
              {k === 'document' ? 'Document' : 'Data'}
            </button>
          ))}
        </nav>
        <label>
          <input
            type="checkbox"
            checked={!permission.edit}
            onChange={(e) => {
              permission.edit = !e.target.checked;
              run(() => host.refreshPermission());
            }}
          />
          Read only (Host permission)
        </label>
        <label>
          <input
            type="checkbox"
            checked={pendingInput}
            onChange={(e) => setPendingInput(e.target.checked)}
          />
          Hold unconfirmed input
        </label>
      </header>
      <section aria-label="Save" className="host-api-save">
        <button
          onClick={() => run(() => host.save({ commitVersion: true, author: 'fixture-person' }))}
          disabled={saving}
        >
          Save version
        </button>
        <label>
          <input
            type="checkbox"
            checked={storage.failNext}
            onChange={(e) => {
              storage.failNext = e.target.checked;
              refresh();
            }}
          />
          Fail next save
        </label>
        <label>
          <input
            type="checkbox"
            checked={storage.holdNext}
            onChange={(e) => {
              storage.holdNext = e.target.checked;
              refresh();
            }}
          />
          Hold next save
        </label>
        <button disabled={!storage.holding} onClick={() => storage.finish()}>
          Finish held save
        </button>
        <output aria-label="Draft state">
          {saving ? 'Saving' : dirty ? 'Unsaved changes' : 'Saved'}
        </output>
        <output aria-label="Saved events">{saved.length}</output>
        <output aria-label="Last saved event">
          {lastSaved
            ? JSON.stringify({
                artifactId: lastSaved.artifactId,
                versionId: lastSaved.versionId,
                committed: lastSaved.committed,
                revision: lastSaved.revision.sequence,
                currentRevision: lastSaved.currentRevision.sequence,
                dirty: lastSaved.dirty,
              })
            : 'none'}
        </output>
      </section>
      {error && <p role="alert">{error}</p>}
      <section
        aria-label="Editor"
        className="host-api-editor"
        onCompositionStartCapture={() => {
          composing.current = true;
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
        }}
      >
        <EditorInputsContext.Provider value={inputs}>
          <EditorExportGuardContext.Provider value={() => host.flushInputs()}>
            <EditorHistoryContext.Provider value={history}>
              {isDocument(content) ? (
                <DocumentSurface
                  content={content}
                  readOnly={readOnly}
                  execute={(cmd) => execute(cmd as EditorCommand<Content>)}
                  select={select}
                />
              ) : isStructuredData(content) ? (
                <DataSurface
                  content={content}
                  readOnly={readOnly}
                  execute={(cmd) => execute(cmd as EditorCommand<Content>)}
                  select={select}
                />
              ) : null}
            </EditorHistoryContext.Provider>
          </EditorExportGuardContext.Provider>
        </EditorInputsContext.Provider>
      </section>
      <section aria-label="External tool" className="host-api-tool">
        <h2>External tool (headless API)</h2>
        <output aria-label="Draft text">{textOf()}</output>
        {kind === 'document' && (
          <>
            <label>
              Find
              <textarea value={find} onChange={(e) => setFind(e.target.value)} />
            </label>
            <label>
              Replace with
              <textarea value={replace} onChange={(e) => setReplace(e.target.value)} />
            </label>
          </>
        )}
        <button onClick={proposeFromTool}>Propose from saved version</button>
      </section>
      <section aria-label="Proposal review" className="host-api-review">
        <h2>Proposal review</h2>
        {host.proposals.map((review) => (
          <article key={review.id} aria-label={'Proposal ' + review.summary}>
            <p>
              {review.summary}
              {review.stale ? ' (stale: the draft changed)' : ''}
            </p>
            <pre aria-label="Proposal preview">{preview(review)}</pre>
            <button onClick={() => run(() => host.acceptProposal(review.id))}>Accept</button>
            <button onClick={() => run(() => host.rejectProposal(review.id))}>Reject</button>
            <button onClick={() => run(() => host.acceptProposal(review.id))}>Accept by API</button>
          </article>
        ))}
        <ol aria-label="Proposal results">
          {results.map((r, i) => (
            <li key={i}>{`${r.outcome}${r.dirty ? ' (unsaved)' : ''}`}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}

async function start() {
  const root = createRoot(document.getElementById('root')!);
  let render = () => {};
  const permission = { edit: true };
  const storages = {
    document: new FixtureStorage<DocumentContent>(() => render()),
    data: new FixtureStorage<StructuredData>(() => render()),
  };
  const editors: Editors = {
    document: new ArtifactEditor(
      await open(
        'host-api-document',
        'Launch plan',
        documentSeed,
        documentAdapter,
        storages.document,
      ),
      documentAdapter,
      storages.document,
      () => permission.edit,
    ),
    data: new ArtifactEditor(
      await open('host-api-data', 'Records', dataSeed, dataAdapter, storages.data),
      dataAdapter,
      storages.data,
      () => permission.edit,
    ),
  };
  render = () =>
    root.render(<Fixture editors={editors} storages={storages} permission={permission} />);
  render();
}
void start();
