import { useContext, useEffect, useRef, useState } from 'react';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import { EditorExportGuardContext, IconButton } from '@editor-platform/editor-ui';
import { isDocument, type DocumentContent } from '@editor-platform/document/model';
import type { ReadonlyTree, DocumentExportAddress } from '@editor-platform/export-core';
import type { DocumentDocxOptions, DocumentDocxReport } from '@editor-platform/document-export';
import { OfficeExportContext } from './host';
import { DocxExportJob } from './docx-job';
import './styles.css';

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function DocumentDocxDialog({
  content,
  onNavigate,
  onClose,
}: {
  content: DocumentContent;
  onNavigate(address: DocumentExportAddress): void;
  onClose(): void;
}) {
  const host = useContext(OfficeExportContext),
    guard = useContext(EditorExportGuardContext);
  const [job] = useState(() => new DocxExportJob());
  const [minimized, setMinimized] = useState(false);
  const [options, setOptions] = useState<DocumentDocxOptions>({
    fontProfileId: 'noto-cjk-jp-2.004',
    styleProfileId: 'document-ja-1',
    mermaid: 'reject',
    previewBlocks: 'reject',
  });
  const [report, setReport] = useState<ReadonlyTree<DocumentDocxReport>>();
  const [phase, setPhase] = useState<'options' | 'preparing' | 'ready' | 'encoding' | 'downloaded'>(
    'options',
  );
  const [accepted, setAccepted] = useState(false),
    [error, setError] = useState('');
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const capture = useRef<{ source: DocumentContent; name: string } | undefined>(undefined);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      job.cancel();
    },
    [job],
  );
  const busy = phase === 'preparing' || phase === 'encoding';
  function invalidate() {
    generation.current++;
    job.cancel();
    setReport(undefined);
    setAccepted(false);
    setPhase('options');
    setError('');
    setDiagnosticPage(0);
  }
  function change(patch: Partial<DocumentDocxOptions>) {
    invalidate();
    setOptions({ ...options, ...patch });
  }
  function cancel() {
    invalidate();
    setError('Export cancelled. No file was downloaded.');
  }
  function source() {
    guard?.();
    const value = host?.capture() ?? {
      content,
      basis: { kind: 'local-draft' as const, artifactId: 'standalone-document' },
      name: 'document',
    };
    if (!isDocument(value.content))
      throw Error('The active artifact is no longer a Document. Reopen its export menu.');
    return { ...value, content: value.content };
  }
  async function prepare() {
    const attempt = ++generation.current;
    setError('');
    setAccepted(false);
    setReport(undefined);
    setDiagnosticPage(0);
    try {
      const current = source();
      // Capture/clone in postMessage happens before any await, including font/asset loading.
      const pending = job.prepare(
        current.content,
        current.basis,
        options,
        new URL(host?.fontManifestUrl ?? '/office-fonts/manifest.json', location.href).href,
        new URL(host?.codeFontManifestUrl ?? '/office-fonts/mono-manifest.json', location.href)
          .href,
        new URL(host?.mermaidFrameUrl ?? '/office-mermaid.html', location.href).href,
      );
      capture.current = { source: content, name: current.name };
      setPhase('preparing');
      const result = await pending;
      if (attempt !== generation.current) return;
      if (result.status === 'prepared') {
        setReport(result.report);
        setPhase('ready');
      } else setPhase('options');
    } catch (e) {
      if (attempt !== generation.current) return;
      setError(e instanceof Error ? e.message : 'Could not prepare the export');
      setPhase('options');
    }
  }
  async function encode() {
    if (!report || busy) return;
    const attempt = ++generation.current;
    setError('');
    try {
      source(); // Recheck current Host/IME guards without replacing the captured plan.
      setPhase('encoding');
      const response = await job.encode({
        planHash: report.planHash,
        acceptedDiagnosticIds: accepted
          ? report.diagnostics.filter((d) => d.requiresAcceptance).map((d) => d.id)
          : [],
      });
      if (attempt !== generation.current) return;
      if (response.status !== 'encoded') {
        setPhase('ready');
        return;
      }
      const result = response.result;
      if (result.status === 'ok') {
        source();
        download(
          `${capture.current?.name ?? 'document'}.docx`,
          new Blob([new Uint8Array(result.bytes)], { type: result.mime }),
        );
        setReport(result.report);
        setPhase('downloaded');
      } else if (result.status === 'failed') throw Error(result.message);
      else {
        setPhase('ready');
        setError(
          result.status === 'blocked'
            ? 'Review the current report before exporting.'
            : 'Export cancelled.',
        );
      }
    } catch (e) {
      if (attempt !== generation.current) return;
      setError(e instanceof Error ? e.message : 'DOCX export failed');
      setPhase('ready');
    }
  }
  const warnings = report?.diagnostics.filter((d) => d.requiresAcceptance) ?? [];
  const errors = report?.diagnostics.filter((d) => d.severity === 'error') ?? [];
  const diagnostics = report?.diagnostics ?? [];
  const rows = diagnostics.slice(diagnosticPage * 20, (diagnosticPage + 1) * 20);
  const outdated = report && capture.current?.source !== content;
  return (
    <section
      role="dialog"
      aria-label="DOCX export"
      aria-modal="false"
      className="office-export-dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          job.cancel();
          onClose();
        }
      }}
    >
      <header>
        <h2>DOCX export</h2>
        <IconButton
          icon={minimized ? ChevronUp : ChevronDown}
          label={minimized ? 'Expand DOCX export' : 'Minimize DOCX export'}
          onClick={() => setMinimized(!minimized)}
        />
        <IconButton
          icon={X}
          label="Close DOCX export"
          onClick={() => {
            job.cancel();
            onClose();
          }}
        />
      </header>
      {minimized && (
        <p role="status">
          {busy ? 'Export is running. You can edit or cancel.' : 'DOCX preview is retained.'}
          {busy && <button onClick={cancel}>Cancel export</button>}
        </p>
      )}
      <div hidden={minimized}>
        <p>
          Editable paragraphs, headings, lists, merged tables and images. Office reflows the
          document; line breaks and page count can change.
        </p>
        <div className="office-export-options">
          <label>
            Font
            <select
              aria-label="DOCX font"
              disabled={busy}
              value={options.fontProfileId}
              onChange={(e) => change({ fontProfileId: e.target.value })}
            >
              <option value="noto-cjk-jp-2.004">Noto Sans CJK JP 2.004</option>
            </select>
          </label>
          <label>
            Document style
            <select
              aria-label="DOCX style"
              disabled={busy}
              value={options.styleProfileId}
              onChange={(e) =>
                change({ styleProfileId: e.target.value as DocumentDocxOptions['styleProfileId'] })
              }
            >
              <option value="document-ja-1">Japanese document 1</option>
            </select>
          </label>
          <small>
            The recipient needs the selected font and Noto Sans Mono CJK JP for code. Fonts are
            referenced, not embedded.
          </small>
          <label>
            Mermaid diagrams
            <select
              aria-label="DOCX Mermaid"
              disabled={busy}
              value={options.mermaid}
              onChange={(e) =>
                change({ mermaid: e.target.value as DocumentDocxOptions['mermaid'] })
              }
            >
              <option value="reject">Stop and review diagrams</option>
              <option value="image">Ask before using diagram pictures</option>
              <option value="source">Ask before using source text</option>
            </select>
          </label>
          <label>
            HTML / React previews
            <select
              aria-label="DOCX preview blocks"
              disabled={busy}
              value={options.previewBlocks}
              onChange={(e) =>
                change({ previewBlocks: e.target.value as DocumentDocxOptions['previewBlocks'] })
              }
            >
              <option value="reject">Stop and review previews</option>
              <option value="source">Ask before using source text</option>
            </select>
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <p role="status">
          {phase === 'preparing'
            ? 'Preparing DOCX preview… You can continue editing.'
            : phase === 'encoding'
              ? 'Creating DOCX… You can continue editing.'
              : phase === 'downloaded'
                ? 'DOCX downloaded.'
                : report
                  ? 'Preview ready.'
                  : 'Prepare a preview to see the changes.'}
        </p>
        {report && (
          <>
            <p aria-label="DOCX source">
              {report.basis.kind === 'confirmed'
                ? `Confirmed revision ${report.basis.revision}`
                : report.basis.kind === 'saved-version'
                  ? 'Saved version'
                  : 'Local draft'}{' '}
              · {report.blocks.length} blocks
            </p>
            {outdated && (
              <p role="status">
                The artifact changed after this preview. This export keeps the captured content.
                Refresh to include the latest edits.
              </p>
            )}
            <p aria-label="DOCX counts">
              Native: {report.counts.native} · Converted: {report.counts.converted} · Pictures:{' '}
              {report.counts.rasterized} · Errors: {errors.length}
            </p>
            <details open>
              <summary>Changes and warnings ({diagnostics.length})</summary>
              <ol className="office-export-diagnostics" start={diagnosticPage * 20 + 1}>
                {rows.map((d) => (
                  <li key={d.id}>
                    <strong>{d.severity}</strong>: {d.message}
                    {d.address?.blockId && (
                      <button
                        className="office-export-locate"
                        onClick={() => onNavigate(d.address!)}
                      >
                        Go to block{' '}
                        {content.blocks.findIndex((b) => b.id === d.address?.blockId) + 1}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {diagnostics.length > 20 && (
                <nav aria-label="DOCX diagnostic pages">
                  <button
                    disabled={!diagnosticPage}
                    onClick={() => setDiagnosticPage(diagnosticPage - 1)}
                  >
                    Previous warnings
                  </button>
                  <span>
                    {diagnosticPage + 1} / {Math.ceil(diagnostics.length / 20)}
                  </span>
                  <button
                    disabled={(diagnosticPage + 1) * 20 >= diagnostics.length}
                    onClick={() => setDiagnosticPage(diagnosticPage + 1)}
                  >
                    Next warnings
                  </button>
                </nav>
              )}
            </details>
            {warnings.length > 0 && (
              <label className="office-export-consent">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={accepted}
                  onChange={(e) => setAccepted(e.target.checked)}
                />{' '}
                I accept all {warnings.length} reported changes for this snapshot.
              </label>
            )}
            {!!errors.length && (
              <p>Resolve the errors and refresh the preview. Errors cannot be accepted.</p>
            )}
          </>
        )}
        <footer>
          {busy ? (
            <button key="cancel" onClick={cancel}>
              Cancel export
            </button>
          ) : (
            <button key="prepare" onClick={() => void prepare()}>
              {report ? 'Refresh DOCX preview' : 'Prepare DOCX preview'}
            </button>
          )}
          {report && (
            <button
              disabled={busy || !!errors.length || (!!warnings.length && !accepted)}
              onClick={() => void encode()}
            >
              Download DOCX
            </button>
          )}
          {report && (
            <button
              onClick={() =>
                download(
                  'docx-export-report.json',
                  new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
                )
              }
            >
              Download loss report
            </button>
          )}
        </footer>
      </div>
    </section>
  );
}
