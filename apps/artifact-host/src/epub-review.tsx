import { useEffect, useRef, useState } from 'react';
import { newId } from '@editor-platform/artifact-core';
import type { DocumentSequenceSource } from '@editor-platform/document/sequence';
import {
  prepareDocumentEpub,
  encodeDocumentEpub,
  type DocumentEpubPlan,
} from '@editor-platform/document-export/epub';
import { downloadBlob } from '@editor-platform/canvas-ui';

/** Export review only: metadata/persistence/AI remain Host-owned. */
export function EpubReview({
  guardInputs,
  readSources,
  sourcesKey,
}: {
  guardInputs(): void;
  readSources(): DocumentSequenceSource[];
  sourcesKey: string;
}) {
  const [title, setTitle] = useState('Chapter sequence');
  const [language, setLanguage] = useState('ja');
  const [identifier] = useState(() => newId('book'));
  const [creator, setCreator] = useState('');
  const [plan, setPlan] = useState<DocumentEpubPlan>();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'encoding' | 'downloaded'>('idle');
  const operation = useRef<AbortController | undefined>(undefined);
  const preparedKey = useRef('');
  const currentKey = useRef(sourcesKey);
  currentKey.current = sourcesKey;
  const currentGuard = useRef(guardInputs);
  currentGuard.current = guardInputs;
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      operation.current?.abort();
    },
    [],
  );
  const busy = phase === 'preparing' || phase === 'encoding';
  const stale = !!plan && preparedKey.current !== sourcesKey;
  function invalidate() {
    generation.current++;
    operation.current?.abort();
    setPlan(undefined);
    setAccepted(false);
    setError('');
    setPhase('idle');
  }
  async function prepare() {
    const attempt = ++generation.current;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPlan(undefined);
    setAccepted(false);
    setError('');
    setPhase('preparing');
    try {
      currentGuard.current();
      const sources = readSources();
      const key = currentKey.current;
      const result = await prepareDocumentEpub(
        sources,
        {
          title,
          language,
          identifier,
          creators: creator.trim() ? [creator] : [],
          modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        },
        controller.signal,
      );
      if (attempt !== generation.current) return;
      preparedKey.current = key;
      setPlan(result);
      setPhase('idle');
    } catch (e) {
      if (attempt === generation.current) {
        setError(String(e));
        setPhase('idle');
      }
    }
  }
  async function encode() {
    if (!plan || stale) {
      setError('Saved chapter order or versions changed. Prepare EPUB again.');
      return;
    }
    const attempt = ++generation.current;
    const controller = new AbortController();
    operation.current = controller;
    setPhase('encoding');
    setError('');
    try {
      currentGuard.current();
      const result = await encodeDocumentEpub(
        plan,
        {
          planHash: plan.report.planHash,
          acceptedDiagnosticIds: accepted
            ? plan.report.diagnostics.filter((d) => d.requiresAcceptance).map((d) => d.id)
            : [],
        },
        controller.signal,
      );
      if (attempt !== generation.current) return;
      currentGuard.current();
      if (preparedKey.current !== currentKey.current) {
        setError('Saved chapter versions changed during export. Prepare EPUB again.');
        setPhase('idle');
        return;
      }
      if (result.status === 'ok') {
        downloadBlob(
          'chapters.epub',
          new Blob([new Uint8Array(result.bytes)], { type: result.mime }),
        );
        setPhase('downloaded');
      } else {
        setError(
          result.status === 'blocked'
            ? 'Review all warnings and resolve blocking diagnostics.'
            : result.status === 'failed'
              ? result.message
              : 'EPUB export cancelled.',
        );
        setPhase('idle');
      }
    } catch (e) {
      if (attempt === generation.current) {
        setError(String(e));
        setPhase('idle');
      }
    }
  }
  return (
    <section aria-label="EPUB export review">
      <h3>EPUB export — horizontal subset</h3>
      <p>
        Captures saved chapter versions. Vertical text, ruby, links, images and fixed pagination are
        unsupported.
      </p>
      <label>
        EPUB title{' '}
        <input
          value={title}
          disabled={busy}
          onChange={(e) => {
            invalidate();
            setTitle(e.target.value);
          }}
        />
      </label>
      <label>
        EPUB language{' '}
        <input
          value={language}
          disabled={busy}
          onChange={(e) => {
            invalidate();
            setLanguage(e.target.value);
          }}
        />
      </label>
      <label>
        EPUB creator (optional){' '}
        <input
          value={creator}
          disabled={busy}
          onChange={(e) => {
            invalidate();
            setCreator(e.target.value);
          }}
        />
      </label>
      <button disabled={busy} onClick={() => void prepare()}>
        Prepare EPUB preview
      </button>
      {busy && (
        <button
          onClick={() => {
            invalidate();
            setError('EPUB export cancelled. No file was downloaded.');
          }}
        >
          Cancel EPUB export
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {plan && (
        <>
          <pre aria-label="EPUB report">{JSON.stringify(plan.report, null, 2)}</pre>
          {stale && (
            <p role="status">Saved chapter order or versions changed. Refresh the EPUB preview.</p>
          )}
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy || stale}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            I accept the EPUB reflow and omission report
          </label>
          <button
            disabled={
              busy ||
              stale ||
              !accepted ||
              plan.report.diagnostics.some((d) => d.severity === 'error')
            }
            onClick={() => void encode()}
          >
            Download EPUB
          </button>
          <button
            onClick={() =>
              downloadBlob(
                'epub-report.json',
                new Blob([JSON.stringify(plan.report, null, 2)], { type: 'application/json' }),
              )
            }
          >
            Download EPUB report
          </button>
          <output aria-label="EPUB state">
            {phase === 'downloaded' ? 'Downloaded' : stale ? 'Stale' : 'Prepared'}
          </output>
        </>
      )}
    </section>
  );
}
