import { EpubReview } from './epub-review';
import { OfficeExportHost } from '@editor-platform/office-export-ui/host';
import { DocumentDocxDialog } from '@editor-platform/office-export-ui/document';
import { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createArtifact,
  commitVersion,
  newId,
  type Artifact,
} from '@editor-platform/artifact-core';
import {
  EditorInputs,
  type EditorCommand,
  type ElementAddress,
  type Region,
} from '@editor-platform/editor-core';
import {
  EditorInputsContext,
  EditorExportGuardContext,
  EditorHistoryContext,
} from '@editor-platform/editor-ui';
import {
  ArtifactEditor,
  EditorHostError,
  loadHostArtifact,
  type EditorHostAdapter,
} from '@editor-platform/editor-host';
import { DocumentSurface, documentProposalDiff } from '@editor-platform/document';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import {
  documentTextAccess,
  documentText,
  documentTextEditCommand,
  findDocumentText,
} from '@editor-platform/document/text';
import { composeDocumentSequence } from '@editor-platform/document/sequence';
import { DesignSurface } from '@editor-platform/design';
import { isDesignWithPaths, type DesignContent } from '@editor-platform/design/model';
import { captureDesignPages, designPageEditCommand } from '@editor-platform/design/pagination';
import { designPageProposalDiff } from '@editor-platform/design/page-proposal-diff';
import { exportPages, downloadBlob } from '@editor-platform/canvas-ui';
import { chapterSeed, comicSeed } from './authoring-fixtures';
import './authoring.css';

// Independent reference Host. All native content/history/input belongs to public Editor APIs.
const prefix = 'authoring:';
const capabilities = {
  undo: true,
  nativeJson: true,
  formats: [],
  preview: 'none',
  shared: false,
  proposals: true,
} as const;
const docAdapter: EditorHostAdapter<DocumentContent> = {
  kind: 'document',
  validate: isDocument,
  text: documentTextAccess,
  capabilities,
};
const designAdapter: EditorHostAdapter<DesignContent> = {
  kind: 'design',
  validate: isDesignWithPaths,
  capabilities,
};
type Content = DocumentContent | DesignContent;
interface FixtureState {
  chapters: ArtifactEditor<DocumentContent>[];
  design: ArtifactEditor<DesignContent>;
  permission: { edit: boolean };
  storage: { fail: boolean };
}
const jsonDownload = (name: string, value: unknown) =>
  downloadBlob(name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));

