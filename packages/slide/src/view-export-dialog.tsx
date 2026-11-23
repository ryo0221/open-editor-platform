import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useWording } from '@editor-platform/editor-ui';
import type { PdfExportLifecycle } from '@editor-platform/canvas-ui';
import {
  defaultSlideHoldSeconds,
  defaultSlidePdfPageMode,
  slideMotionCommand,
  slidePlaybackPages,
  type SlideMotionOperation,
  type SlidePdfPageMode,
  type SlideStateHold,
} from './model';
import {
  planSlideMp4,
  slideMp4Refusal,
  slidePdfMaxPages,
  slidePdfPageCount,
} from './export-playback';
import type { SlideOutput } from './view-export';
import type { SlideEditing } from './view-shared';

const formats = ['pdf', 'mp4'] as const;
type ExportFormat = (typeof formats)[number];
export interface SlideExportDialogOpening {
  format: ExportFormat;
  scale: number;
  opener?: HTMLButtonElement | null;
  fallback?: HTMLButtonElement | null;
}
const holdKey = (slideId: string, stepId?: string) => JSON.stringify([slideId, stepId]);

function seconds(value: string) {
  const number = Number(value);
  return /^(?:[0-9]+(?:\.[0-9]{0,3})?|\.[0-9]{1,3})$/.test(value) && number <= 60
    ? number
    : undefined;
}

function OutputHold({
  label,
  value,
  inherited,
  disabled,
  canSave,
  changed,
  onChange,
  onReset,
  onSave,
}: {
  label: string;
  value: string;
  inherited?: boolean;
  disabled: boolean;
  canSave: boolean;
  changed: boolean;
  onChange(value: string): void;
  onReset?(): void;
  onSave(value: number | null): void;
}) {
  const t = useWording();
  const id = useId();
  const parsed = seconds(value);
  const invalid = inherited !== true && parsed === undefined;
  return (
    <div className="slide-export-hold">
      <label className="ep-field">
        {label}
        <input
          inputMode="decimal"
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? id : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {inherited !== undefined && <small>{t(inherited ? 'Using default' : 'Custom hold')}</small>}
      {onReset && (
        <button type="button" disabled={disabled || inherited} onClick={onReset}>
          {t('Use default')}
        </button>
      )}
      <button
        type="button"
        disabled={!canSave || !changed || invalid}
        onClick={() => onSave(inherited ? null : parsed!)}
      >
        {t('Save to deck')}
      </button>
      {invalid && <p id={id}>{t('Enter 0–60 seconds with up to three decimal places.')}</p>}
    </div>
  );
}

