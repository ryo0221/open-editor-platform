/**
 * The Render dialog (#664) shared by CAD and the building: size, samples, time limit, HDRI and
 * floor; a progress line with Cancel (nothing kept) and Stop (keeps the image reached); then
 * the image and a PNG download. The dialog is modal, so the model does not change during a
 * render, and the path tracing runs on a canvas of its own (see `renderPathTraced`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@editor-platform/editor-ui';
import type { Texture } from 'three';
import {
  defaultPathRenderSettings,
  pathRenderLimits,
  pathRenderProblem,
  pathRenderSupport,
  readHdri,
  renderPathTraced,
  type PathRenderControl,
  type PathRenderResult,
  type PathRenderSettings,
  type PathRenderSource,
} from './path-render';
import './path-render-panel.css';

type Phase =
  | { kind: 'settings' }
  | { kind: 'rendering'; samples: number; elapsedMs: number; preparing: boolean }
  | { kind: 'done'; result: PathRenderResult; url: string };

const stopped: Record<PathRenderResult['stoppedBy'], string> = {
  samples: 'all samples',
  time: 'time limit reached',
  finish: 'stopped',
};

export function PathRenderDialog({
  source,
  name,
  onSavePng,
  onClose,
  support = pathRenderSupport,
}: {
  /** The view's solids and camera, read when the render starts; undefined when nothing is shown. */
  source(): PathRenderSource | undefined;
  /** File name stem of the PNG. */
  name: string;
  /** Receives the PNG; without it the dialog offers a download. */
  onSavePng?(png: Blob, fileName: string): void;
  onClose(): void;
  support?: typeof pathRenderSupport;
}) {
  const supported = useMemo(() => support(), [support]);
  const [settings, setSettings] = useState<PathRenderSettings>(defaultPathRenderSettings);
  const [hdri, setHdri] = useState<File>();
  const [phase, setPhase] = useState<Phase>({ kind: 'settings' });
  const [error, setError] = useState<string>();
  const control = useRef<PathRenderControl>({});
  const url = phase.kind === 'done' ? phase.url : undefined;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  // The editor's Undo and Redo shortcuts listen on the window: while this modal dialog is open
  // none reaches them, so the model does not change behind it. Inputs keep their own undo (the
  // default action is left alone).
  useEffect(() => {
    const hold = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) e.stopPropagation();
    };
    window.addEventListener('keydown', hold, true);
    return () => window.removeEventListener('keydown', hold, true);
  }, []);
  // Closing the dialog mid-render cancels it.
  useEffect(() => () => void (control.current.cancelled = true), []);
  const problem = pathRenderProblem(settings);
  const set = (change: Partial<PathRenderSettings>) => setSettings((s) => ({ ...s, ...change }));
  const number = (key: keyof PathRenderSettings) => ({
    value: String(settings[key]),
    onChange: (e: { target: { value: string } }) => set({ [key]: Number(e.target.value) }),
  });

  async function start() {
    setError(undefined);
    if (!source()) return setError('Nothing is shown to render.');
    const run: PathRenderControl = {};
    control.current = run;
    setPhase({ kind: 'rendering', samples: 0, elapsedMs: 0, preparing: true });
    let environment: Texture | undefined;
    try {
      if (hdri) environment = await readHdri(hdri);
      if (run.cancelled) return;
      // Read after the HDRI: renderPathTraced copies it at once, before its own awaits.
      const shown = source();
      if (!shown) throw new Error('Nothing is shown to render.');
      const result = await renderPathTraced(shown, settings, {
        control: run,
        hdri: environment,
        onProgress: (progress) => !run.cancelled && setPhase({ kind: 'rendering', ...progress }),
      });
      if (run.cancelled) return;
      setPhase({ kind: 'done', result, url: URL.createObjectURL(result.png) });
    } catch (e) {
      if (run.cancelled) return;
      setPhase({ kind: 'settings' });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      environment?.dispose();
    }
  }
  function cancel() {
    control.current.cancelled = true;
    setPhase({ kind: 'settings' });
  }
  function save(result: PathRenderResult) {
    const fileName = `${name}-render.png`;
    if (onSavePng) return onSavePng(result.png, fileName);
    const href = URL.createObjectURL(result.png);
    Object.assign(document.createElement('a'), { href, download: fileName }).click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
  const close = () => (cancel(), onClose());
  const rendering = phase.kind === 'rendering';
  const { minSide, maxSide, maxSamples, maxTimeLimit } = pathRenderLimits;

  return (
    <Dialog title="Render image" onClose={close}>
      <div className="view-render" data-testid="view-render">
        {!supported.ok ? (
          <p role="alert" data-testid="view-render-unsupported">
            {supported.reason}
          </p>
        ) : (
          <>
            <fieldset disabled={rendering}>
              <legend>Image</legend>
              <div className="view-render-row">
                <label>
                  Width (px)
                  <input type="number" min={minSide} max={maxSide} step={1} {...number('width')} />
                </label>
                <label>
                  Height (px)
                  <input type="number" min={minSide} max={maxSide} step={1} {...number('height')} />
                </label>
              </div>
              <div className="view-render-row">
                <label>
                  Samples
                  <input type="number" min={1} max={maxSamples} step={1} {...number('samples')} />
                </label>
                <label>
                  Time limit (s, 0 = none)
                  <input
                    type="number"
                    min={0}
                    max={maxTimeLimit}
                    step={1}
                    {...number('timeLimit')}
                  />
                </label>
              </div>
              <p className="view-render-muted">
                Sampling stops at the samples or the time limit, whichever comes first, and the
                image reached is kept.
              </p>
            </fieldset>
            <fieldset disabled={rendering}>
              <legend>Lighting</legend>
              <label>
                HDRI (.hdr or .exr, optional)
                <input
                  type="file"
                  accept=".hdr,.exr"
                  data-testid="view-render-hdri"
                  onChange={(e) => setHdri(e.target.files?.[0])}
                />
              </label>
              {hdri ? (
                <div className="view-render-row">
                  <label>
                    Rotation (°)
                    <input type="number" step={15} {...number('hdriRotation')} />
                  </label>
                  <label>
                    Strength
                    <input
                      type="number"
                      min={0.05}
                      max={100}
                      step={0.1}
                      {...number('hdriIntensity')}
                    />
                  </label>
                </div>
              ) : (
                <p className="view-render-muted">Without an HDRI: a plain sky and a sun.</p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={settings.floor}
                  onChange={(e) => set({ floor: e.target.checked })}
                />
                Floor under the model
              </label>
            </fieldset>
          </>
        )}
        {problem && supported.ok && <p role="alert">{problem}</p>}
        {error && <p role="alert">{error}</p>}
        {phase.kind === 'rendering' && (
          <p role="status" data-testid="view-render-progress">
            {phase.preparing && phase.samples === 0
              ? 'Preparing the path tracer (the first render compiles its shader)'
              : `Rendering: ${phase.samples} / ${settings.samples} samples`}
            , {(phase.elapsedMs / 1000).toFixed(0)} s
            {settings.timeLimit ? ` of ${settings.timeLimit} s` : ''}
          </p>
        )}
        {phase.kind === 'done' && (
          <figure className="view-render-result">
            <img src={phase.url} alt="Rendered image" data-testid="view-render-image" />
            <figcaption role="status" data-testid="view-render-done">
              {phase.result.width} × {phase.result.height} px, {phase.result.samples}{' '}
              {phase.result.samples === 1 ? 'sample' : 'samples'} ({stopped[phase.result.stoppedBy]}
              )
            </figcaption>
            <p className="view-render-muted" data-testid="view-render-gpu">
              {phase.result.api}
              {phase.result.gpu ? `, GPU: ${phase.result.gpu}` : ''}
              {phase.result.webgpuFailure
                ? ` (WebGPU failed and WebGL was used: ${phase.result.webgpuFailure})`
                : ''}
            </p>
            {phase.result.invalidPixels > 0 && (
              <p role="alert" data-testid="view-render-invalid">
                {phase.result.invalidPixels} pixels had no valid value and are black: the GPU or its
                driver returned invalid numbers.
              </p>
            )}
          </figure>
        )}
        <div className="view-render-actions">
          {phase.kind === 'rendering' ? (
            <>
              <button onClick={() => (control.current.finishNow = true)}>Stop and keep</button>
              <button onClick={cancel}>Cancel</button>
            </>
          ) : (
            <>
              {phase.kind === 'done' && (
                <button onClick={() => save(phase.result)}>Save PNG</button>
              )}
              <button disabled={!supported.ok || !!problem} onClick={() => void start()}>
                {phase.kind === 'done' ? 'Render again' : 'Render'}
              </button>
              <button onClick={close}>Close</button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
