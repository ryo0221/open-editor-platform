import { useEffect, useMemo, useRef, useState } from 'react';
import {
  animationFramePreview2,
  exportAnimationFrame2,
  type AnimationFramePlan2,
} from '@editor-platform/animation-player/v2';
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AnimationFrameExport2(props: {
  plan: AnimationFramePlan2;
  frameStep: number;
  canRead(): boolean;
  close(): void;
  report(message: string): void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [busy, setBusy] = useState(false),
    controller = useRef<AbortController | null>(null);
  const preview = useMemo(
    () =>
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(animationFramePreview2(props.plan)),
    [props.plan],
  );
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <fieldset>
      <legend>Static export confirmation</legend>
      <p>{props.plan.losses[0].reason}</p>
      <p>
        Frame {(props.plan.tick / props.frameStep).toFixed(2)}. This exact source and input snapshot
        will be exported.
      </p>
      <img
        alt="Captured static Animation frame"
        src={preview}
        style={{ width: '100%', maxWidth: 640, maxHeight: 360, objectFit: 'contain' }}
      />
      {(['svg', 'png'] as const).map((format) => (
        <button
          key={format}
          disabled={busy}
          onClick={() => {
            const abort = new AbortController();
            controller.current = abort;
            setBusy(true);
            void exportAnimationFrame2(props.plan, {
              acceptedPlanHash: props.plan.planHash,
              format,
              document,
              signal: abort.signal,
              canRead: () => latest.current.canRead(),
            })
              .then((blob) => {
                download(blob, 'animation-frame.' + format);
                latest.current.close();
              })
              .catch((error) => {
                if (!abort.signal.aborted) latest.current.report(String(error));
              })
              .finally(() => {
                if (!abort.signal.aborted) setBusy(false);
              });
          }}
        >
          Confirm {format.toUpperCase()} export
        </button>
      ))}
      <button
        onClick={() => {
          controller.current?.abort();
          props.close();
        }}
      >
        Cancel export
      </button>
    </fieldset>
  );
}
