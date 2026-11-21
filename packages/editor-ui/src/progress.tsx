import { useEffect, useState } from 'react';
import { describeProgress, type OperationProgress } from '@editor-platform/editor-core';

const pageClock = () => performance.now();
/** `Date.now()` for an epoch start time (after 1973), `performance.now()` otherwise. */
export const progressClock = (startedAt: number): (() => number) =>
  startedAt > 1e11 ? Date.now : pageClock;

/**
 * #16: a heavy operation's progress (done of total, time left) and its Cancel button. The
 * estimate refreshes every second even when no step reports, so it does not look stuck.
 */
export function ProgressStatus({
  label,
  progress,
  unit,
  onCancel,
  cancelLabel = 'Cancel',
  clock,
}: {
  /** What is running, e.g. "Checking the lifts". */
  label: string;
  progress: OperationProgress;
  /** What is counted, e.g. "frames". */
  unit?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  /**
   * The clock `progress.startedAt` was read from. By default the one it looks like: an epoch
   * time (`Date.now()`) or the page's (`performance.now()`) (Codex on #31).
   */
  clock?: () => number;
}) {
  const read = clock ?? progressClock(progress.startedAt);
  const [now, setNow] = useState(read);
  useEffect(() => {
    setNow(read());
    const t = setInterval(() => setNow(read()), 1000);
    return () => clearInterval(t);
  }, [read]);
  const text = describeProgress(progress, Math.max(now, progress.startedAt), unit);
  return (
    <span className="ep-progress" role="status" aria-label={label}>
      <progress value={Math.min(progress.done, progress.total)} max={progress.total || 1} />
      <span>
        {label}: {text}
      </span>
      {onCancel && (
        <button type="button" className="ep-progress-cancel" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
    </span>
  );
}
