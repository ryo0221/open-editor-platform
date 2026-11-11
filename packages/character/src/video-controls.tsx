import { useState } from 'react';
import type { Rational } from '@editor-platform/animation-core';
import type { CharacterAction } from '@editor-platform/character-core';
import { ticksPerSecond } from './playback';
import {
  formatFps,
  videoFrameCount,
  videoFrameRates,
  videoSizes,
  type VideoSettings,
} from './video-export';

/** A ZIP of PNG frames (C8a) or an H.264 MP4 (C8b). */
export type VideoKind = 'png' | 'mp4';
/** What the last export made, or why it stopped. */
export type VideoReport =
  | { name: string; frames: number; width: number; height: number; fps: Rational }
  | { error: string }
  | { cancelled: true };

const sameRate = (a: Rational, b: Rational) =>
  a.numerator * b.denominator === b.numerator * a.denominator;

/**
 * C8a: "Video" in the Inspector: which action, the range in seconds, the size and the frame
 * rate, then "Export frames" (a ZIP of PNGs) or "Export video" (an H.264 MP4, C8b). While it runs: progress and Cancel.
 */
export function VideoControls({
  actions,
  actionId,
  busy,
  disabled,
  problems,
  running,
  report,
  onExport,
  onCancel,
}: {
  actions: readonly CharacterAction[];
  /** The action the transport plays: chosen first. */
  actionId: string | null;
  busy: boolean;
  /** Why nothing can be exported now (assets do not match, a mode is on…). */
  disabled: string | undefined;
  /** The Surface's check of the settings as they are (`videoSettingsProblems`). */
  problems(settings: VideoSettings): string[];
  running: { done: number; total: number; kind: VideoKind } | undefined;
  report: VideoReport | undefined;
  onExport(settings: VideoSettings, kind: VideoKind): void;
  onCancel(): void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const action =
    actions.find((a) => a.id === chosen) ?? actions.find((a) => a.id === actionId) ?? actions[0];
  // Seconds as typed; the range follows the action until the person changes it.
  const [range, setRange] = useState<{ actionId: string; start: string; end: string }>();
  const shownRange =
    action && range?.actionId === action.id
      ? range
      : { actionId: action?.id ?? '', start: '0', end: action ? seconds(action.duration) : '0' };
  const [size, setSize] = useState({ preset: '720p', width: '1280', height: '720' });
  const [rate, setRate] = useState('action');
  const fps: Rational =
    rate === 'action' && action
      ? action.frameRate
      : (videoFrameRates.find((r) => formatFps(r) === rate) ?? { numerator: 30, denominator: 1 });
  const settings: VideoSettings = {
    actionId: action?.id ?? '',
    start: Math.round(Number(shownRange.start) * ticksPerSecond),
    end: toEndTicks(shownRange.end, action),
    width: Number(size.width),
    height: Number(size.height),
    fps,
  };
  const issues = action ? problems(settings) : ['Add an action to export.'];

  if (running)
    return (
      <div className="character-mesh-row" role="group" aria-label="Video export">
        <span className="character-hint" role="status">
          {running.kind === 'mp4' ? 'Exporting video…' : 'Exporting frames…'} {running.done} of{' '}
          {running.total}
        </span>
        <button type="button" onClick={onCancel}>
          Cancel export
        </button>
      </div>
    );
  const off = busy || !!disabled;
  const edit = (next: Partial<typeof shownRange>) => {
    const r = { ...shownRange, ...next };
    setRange(r);
  };
  return (
    <div className="character-video" role="group" aria-label="Video export">
      <label>
        Action
        <select
          aria-label="Export action"
          value={action?.id ?? ''}
          disabled={off || !actions.length}
          onChange={(e) => {
            setChosen(e.target.value);
            setRange(undefined);
          }}
        >
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <div className="character-mesh-row">
        <label>
          From (s)
          <input
            aria-label="From (s)"
            type="number"
            min={0}
            step={0.01}
            value={shownRange.start}
            disabled={off}
            onChange={(e) => edit({ start: e.target.value })}
          />
        </label>
        <label>
          To (s)
          <input
            aria-label="To (s)"
            type="number"
            min={0}
            step={0.01}
            value={shownRange.end}
            disabled={off}
            onChange={(e) => edit({ end: e.target.value })}
          />
        </label>
      </div>
      <div className="character-mesh-row">
        <label>
          Size
          <select
            aria-label="Size"
            value={size.preset}
            disabled={off}
            onChange={(e) => {
              const p = videoSizes.find((s) => s.label === e.target.value);
              setSize(
                p
                  ? { preset: p.label, width: String(p.width), height: String(p.height) }
                  : { ...size, preset: 'custom' },
              );
            }}
          >
            {videoSizes.map((s) => (
              <option key={s.label} value={s.label}>
                {s.label} ({s.width} × {s.height})
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        {size.preset === 'custom' && (
          <>
            <label>
              Width
              <input
                aria-label="Width"
                type="number"
                min={16}
                step={2}
                value={size.width}
                disabled={off}
                onChange={(e) => setSize({ ...size, width: e.target.value })}
              />
            </label>
            <label>
              Height
              <input
                aria-label="Height"
                type="number"
                min={16}
                step={2}
                value={size.height}
                disabled={off}
                onChange={(e) => setSize({ ...size, height: e.target.value })}
              />
            </label>
          </>
        )}
      </div>
      <label>
        Frame rate
        <select
          aria-label="Frame rate"
          value={rate}
          disabled={off}
          onChange={(e) => setRate(e.target.value)}
        >
          {action && <option value="action">Action ({formatFps(action.frameRate)} fps)</option>}
          {videoFrameRates
            .filter((r) => !action || !sameRate(r, action.frameRate))
            .map((r) => (
              <option key={formatFps(r)} value={formatFps(r)}>
                {formatFps(r)} fps
              </option>
            ))}
        </select>
      </label>
      {disabled ? (
        <p className="character-hint">{disabled}</p>
      ) : issues.length ? (
        <ul className="character-hint" aria-label="Video settings problems">
          {issues.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : (
        <p className="character-hint">{videoFrameCount(settings)} frames</p>
      )}
      <div className="character-mesh-row">
        <button
          type="button"
          disabled={off || !!issues.length}
          onClick={() => onExport(settings, 'png')}
        >
          Export frames
        </button>
        <button
          type="button"
          disabled={off || !!issues.length}
          onClick={() => onExport(settings, 'mp4')}
        >
          Export video
        </button>
      </div>
      {report && (
        <p className="character-hint" role="status" data-testid="video-report">
          {'error' in report
            ? report.error
            : 'cancelled' in report
              ? 'Export cancelled; nothing was saved.'
              : `${report.name}: ${report.frames} frames, ${report.width} × ${report.height}, ${formatFps(report.fps)} fps.`}
        </p>
      )}
    </div>
  );
}

const seconds = (ticks: number) => String(Math.round((ticks / ticksPerSecond) * 100) / 100);
/**
 * The typed end in ticks; the action's end shown rounded (two decimals) means the end itself,
 * so an untouched range never ends past the action. The start is never snapped.
 */
function toEndTicks(typed: string, action: CharacterAction | undefined): number {
  const t = Math.round(Number(typed) * ticksPerSecond);
  if (action && Math.abs(t - action.duration) <= ticksPerSecond / 200) return action.duration;
  return t;
}
