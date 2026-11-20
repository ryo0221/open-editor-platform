import { useEffect, useState } from 'react';
import { describeProgress, type OperationProgress } from '@editor-platform/editor-core';

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
}: {
  /** What is running, e.g. "Checking the lifts". */
  label: string;
  progress: OperationProgress;
  /** What is counted, e.g. "frames". */
  unit?: string;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(t);
  }, []);
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
