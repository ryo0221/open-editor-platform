import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  exportReactUiFromRuntime,
  inspectReactUiDocument,
  reactComponentKey,
  reactUiCommand,
  reactUiParent,
  validateReactPreviewEndpoint,
  validateReactPreviewResponse,
  validateReactPreviewBootstrap,
  type ReactUiDocument,
  type ReactRuntimeAdapter,
  type ReactPreviewRequest,
  type ReactUiDiagnostic,
  type ReactScreenProposal,
  createReactScreenProposal,
  serializeReactScreenProposal,
} from '@editor-platform/react-ui-core';
import { zipSync, strToU8 } from 'fflate';
import { reuseHash } from '@editor-platform/reuse-core';
import './styles.css';
import { ReactUiTree } from './tree';
import { ReactUiInspector } from './inspector';
import { ReactUiPageInputs } from './page-inputs';
import { ReactUiRevisionReview } from './revision';
import type { ReactUiRevisionCandidate } from '@editor-platform/react-ui-core';
import { immutableCommand } from '@editor-platform/editor-core';
import { parseReactUiDocument, serializeReactUiDocument } from '@editor-platform/react-ui-core';
const MemoTree = memo(ReactUiTree);
const MemoInspector = memo(ReactUiInspector);
const MemoPageInputs = memo(ReactUiPageInputs);
export interface ReactUiSurfaceProps {
  content: ReactUiDocument;
  readOnly: boolean;
  execute(command: EditorCommand<ReactUiDocument>): boolean | void;
  select(id: string): void;
  selectedId?: string;
  runtime: ReactRuntimeAdapter;
  examples?: { name: string; document: ReactUiDocument }[];
  revisions?: Omit<ReactUiRevisionCandidate, 'nodeIds'>[];
  beforeExport?(): void;
  screenReferences?: ReactScreenProposal['externalReferences'];
}
export function ReactUiSurface({
  content: sourceContent,
  readOnly,
  execute,
  select,
  selectedId,
  runtime,
  examples = [],
  revisions = [],
  beforeExport,
  screenReferences = [],
}: ReactUiSurfaceProps) {
  // React content updates publish a new snapshot. Keep one admitted immutable
  // snapshot for its render/preview request, including caller-owned Undo copies.
  const inspection = useMemo(() => inspectReactUiDocument(sourceContent), [sourceContent]);
  const content = inspection.document ?? sourceContent;
  const [mode, setMode] = useState<'edit' | 'interact'>('edit');
  const [width, setWidth] = useState(390);
  const [restart, setRestart] = useState(0);
  const [diagnostics, setDiagnostics] = useState<ReactUiDiagnostic[]>([]);
  const [readyRequestId, setReadyRequestId] = useState('');
  const [status, setStatus] = useState('Loading preview');
  const [revisionReview, setRevisionReview] = useState<ReactUiRevisionCandidate>();
  const [inputFocus, setInputFocus] = useState<{ name: string; request: number }>();
  const focusInput = useCallback((name: string) => {
    setInputFocus((previous) => ({ name, request: (previous?.request ?? 0) + 1 }));
  }, []);
  const iframe = useRef<HTMLIFrameElement>(null);
  const loadedFrame = useRef<HTMLIFrameElement | null>(null);
  const resolvedRequest = useRef('');
  const sessionId = useRef(crypto.randomUUID());
  const revision = useRef(0);
  const request = useMemo<Extract<ReactPreviewRequest, { type: 'render' }>>(
    () => ({
      protocol: 1,
      sessionId: sessionId.current,
      requestId: crypto.randomUUID(),
      revision: ++revision.current,
      type: 'render',
      document: content,
      mode,
      viewport: { width, height: 700 },
    }),
    [content, mode, width, restart],
  );
  const endpointResult = useMemo(() => {
    try {
      return {
        endpoint: validateReactPreviewEndpoint(
          location.origin,
          runtime.previewEndpoint(content.environment.ref),
          content.environment.ref,
        ),
      };
    } catch (error) {
      return { error: String(error) };
    }
  }, [runtime, content.environment.ref]);
  const endpoint = endpointResult.endpoint;
  const post = () => {
    if (
      endpoint &&
      loadedFrame.current === iframe.current &&
      resolvedRequest.current === request.requestId
    )
      iframe.current?.contentWindow?.postMessage(
        runtime.serializePreview?.(request) ?? request,
        endpoint.origin,
      );
  };
  useEffect(() => {
    if (!endpoint) return;
    const controller = new AbortController();
    resolvedRequest.current = '';
    setStatus('Loading preview');
    setDiagnostics([]);
    runtime
      .resolve({
        environment: content.environment.ref,
        components: content.components.map((c) => c.ref),
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.diagnostics.length || !result.resolution) {
          setDiagnostics(result.diagnostics);
          setStatus('Runtime unavailable');
        } else {
          resolvedRequest.current = request.requestId;
          post();
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatus(String(error));
      });
    return () => controller.abort();
  }, [request, endpoint, runtime, content]);
  useLayoutEffect(() => {
    if (!endpoint) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== endpoint.origin)
        return;
      try {
        if (event.data?.type === 'host-ready') {
          validateReactPreviewBootstrap(
            event,
            { source: iframe.current!.contentWindow!, origin: endpoint.origin },
            'host-ready',
          );
          loadedFrame.current = iframe.current;
          post();
          return;
        }
        const response = validateReactPreviewResponse(event, {
          source: iframe.current.contentWindow!,
          origin: endpoint.origin,
          sessionId: request.sessionId,
          requestId: request.requestId,
          revision: request.revision,
          mode,
          document: content,
        });
        if (response.type === 'ready') {
          setReadyRequestId(request.requestId);
          setStatus('Preview ready');
        }
        if (response.type === 'error') {
          setDiagnostics(response.diagnostics);
          setStatus('Preview failed');
        }
        if (response.type === 'selection') select(response.nodeId);
        if (response.type === 'callback')
          setStatus(`Callback ${response.event}: ${response.arguments.join(',') || 'called'}`);
      } catch {
        /* Foreign/stale messages never change the draft or current preview. */
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [request, endpoint, mode, content, select]);
  const node = content.nodes.find((n) => n.id === selectedId);
  const registered =
    node &&
    content.components.find((c) => reactComponentKey(c.ref) === reactComponentKey(node.component));
  const parent = node ? reactUiParent(content, node.id) : null;
  const siblings = parent
    ? content.nodes.find((n) => n.id === parent.nodeId)!.slots[parent.slotId]
    : content.roots;
  const position = node ? siblings.indexOf(node.id) : -1;
  const errors = [...inspection.diagnostics, ...diagnostics];
  async function download() {
    try {
      beforeExport?.();
      const bundle = await exportReactUiFromRuntime(content, runtime, new AbortController().signal);
      const implementations = await runtime.exportImplementations?.({
        components: content.components.map((c) => c.ref),
        signal: new AbortController().signal,
      });
      if (implementations?.diagnostics.length)
        throw new Error(implementations.diagnostics.map((d) => d.message).join('; '));
      const material = await runtime.exportDependencies?.({
        environment: content.environment.ref,
        signal: new AbortController().signal,
      });
      if (material?.diagnostics.length)
        throw new Error(material.diagnostics.map((d) => d.message).join('; '));
      const files: Record<string, Uint8Array> = Object.fromEntries(
        Object.entries(bundle.files).map(([name, value]) => [name, strToU8(value)]),
      );
      for (const implementation of implementations?.files ?? []) {
        if (
          !/^[A-Za-z][A-Za-z0-9_-]*\.(tsx|css)$/.test(implementation.path) ||
          files[implementation.path] ||
          reuseHash(implementation.text) !== implementation.hash
        )
          throw new Error('Generated implementation path collision');
        files[implementation.path] = strToU8(implementation.text);
      }
      for (const dependency of content.environment.dependencies.filter(
        (d) => d.kind === 'css' || d.kind === 'asset',
      )) {
        const supplied = material?.files.find((f) => f.dependencyId === dependency.id);
        if (
          !('path' in dependency) ||
          !supplied ||
          supplied.path !== dependency.path ||
          supplied.hash !== dependency.hash ||
          files[supplied.path]
        )
          throw new Error('Pinned CSS/asset bytes unavailable');
        files[supplied.path] = supplied.bytes;
      }
      const blob = new Blob([zipSync(files)], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'react-screen.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setStatus(`Export blocked: ${String(error)}`);
    }
  }
  return (
    <div className="react-ui-surface">
      {revisionReview && (
        <ReactUiRevisionReview
          document={content}
          candidate={revisionReview}
          readOnly={readOnly}
          execute={execute}
          close={() => setRevisionReview(undefined)}
        />
      )}
      <div className="react-ui-toolbar">
        <button aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
          Edit composition
        </button>
        <button aria-pressed={mode === 'interact'} onClick={() => setMode('interact')}>
          Interact
        </button>
        <label>
          Preview width
          <select
            aria-label="Preview width"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          >
            {[390, 1024, 1400].map((w) => (
              <option key={w} value={w}>
                {w}px
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setRestart((n) => n + 1)}>Restart preview</button>
        <button onClick={() => void download()}>Export React TSX</button>
      </div>
      <div className="react-ui-toolbar">
        {examples.map((example) => (
          <button
            key={example.name}
            disabled={readOnly}
            onClick={() =>
              execute(
                immutableCommand(
                  'react-ui.example',
                  `Load ${example.name}`,
                  () => example.document,
                ),
              )
            }
          >
            Load example {example.name}
          </button>
        ))}
        <button
          onClick={() => {
            try {
              beforeExport?.();
              const blob = new Blob([serializeReactUiDocument(content)], {
                type: 'application/json',
              });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'composition.json';
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) {
              setStatus(`Export blocked: ${String(error)}`);
            }
          }}
        >
          Export composition JSON
        </button>
        <button
          disabled={!screenReferences.length}
          onClick={() => {
            try {
              beforeExport?.();
              const proposal = createReactScreenProposal(content, screenReferences);
              const url = URL.createObjectURL(
                new Blob([serializeReactScreenProposal(proposal)], { type: 'application/json' }),
              );
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'screen-proposal.json';
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) {
              setStatus(`Proposal export blocked: ${String(error)}`);
            }
          }}
        >
          Export screen proposal JSON
        </button>
        <label>
          Import composition
          <input
            aria-label="Import composition JSON"
            type="file"
            accept=".json"
            disabled={readOnly}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file)
                void file
                  .text()
                  .then((text) => {
                    const parsed = parseReactUiDocument(text);
                    execute(
                      immutableCommand(
                        'react-ui.import',
                        'Import native composition',
                        () => parsed,
                      ),
                    );
                  })
                  .catch((error) => setStatus(`Import blocked: ${String(error)}`));
            }}
          />
        </label>
      </div>
      <MemoPageInputs
        document={content}
        readOnly={readOnly}
        execute={execute}
        focusInput={inputFocus}
      />
      <p role="status">{status}</p>
      {endpointResult.error && <p role="alert">{endpointResult.error}</p>}
      {errors.map((error, i) => (
        <p role="alert" key={i}>
          {error.code}: {error.message} {error.recovery}
        </p>
      ))}
      <div className="react-ui-columns">
        <aside aria-label="Component tree">
          <MemoTree
            document={content}
            selectedId={selectedId}
            select={select}
            readOnly={readOnly}
            execute={execute}
          />
        </aside>
        <div className="react-ui-preview-scroll">
          {endpoint && (
            <iframe
              key={`${restart}:${endpoint.url}`}
              ref={iframe}
              title="React component preview"
              sandbox="allow-scripts allow-same-origin"
              src={endpoint.url}
              width={width}
              height={700}
              style={{ pointerEvents: readyRequestId === request.requestId ? 'auto' : 'none' }}
              aria-busy={readyRequestId !== request.requestId}
              onLoad={() => {
                // Initial about:blank inherits Editor's origin. Firefox/WebKit
                // report a cross-origin post before navigation as a browser error.
                try {
                  if (iframe.current?.contentWindow?.location.href === 'about:blank') return;
                  if (iframe.current?.contentWindow?.location.origin === location.origin) return;
                } catch {
                  /* Reading the loaded separate origin is intentionally denied. */
                }
                iframe.current?.contentWindow?.postMessage(
                  { protocol: 1, type: 'host-ready-request' },
                  endpoint.origin,
                );
              }}
            />
          )}
        </div>
        <aside aria-label="Component Inspector">
          {node && registered ? (
            <>
              <h3>{registered.name}</h3>
              <small>Pinned {node.component.version}</small>
              {revisions
                .filter(
                  (candidate) =>
                    (!candidate.component &&
                      candidate.environment?.ref.hash !== content.environment.ref.hash) ||
                    (candidate.component &&
                      candidate.component.ref.registryId === node.component.registryId &&
                      candidate.component.ref.componentId === node.component.componentId &&
                      candidate.component.ref.version !== node.component.version),
                )
                .map((candidate, i) => (
                  <button
                    key={i}
                    disabled={readOnly}
                    onClick={() =>
                      setRevisionReview({
                        ...candidate,
                        nodeIds: candidate.component ? [node.id] : [],
                      })
                    }
                  >
                    Review {candidate.component ? 'component' : 'environment'} revision
                  </button>
                ))}
              <button
                disabled={readOnly || position <= 0}
                onClick={() =>
                  node &&
                  execute(
                    reactUiCommand(
                      [{ type: 'move', nodeId: node.id, parent, beforeId: siblings[position - 1] }],
                      'Move component up',
                    ),
                  )
                }
              >
                Move up
              </button>
              <button
                disabled={readOnly || position < 0 || position >= siblings.length - 1}
                onClick={() =>
                  node &&
                  execute(
                    reactUiCommand(
                      [
                        {
                          type: 'move',
                          nodeId: node.id,
                          parent,
                          beforeId: siblings[position + 2] ?? null,
                        },
                      ],
                      'Move component down',
                    ),
                  )
                }
              >
                Move down
              </button>
              <MemoInspector
                document={content}
                node={node}
                registered={registered}
                readOnly={readOnly}
                execute={execute}
                onEditInput={focusInput}
              />
            </>
          ) : (
            <p>Select a component</p>
          )}
        </aside>
      </div>
    </div>
  );
}
