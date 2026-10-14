import { useContext, useEffect, useRef, useState } from 'react';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import { EditorExportGuardContext, IconButton } from '@editor-platform/editor-ui';
import { isDeck, type SlideContent } from '@editor-platform/slide/model';
import type { ReadonlyTree, SlideExportAddress } from '@editor-platform/export-core';
import type { SlidePptxOptions, SlidePptxReport } from '@editor-platform/slide-export';
import { OfficeExportContext } from './host';
import { PptxExportJob } from './pptx-job';
import './styles.css';

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SlidePptxDialog({
  content,
  selectedPageIds,
  onNavigate,
  onClose,
}: {
  content: SlideContent;
  selectedPageIds: string[];
  onNavigate(address: SlideExportAddress): void;
  onClose(): void;
}) {
  const host = useContext(OfficeExportContext),
    guard = useContext(EditorExportGuardContext);
  const [job] = useState(() => new PptxExportJob());
  const [scope, setScope] = useState('all');
  const [minimized, setMinimized] = useState(false);
  const [options, setOptions] = useState<SlidePptxOptions>({
    pageIds: 'all',
    includeHiddenSlides: false,
    includeNotes: false,
    fontProfileId: 'noto-cjk-jp-2.004',
    fallback: 'element-png',
  });
  const [report, setReport] = useState<ReadonlyTree<SlidePptxReport>>();
  const [phase, setPhase] = useState<'options' | 'preparing' | 'ready' | 'encoding' | 'downloaded'>(
    'options',
  );
  const [accepted, setAccepted] = useState(false),
    [error, setError] = useState('');
  const [diagnosticPage, setDiagnosticPage] = useState(0);
  const capture = useRef<{ source: SlideContent; name: string } | undefined>(undefined);
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
  function change(patch: Partial<SlidePptxOptions>) {
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
      basis: { kind: 'local-draft' as const, artifactId: 'standalone-slide' },
      name: 'slide-deck',
    };
    if (!isDeck(value.content))
      throw Error('The active artifact is no longer a Slide. Reopen its export menu.');
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
        {
          ...options,
          pageIds: scope === 'all' ? 'all' : selectedPageIds,
        },
        new URL(host?.fontManifestUrl ?? '/office-fonts/manifest.json', location.href).href,
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
          `${capture.current?.name ?? 'slide-deck'}.pptx`,
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
      setError(e instanceof Error ? e.message : 'PPTX export failed');
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
      aria-label="PPTX export"
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
        <h2>PPTX export</h2>
        <IconButton
          icon={minimized ? ChevronUp : ChevronDown}
          label={minimized ? 'Expand PPTX export' : 'Minimize PPTX export'}
          onClick={() => setMinimized(!minimized)}
        />
        <IconButton
          icon={X}
          label="Close PPTX export"
          onClick={() => {
            job.cancel();
            onClose();
          }}
        />
      </header>
      {minimized && (
        <p role="status">
          {busy ? 'Export is running. You can edit or cancel.' : 'PPTX preview is retained.'}
          {busy && <button onClick={cancel}>Cancel export</button>}
        </p>
      )}
      <div hidden={minimized}>
        <p>
          Editable text, 13 shapes, images and simple tables. Other supported elements become
          pictures after your confirmation.
        </p>
        <div className="office-export-options">
          <label>
            Pages
            <select
              aria-label="PPTX pages"
              disabled={busy}
              value={scope}
              onChange={(e) => {
                invalidate();
                setScope(e.target.value);
              }}
            >
              <option value="all">All pages</option>
              <option value="selected">Selected pages ({selectedPageIds.length})</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={options.includeHiddenSlides}
              onChange={(e) => change({ includeHiddenSlides: e.target.checked })}
            />{' '}
            Include hidden pages
          </label>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={options.includeNotes}
              onChange={(e) => change({ includeNotes: e.target.checked })}
            />{' '}
            Include speaker notes
          </label>
          <label>
            Font
            <select
              aria-label="PPTX font"
              disabled={busy}
              value={options.fontProfileId}
              onChange={(e) => change({ fontProfileId: e.target.value })}
            >
              <option value="noto-cjk-jp-2.004">Noto Sans CJK JP 2.004</option>
            </select>
          </label>
          <small>
            The recipient needs this font. Fonts are referenced, not embedded. Text may reflow in
            Office.
          </small>
          <label>
            Unsupported elements
            <select
              aria-label="PPTX fallback"
              disabled={busy}
              value={options.fallback}
              onChange={(e) => change({ fallback: e.target.value as SlidePptxOptions['fallback'] })}
            >
              <option value="element-png">Ask before using element pictures</option>
              <option value="reject">Stop if an element cannot stay editable</option>
            </select>
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        <p role="status">
          {phase === 'preparing'
            ? 'Preparing PPTX preview… You can continue editing.'
            : phase === 'encoding'
              ? 'Creating PPTX… You can continue editing.'
              : phase === 'downloaded'
                ? 'PPTX downloaded.'
                : report
                  ? 'Preview ready.'
                  : 'Prepare a preview to see the changes.'}
        </p>
        {report && (
          <>
            <p aria-label="PPTX source">
              {report.basis.kind === 'confirmed'
                ? `Confirmed revision ${report.basis.revision}`
                : report.basis.kind === 'saved-version'
                  ? 'Saved version'
                  : 'Local draft'}{' '}
              · {report.selectedPageIds.length} pages
            </p>
            {outdated && (
              <p role="status">
                The artifact changed after this preview. This export keeps the captured content.
                Refresh to include the latest edits.
              </p>
            )}
            <p aria-label="PPTX counts">
              Editable: {report.counts.native + report.counts.approximated} · Pictures:{' '}
              {report.counts.rasterized} · Excluded: {report.counts.omitted} · Errors:{' '}
              {errors.length}
            </p>
            <details open>
              <summary>Changes and warnings ({diagnostics.length})</summary>
              <ol className="office-export-diagnostics" start={diagnosticPage * 20 + 1}>
                {rows.map((d) => (
                  <li key={d.id}>
                    <strong>{d.severity}</strong>: {d.message}
                    {d.address?.slideId && (
                      <button
                        className="office-export-locate"
                        onClick={() => onNavigate(d.address!)}
                      >
                        Go to page{' '}
                        {content.slides.findIndex((s) => s.id === d.address?.slideId) + 1}
                        {d.address.elementId ? ' / element' : ''}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {diagnostics.length > 20 && (
                <nav aria-label="PPTX diagnostic pages">
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
              {report ? 'Refresh PPTX preview' : 'Prepare PPTX preview'}
            </button>
          )}
          {report && (
            <button
              disabled={busy || !!errors.length || (!!warnings.length && !accepted)}
              onClick={() => void encode()}
            >
              Download PPTX
            </button>
          )}
          {report && (
            <button
              onClick={() =>
                download(
                  'pptx-export-report.json',
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