export function SlideExportDialog({
  editing,
  opening,
  start,
  isComposing,
  close,
}: {
  editing: SlideEditing;
  opening: SlideExportDialogOpening;
  start(output: SlideOutput, lifecycle: PdfExportLifecycle): Promise<void>;
  isComposing(): boolean;
  close(): void;
}) {
  const t = useWording();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | undefined>(undefined);
  const [format, setFormat] = useState(opening.format);
  const [draftMode, setDraftMode] = useState<SlidePdfPageMode>();
  const [draftDefault, setDraftDefault] = useState<string>();
  const [draftHolds, setDraftHolds] = useState(new Map<string, string | null>());
  const [status, setStatus] = useState<{ done: number; total: number }>();
  const [error, setError] = useState('');
  const busy = status !== undefined;
  const canSave = !editing.readOnly && !editing.sharedEditing && !busy;
  const { content } = editing;
  const pages = slidePlaybackPages(content);
  const saved = content.exportSettings;
  const savedMode = saved?.pdf?.pageMode ?? defaultSlidePdfPageMode;
  const mode = draftMode ?? savedMode;
  const pageCount = slidePdfPageCount(content, mode);
  const savedDefault = saved?.mp4?.defaultHoldSeconds ?? defaultSlideHoldSeconds;
  const defaultValue = draftDefault ?? String(savedDefault);
  const defaultSeconds = seconds(defaultValue);
  const savedHolds = new Map(
    saved?.mp4?.holds?.map((hold) => [holdKey(hold.slideId, hold.stepId), hold.holdSeconds]),
  );
  const stateRows = pages.map(({ page }, pageIndex) => ({
    page,
    pageIndex,
    rows: [undefined, ...(page.steps ?? []).map(({ id }) => id)].map((stepId, step) => {
      const key = holdKey(page.id, stepId);
      const draft = draftHolds.get(key);
      const stored = savedHolds.get(key);
      const value = draft === null ? undefined : (draft ?? stored?.toString());
      return { key, stepId, step, stored, value };
    }),
  }));
  const holds: SlideStateHold[] = [];
  let validHolds = defaultSeconds !== undefined;
  for (const { page, rows } of stateRows) {
    for (const { stepId, value } of rows) {
      if (value === undefined) continue;
      const holdSeconds = seconds(value);
      if (holdSeconds === undefined) validHolds = false;
      else
        holds.push({ slideId: page.id, ...(stepId === undefined ? {} : { stepId }), holdSeconds });
    }
  }
  const mp4 = { defaultHoldSeconds: defaultSeconds, holds };
  const plan = format === 'mp4' && validHolds ? planSlideMp4(content, mp4) : undefined;
  const refusal =
    format === 'pdf'
      ? pageCount < 1 || pageCount > slidePdfMaxPages
        ? 'PDF は展開後 1〜500 ページの範囲で書き出せます。'
        : undefined
      : plan
        ? slideMp4Refusal(plan)
        : 'Enter 0–60 seconds with up to three decimal places.';

  useLayoutEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    return () => {
      modal?.close();
      const { opener, fallback } = opening;
      (opener?.isConnected && opener.getClientRects().length ? opener : fallback)?.focus();
    };
  }, [opening]);
  useEffect(() => () => operation.current?.abort(), []);

  const changeHold = (key: string, value: string | null | undefined) => {
    setDraftHolds((previous) => {
      const next = new Map(previous);
      if (value === undefined) next.delete(key);
      else next.set(key, value);
      return next;
    });
  };
  const save = (command: SlideMotionOperation, clear: () => void) => {
    if (!canSave || isComposing()) return;
    if (editing.apply(slideMotionCommand(command))) {
      setError('');
      clear();
    } else {
      setError('The setting could not be saved to the deck.');
    }
  };
  const dismiss = () => {
    if (isComposing()) return;
    if (operation.current) operation.current.abort();
    else close();
  };
  async function requestExport() {
    if (operation.current || refusal || isComposing()) return;
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    setStatus({ done: 0, total: 0 });
    try {
      const output: SlideOutput =
        format === 'pdf'
          ? { format, pageMode: mode, scale: opening.scale }
          : { format, settings: mp4 };
      await start(output, {
        signal: controller.signal,
        progress: (done, total) => {
          if (format === 'pdf' || done % 15 === 0 || done === total) setStatus({ done, total });
        },
      });
      close();
    } catch (error) {
      setError(
        controller.signal.aborted
          ? 'Export cancelled.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      operation.current = undefined;
      setStatus(undefined);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="ep-dialog slide-export-dialog"
      data-editor-export-scope
      aria-label={t('Slide export')}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="ep-dialog-heading">
        <h2>{t('Slide export')}</h2>
      </div>
      <div className="slide-export-tabs" role="tablist" aria-label={t('Export format')}>
        {formats.map((tab, index) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${id}-${tab}`}
            aria-selected={tab === format}
            aria-controls={`${id}-panel`}
            tabIndex={tab === format ? 0 : -1}
            disabled={busy}
            onClick={() => {
              setFormat(tab);
              setError('');
            }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || isComposing())
                return;
              const next =
                event.key === 'Home'
                  ? formats[0]
                  : event.key === 'End'
                    ? formats.at(-1)!
                    : formats[1 - index];
              event.preventDefault();
              setFormat(next);
              setError('');
              document.getElementById(`${id}-${next}`)?.focus();
            }}
          >
            {tab.toUpperCase()}
          </button>
        ))}
      </div>
      <section
        id={`${id}-panel`}
        className="slide-export-settings"
        role="tabpanel"
        aria-labelledby={`${id}-${format}`}
      >
        {format === 'pdf' ? (
          <>
            <div className="slide-export-hold">
              <label className="ep-field">
                {t('PDF pagination')}
                <select
                  disabled={busy}
                  value={mode}
                  onChange={(event) => setDraftMode(event.target.value as SlidePdfPageMode)}
                >
                  <option value="final">{t('Final state')}</option>
                  <option value="steps">{t('Each step')}</option>
                </select>
              </label>
              <button
                type="button"
                disabled={!canSave || mode === savedMode}
                onClick={() =>
                  save({ type: 'slide.export.pdf.page-mode', pageMode: mode }, () =>
                    setDraftMode(undefined),
                  )
                }
              >
                {t('Save to deck')}
              </button>
            </div>
          </>
        ) : (
          <>
            <OutputHold
              label={t('Default hold (seconds)')}
              value={defaultValue}
              disabled={busy}
              canSave={canSave}
              changed={defaultSeconds !== savedDefault}
              onChange={setDraftDefault}
              onSave={(holdSeconds) =>
                save({ type: 'slide.export.mp4.default-hold', holdSeconds }, () =>
                  setDraftDefault(undefined),
                )
              }
            />
            {stateRows.map(({ page, pageIndex, rows }) => (
              <details key={page.id}>
                <summary>
                  {t('Slide {0}', pageIndex + 1)}
                  {page.title && page.title !== `Slide ${pageIndex + 1}` && ` · ${page.title}`}
                </summary>
                {rows.map(({ key, stepId, step, stored, value }) => (
                  <OutputHold
                    key={key}
                    label={
                      step === 0
                        ? t('Initial hold (seconds)')
                        : t('Step {0} completed hold (seconds)', step)
                    }
                    value={value ?? defaultValue}
                    inherited={value === undefined}
                    disabled={busy}
                    canSave={canSave}
                    changed={(value === undefined ? undefined : seconds(value)) !== stored}
                    onChange={(value) => changeHold(key, value)}
                    onReset={() => changeHold(key, null)}
                    onSave={(holdSeconds) =>
                      save(
                        {
                          type: 'slide.export.mp4.state-hold',
                          slideId: page.id,
                          ...(stepId === undefined ? {} : { stepId }),
                          holdSeconds,
                        },
                        () => changeHold(key, undefined),
                      )
                    }
                  />
                ))}
              </details>
            ))}
          </>
        )}
      </section>
      <footer className="slide-export-actions">
        {format === 'pdf' && (
          <p>
            <output aria-live="polite">
              {t(pageCount === 1 ? '{0} PDF page' : '{0} PDF pages', pageCount)}
            </output>
          </p>
        )}
        {plan && (
          <p>
            <output aria-live="polite">
              {t(
                '{0} s · {1} frames · {2} × {3} px',
                plan.durationMs / 1000,
                plan.frames,
                plan.width,
                plan.height,
              )}
            </output>
          </p>
        )}
        {refusal && <p role="status">{t(refusal)}</p>}
        {error && <p role="alert">{t(error)}</p>}
        {status && (
          <label className="ep-field">
            {t('Exporting…')}
            <progress
              aria-label={t('Exporting…')}
              max={status.total || undefined}
              value={status.total ? status.done : undefined}
            />
          </label>
        )}
        <div>
          <button type="button" disabled={busy || !!refusal} onClick={() => void requestExport()}>
            {t('Export file')}
          </button>
          <button type="button" onClick={dismiss}>
            {t(busy ? 'Stop export' : 'Close')}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