function App({ chapters, design, permission, storage }: FixtureState) {
  const [, refresh] = useReducer((n) => n + 1, 0);
  const [active, setActive] = useState(0);
  const [order, setOrder] = useState<number[]>(() => {
    const raw = localStorage.getItem(prefix + 'chapter-order');
    const value = raw ? JSON.parse(raw) : [0, 1, 2];
    return Array.isArray(value) && [...value].sort().join(',') === '0,1,2' ? value : [0, 1, 2];
  });
  const [error, setError] = useState('');
  const [docx, setDocx] = useState(false);
  const [inputs] = useState(() => new EditorInputs());
  const composing = useRef(false);
  const [heldInput, setHeldInput] = useState(false);
  const held = useRef(false);
  held.current = heldInput;
  const [focus, setFocus] = useState<ElementAddress>();
  const [find, setFind] = useState('夜');
  const [replace, setReplace] = useState('夕暮れ');
  const [derived, setDerived] = useState<Awaited<ReturnType<typeof composeDocumentSequence>>>();
  const [capture, setCapture] = useState<Awaited<ReturnType<typeof captureDesignPages>>>();
  const host = (active === 3 ? design : chapters[active]) as ArtifactEditor<Content>;
  useEffect(() => {
    const release = [
      host.attach(refresh),
      host.registerInputBoundary(() => {
        if (held.current || composing.current)
          throw new EditorHostError(
            'input-pending',
            host.id,
            'Confirm or cancel composition first',
          );
        inputs.flush();
      }),
    ];
    return () => release.forEach((f) => f());
  }, [host, inputs]);
  const run = (fn: () => unknown) => {
    try {
      const result = fn();
      if (result instanceof Promise)
        result.then(
          () => {
            setError('');
            refresh();
          },
          (e) => setError(String(e)),
        );
      else setError('');
    } catch (e) {
      setError(String(e));
    }
    refresh();
  };
  const snapshot = host.snapshot;
  const execute = (cmd: EditorCommand<Content>) => run(() => host.execute(cmd));
  function select(ids: string[], region?: Region) {
    host.select({
      addresses: ids.map((elementId) => ({
        artifactId: host.id,
        elementId,
        ...(region ? { region } : {}),
      })),
    });
  }
  function propose() {
    host.flushInputs();
    if (active === 3)
      design.propose({
        id: newId('proposal'),
        summary: 'Revise dialogue',
        baseLocalRevision: design.revision,
        commands: [designPageEditCommand([{ type: 'text', id: 'dialogue-1-1', value: replace }])],
      });
    else {
      const doc = chapters[active];
      doc.propose({
        id: newId('proposal'),
        summary: 'Revise selected scene',
        baseLocalRevision: doc.revision,
        commands: [
          documentTextEditCommand(doc.content, [
            { ...findDocumentText(doc.content, find), text: replace },
          ]),
        ],
      });
    }
  }
  async function capturePages(mode: 'm0' | 'vector' = 'm0') {
    design.flushInputs();
    const artifact = design.artifact;
    const result = await captureDesignPages(artifact, artifact.draft.baseVersionId!, { mode });
    setCapture(result);
    if (!result.ok) throw Error(result.manifest.diagnostics.map((d) => d.message).join('\n'));
  }
  return (
    <main className="authoring-host">
      <h1>Document / Design authoring</h1>
      <nav aria-label="Artifacts">
        {[...order, 3].map((id) => (
          <button
            key={id}
            aria-pressed={active === id}
            onClick={() =>
              run(() => {
                host.flushInputs();
                setFocus(undefined);
                setActive(id);
              })
            }
          >
            {id === 3 ? 'Comic pages' : `Chapter ${id + 1}`}
          </button>
        ))}
      </nav>
      <section aria-label="Host controls" className="authoring-controls">
        <button onClick={() => run(() => host.save({ commitVersion: true }))}>Save version</button>
        <button onClick={() => run(() => host.undo())} disabled={!host.canUndo}>
          Undo
        </button>
        <button onClick={() => run(() => host.redo())} disabled={!host.canRedo}>
          Redo
        </button>
        <label>
          <input
            type="checkbox"
            checked={!permission.edit}
            onChange={(e) => {
              permission.edit = !e.target.checked;
              host.refreshPermission();
            }}
          />
          Read only
        </label>
        <label>
          <input
            type="checkbox"
            checked={storage.fail}
            onChange={(e) => {
              storage.fail = e.target.checked;
              refresh();
            }}
          />
          Fail next save
        </label>
        <label>
          <input
            type="checkbox"
            checked={heldInput}
            onChange={(e) => setHeldInput(e.target.checked)}
          />
          Hold composition
        </label>
        <output aria-label="Save state">
          {snapshot.saving ? 'Saving' : snapshot.dirty ? 'Unsaved changes' : 'Saved'}
        </output>
        <output aria-label="Version count">{host.artifact.versions.length}</output>
      </section>
      {error && <p role="alert">{error}</p>}
      {active !== 3 && (
        <section aria-label="Chapter order">
          <button
            onClick={() =>
              run(() => {
                host.flushInputs();
                const next = [...order].reverse();
                localStorage.setItem(prefix + 'chapter-order', JSON.stringify(next));
                setOrder(next);
              })
            }
          >
            Reverse chapter order
          </button>
          {['scene-morning', 'scene-night'].map((elementId) => (
            <button
              key={elementId}
              onClick={() =>
                run(() => {
                  host.flushInputs();
                  const address = { artifactId: host.id, elementId };
                  host.select({ addresses: [address] });
                  setFocus(address);
                })
              }
            >
              Go to {elementId}
            </button>
          ))}
          <button
            onClick={() =>
              run(async () => {
                chapters.forEach((c) => c.flushInputs());
                setDerived(
                  await composeDocumentSequence(
                    order.map((i) => ({
                      artifact: chapters[i].artifact,
                      versionId: chapters[i].artifact.draft.baseVersionId!,
                    })),
                  ),
                );
              })
            }
          >
            Compose saved chapters
          </button>
        </section>
      )}
      <div
        className="authoring-editor"
        onCompositionStartCapture={() => {
          composing.current = true;
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
        }}
      >
        <EditorInputsContext.Provider value={inputs}>
          <EditorExportGuardContext.Provider value={() => host.flushInputs()}>
            <EditorHistoryContext.Provider
              value={{
                undo: () => run(() => host.undo()),
                redo: () => run(() => host.redo()),
              }}
            >
              {active === 3 ? (
                <DesignSurface
                  content={design.content}
                  readOnly={host.readOnly}
                  execute={(cmd) => execute(cmd as EditorCommand<Content>)}
                  select={select}
                />
              ) : (
                <DocumentSurface
                  content={chapters[active].content}
                  readOnly={host.readOnly}
                  execute={(cmd) => execute(cmd as EditorCommand<Content>)}
                  select={(id, region) => select([id], region)}
                  focusAddress={focus}
                />
              )}
            </EditorHistoryContext.Provider>
          </EditorExportGuardContext.Provider>
        </EditorInputsContext.Provider>
      </div>
      <section aria-label="Scene review">
        <h2>Scene review</h2>
        {active !== 3 && (
          <label>
            Find <input value={find} onChange={(e) => setFind(e.target.value)} />
          </label>
        )}
        <label>
          Replacement <input value={replace} onChange={(e) => setReplace(e.target.value)} />
        </label>
        <button onClick={() => run(propose)}>Preview proposal</button>
        <output aria-label="Current text">
          {active === 3
            ? design.content.elements
                .filter((e) => e.type === 'text')
                .map((e) => e.text)
                .join('\n')
            : documentText(chapters[active].content).text}
        </output>
        {host.proposals.map((p) => {
          const diff =
            active === 3
              ? designPageProposalDiff.diff(
                  p.preview.baseContent as DesignContent,
                  p.preview.content as DesignContent,
                )
              : documentProposalDiff.diff(
                  p.preview.baseContent as DocumentContent,
                  p.preview.content as DocumentContent,
                );
          return (
            <article aria-label="Semantic proposal" key={p.id}>
              <pre>{JSON.stringify(diff, null, 2)}</pre>
              <span>{p.stale ? 'Stale' : 'Ready'}</span>
              <button
                onClick={() =>
                  run(() => {
                    if (diff.fallback.length) throw Error('Unsupported proposal subset');
                    host.acceptProposal(p.id);
                  })
                }
              >
                Accept
              </button>
              <button onClick={() => run(() => host.rejectProposal(p.id))}>Reject</button>
            </article>
          );
        })}
      </section>
      {active === 3 && (
        <section aria-label="Page output">
          <button onClick={() => run(() => capturePages())}>Read saved pages</button>
          <button onClick={() => run(() => capturePages('vector'))}>Read saved vector pages</button>
          {capture && (
            <>
              <p>Saved version preview. Save again and recapture to include draft changes.</p>
              <pre aria-label="Page manifest">{JSON.stringify(capture.manifest, null, 2)}</pre>
              {(['png', 'pdf'] as const).map((format) => (
                <button
                  key={format}
                  disabled={!capture.ok}
                  onClick={() =>
                    run(() =>
                      exportPages(
                        [...capture.pages],
                        format,
                        1,
                        'comic',
                        JSON.stringify(capture.manifest),
                      ),
                    )
                  }
                >
                  Export {format.toUpperCase()}
                </button>
              ))}
              <div className="authoring-pages">
                {capture.pages.map((p) => (
                  <figure key={p.frameId}>
                    <img
                      alt={p.frameId}
                      src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(p.svg)}
                    />
                    <figcaption>{p.frameId}</figcaption>
                  </figure>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {derived && (
        <section aria-label="Derived chapter output">
          <h2>Saved chapter sequence</h2>
          <button onClick={() => jsonDownload('chapters-manifest.json', derived.manifest)}>
            Download chapter manifest
          </button>
          <pre aria-label="Chapter manifest">{JSON.stringify(derived.manifest, null, 2)}</pre>
          <EpubReview
            sourcesKey={JSON.stringify(
              order.map((i) => [chapters[i].id, chapters[i].artifact.draft.baseVersionId]),
            )}
            guardInputs={() => {
              host.flushInputs();
              chapters.forEach((c) => c.flushInputs());
            }}
            readSources={() =>
              order.map((i) => ({
                artifact: chapters[i].artifact,
                versionId: chapters[i].artifact.draft.baseVersionId!,
              }))
            }
          />
          {derived.content && (
            <OfficeExportHost
              formats={{ docx: true, pptx: false }}
              capture={() => ({
                content: derived.content,
                basis: { kind: 'local-draft', artifactId: 'derived-chapters' },
                name: 'chapters',
              })}
            >
              <button onClick={() => setDocx(true)}>Export chapter DOCX</button>
              <p>Keep the chapter manifest alongside the DOCX and its export report.</p>
              {docx && (
                <DocumentDocxDialog
                  content={derived.content}
                  onNavigate={() => {}}
                  onClose={() => setDocx(false)}
                />
              )}
              <DocumentSurface
                content={derived.content}
                readOnly
                execute={() => {
                  throw Error('Derived output is read only');
                }}
                select={() => {}}
              />
            </OfficeExportHost>
          )}
        </section>
      )}
      <output aria-label="Selection">{JSON.stringify(snapshot.selection)}</output>
    </main>
  );
}
async function start() {
  const permission = { edit: true };
  const storage = { fail: false };
  async function open<T>(id: string, seed: T, adapter: EditorHostAdapter<T>) {
    const raw = localStorage.getItem(prefix + id);
    let artifact: Artifact<T>;
    if (raw) artifact = await loadHostArtifact(raw, adapter);
    else {
      const created = createArtifact(adapter.kind, id, seed);
      artifact = await commitVersion({ ...created, id }, null, 'Fixture initial version');
      localStorage.setItem(prefix + id, JSON.stringify(artifact));
    }
    return new ArtifactEditor(
      artifact,
      adapter,
      {
        put: async (value) => {
          if (storage.fail) {
            storage.fail = false;
            throw Error('Fixture save failed');
          }
          localStorage.setItem(prefix + id, JSON.stringify(value));
        },
      },
      () => permission.edit,
    );
  }
  const chapters = await Promise.all(
    [1, 2, 3].map((n) => open(`chapter-${n}`, chapterSeed(n), docAdapter)),
  );
  const design = await open('comic', comicSeed(), designAdapter);
  createRoot(document.getElementById('root')!).render(
    <App chapters={chapters} design={design} permission={permission} storage={storage} />,
  );
}
void start().catch((e) => {
  document.getElementById('root')!.textContent = String(e);
});
