/**
 * VS7c-2 (docs/cad/vehicle-simulation.md, VS7): a crash run's result: its measures (peak
 * deceleration, OLC, crush, intrusions, the barrier's impulse and the parts' energy), the
 * accelerometer's waveform (deceleration and velocity, each its own chart), and the deformation
 * frame by frame: a slider, play, and a WebM video of the 3D view recorded in the browser.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CrashRunFields } from './run-crash';
import { crashWaveform, headWaveform } from './crash-view';
import { fmt } from './run-panel';

/** The frame shown, by its field ID (`frame-k`, k from the start). */
export const crashFrameId = (k: number) => `frame-${k}`;
export const crashFrameOf = (field: string) =>
  /^frame-\d+$/.test(field) ? Number(field.slice(6)) : undefined;

/** Frames a second in play and in the video. */
const playRate = 20;

export function CrashResultPanel({
  fields,
  bodyName,
  field,
  setField,
  canvas,
  studyName,
}: {
  fields: CrashRunFields;
  bodyName(bodyId: string): string;
  /** The shown result field (a frame's) and how to show another. */
  field: string;
  setField(id: string): void;
  /** The 3D view's canvas, for a video. */
  canvas(): HTMLCanvasElement | undefined;
  studyName: string;
}) {
  const m = fields.measures;
  const head = fields.head;
  const frames = fields.frames;
  const last = frames.length - 1;
  const frame = Math.min(last, Math.max(0, crashFrameOf(field) ?? last));
  const wave = useMemo(() => (m ? crashWaveform(m) : null), [m]);
  const headWave = useMemo(() => (head ? headWaveform(head.measures) : null), [head]);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState<string>();
  const [videoError, setVideoError] = useState('');
  const shown = useRef(frame);
  shown.current = frame;
  const set = useRef(setField);
  set.current = setField;
  // Play from the shown frame (from the start once at the end) to the last one.
  useEffect(() => {
    if (!playing) return;
    if (shown.current >= last) set.current(crashFrameId(0));
    const timer = setInterval(() => {
      const next = shown.current + 1;
      if (next > last) {
        setPlaying(false);
        return;
      }
      set.current(crashFrameId(next));
    }, 1000 / playRate);
    return () => clearInterval(timer);
  }, [playing, last]);
  const recordable =
    typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
      ? !!HTMLCanvasElement.prototype.captureStream
      : false;
  // A recording stops, with no download, when this result goes away or is replaced (another
  // study or a VTU shown in the same view).
  const recordingJob = useRef<{ cancelled: boolean }>(undefined);
  useEffect(
    () => () => {
      if (recordingJob.current) recordingJob.current.cancelled = true;
    },
    [fields],
  );
  const record = async () => {
    // One recording at a time: busy from the click, before anything is awaited.
    if (recordingJob.current) return;
    const job = { cancelled: false };
    recordingJob.current = job;
    try {
      await recordWith(job);
    } finally {
      if (recordingJob.current === job) recordingJob.current = undefined;
      if (!job.cancelled) setRecording(undefined);
    }
  };
  const recordWith = async (job: { cancelled: boolean }) => {
    setRecording('Starting the video…');
    const c = canvas();
    if (!c) {
      setVideoError('The 3D view is not available.');
      return;
    }
    setVideoError('');
    setPlaying(false);
    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!type) {
      setVideoError('This browser records no WebM video.');
      return;
    }
    const stream = c.captureStream(playRate);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      set.current(crashFrameId(0));
      await wait(300);
      if (job.cancelled) return;
      recorder.start();
      for (let k = 0; k <= last; k++) {
        if (job.cancelled) return;
        setRecording(`Recording frame ${k + 1} of ${last + 1}…`);
        set.current(crashFrameId(k));
        await wait(1000 / playRate);
      }
      // The last frame held for half a second.
      await wait(500);
      if (job.cancelled) return;
      recorder.stop();
      await stopped;
    } catch (e) {
      if (job.cancelled) return;
      setVideoError(`The video stopped: ${e instanceof Error ? e.message : String(e)}`);
      setRecording(undefined);
      return;
    } finally {
      if (recorder.state !== 'inactive') recorder.stop();
      for (const t of stream.getTracks()) t.stop();
    }
    if (job.cancelled) return;
    setRecording(undefined);
    const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${studyName.replace(/[^\w.-]+/g, '-') || 'crash'}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const t = frames[frame]?.time ?? 0;
  const partRows = (m?.parts ?? [])
    .map((p) => ({ ...p, body: fields.bodies[p.part] }))
    .sort((a, b) => b.energy - a.energy);
  const maxForce = m ? m.barrierForce.force.reduce((a, b) => Math.max(a, b), 0) : 0;
  const h = head?.measures;
  return (
    <fieldset
      className="simulation-group crash-result"
      aria-label={head ? 'Head impact result' : 'Crash result'}
    >
      <legend>{head ? 'Head impact result' : 'Crash result'}</legend>
      {h && (
        <table className="simulation-levels" aria-label="Head impact measures">
          <tbody>
            <tr>
              <th scope="row">HIC15</th>
              <td>
                {h.hic15
                  ? `${fmt(h.hic15.hic)} (${fmt(h.hic15.t1 * 1000)} to ${fmt(h.hic15.t2 * 1000)} ms)`
                  : '–'}
              </td>
            </tr>
            <tr>
              <th scope="row">Peak acceleration</th>
              <td>{fmt(h.peakG)} g resultant, CFC 1000</td>
            </tr>
            <tr>
              <th scope="row">Deflection</th>
              <td>{fmt(h.deflection)} mm after the first touch</td>
            </tr>
            <tr>
              <th scope="row">Rebound</th>
              <td>{fmt(-h.endSpeed)} m/s at the end</td>
            </tr>
            <tr>
              <th scope="row">Held</th>
              <td>{head.held} nodes of the vehicle (beyond the hold distance from the target)</td>
            </tr>
          </tbody>
        </table>
      )}
      {m && (
        <table className="simulation-levels" aria-label="Crash measures">
          <tbody>
            <tr>
              <th scope="row">Peak deceleration</th>
              <td>
                {fmt(m.peakG.cfc60)} g CFC 60 · {fmt(m.peakG.cfc180)} g CFC 180
              </td>
            </tr>
            <tr>
              <th scope="row">OLC</th>
              <td>
                {m.olc
                  ? `${fmt(m.olc.olcG)} g (free flight to ${fmt(m.olc.t1 * 1000)} ms, restrained to ${fmt(m.olc.t2 * 1000)} ms)`
                  : '–'}
              </td>
            </tr>
            <tr>
              <th scope="row">Crush</th>
              <td>
                {fmt(m.crush.max)} mm largest · {fmt(m.crush.end)} mm at the end
              </td>
            </tr>
            <tr>
              <th scope="row">Barrier</th>
              <td>
                {fmt(m.barrierImpulse / 1000)} kN·s impulse · {fmt(maxForce)} kN largest force
              </td>
            </tr>
            {m.intrusions.map((q) => (
              <tr key={q.name}>
                <th scope="row">Intrusion: {q.name}</th>
                <td>{fmt(q.max)} mm largest</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Added mass</th>
              <td>{(fields.addedMassShare * 100).toFixed(2)} % (mass scaling)</td>
            </tr>
          </tbody>
        </table>
      )}
      {partRows.length > 1 && (
        <table className="simulation-levels" aria-label="Energy by part">
          <thead>
            <tr>
              <th>Part</th>
              <th>Energy J</th>
              <th>Share %</th>
            </tr>
          </thead>
          <tbody>
            {partRows.map((p) => (
              <tr key={p.part}>
                <td>{p.body ? bodyName(p.body.bodyId) : `Part ${p.part + 1}`}</td>
                <td>{fmt(p.energy / 1000)}</td>
                <td>{(p.share * 100).toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {headWave && h && (
        <CrashChart
          title="Headform acceleration"
          unit="g"
          time={headWave.time}
          series={[
            { name: 'CFC 1000', color: 'var(--crash-series-1)', values: headWave.cfc1000 },
            {
              name: 'Unfiltered',
              color: 'var(--crash-series-2)',
              values: headWave.raw,
              faint: true,
            },
          ]}
          marker={t * 1000}
          spans={
            h.hic15
              ? [{ from: h.hic15.t1 * 1000, to: h.hic15.t2 * 1000, label: 'HIC15 window' }]
              : []
          }
        />
      )}
      {wave && m && (
        <>
          <CrashChart
            title="Deceleration at the accelerometer"
            unit="g"
            time={wave.time}
            series={[
              { name: 'CFC 60', color: 'var(--crash-series-1)', values: wave.cfc60 },
              { name: 'CFC 180', color: 'var(--crash-series-2)', values: wave.cfc180, faint: true },
            ]}
            marker={t * 1000}
            spans={
              m.olc
                ? [{ from: m.olc.t1 * 1000, to: m.olc.t2 * 1000, label: 'OLC restrained phase' }]
                : []
            }
          />
          <CrashChart
            title="Velocity along the travel"
            unit="m/s"
            time={wave.time}
            series={[{ name: 'Velocity', color: 'var(--crash-series-1)', values: wave.velocity }]}
            marker={t * 1000}
          />
        </>
      )}
      <label className="simulation-field">
        <span>
          Frame <small>{fmt(t * 1000)} ms</small>
        </span>
        <input
          aria-label="Crash frame"
          type="range"
          min={0}
          max={last}
          step={1}
          value={frame}
          disabled={!!recording}
          onChange={(e) => {
            setPlaying(false);
            setField(crashFrameId(Number(e.target.value)));
          }}
        />
      </label>
      <div className="simulation-actions">
        <button type="button" disabled={!!recording} onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          disabled={!recordable || !!recording}
          title={recordable ? undefined : 'This browser cannot record the 3D view.'}
          onClick={() => void record()}
        >
          Save video (WebM)
        </button>
      </div>
      <p className="simulation-note" role="status" aria-live="polite">
        {recording ??
          `Shown at true size, coloured by the equivalent plastic strain (0 to the run's largest); ${frames.length} frames over ${fmt(frames[last]!.time * 1000)} ms. Shells past the failure strain are gone from their frame.`}
      </p>
      {videoError && (
        <p className="simulation-error" role="alert">
          {videoError}
        </p>
      )}
    </fieldset>
  );
}

interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  faint?: boolean;
}

const W = 320;
const H = 140;
const pad = { left: 40, right: 8, top: 8, bottom: 22 };

/** A line chart of series over time (ms), one y axis, with a crosshair and its readout on hover. */
export function CrashChart({
  title,
  unit,
  time,
  series,
  marker,
  spans = [],
}: {
  title: string;
  unit: string;
  time: number[];
  series: ChartSeries[];
  /** The shown frame's time (ms). */
  marker?: number;
  spans?: { from: number; to: number; label: string }[];
}) {
  const [hover, setHover] = useState<number>();
  const t0 = time[0] ?? 0;
  const t1 = time.at(-1) ?? 1;
  let lo = 0,
    hi = 0;
  for (const s of series)
    for (const v of s.values) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (hi === lo) hi = lo + 1;
  const [yLo, yHi, ticks] = niceTicks(lo, hi);
  const x = (v: number) => pad.left + ((v - t0) / (t1 - t0 || 1)) * (W - pad.left - pad.right);
  const y = (v: number) => pad.top + ((yHi - v) / (yHi - yLo)) * (H - pad.top - pad.bottom);
  const xTicks = niceTicks(t0, t1)[2];
  const path = (values: number[]) =>
    values.map((v, k) => `${k ? 'L' : 'M'}${x(time[k]!).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const nearest = (px: number) => {
    const tv = t0 + ((px - pad.left) / (W - pad.left - pad.right)) * (t1 - t0);
    let best = 0;
    for (let k = 1; k < time.length; k++)
      if (Math.abs(time[k]! - tv) < Math.abs(time[best]! - tv)) best = k;
    return best;
  };
  return (
    <figure className="crash-chart" aria-label={title}>
      <figcaption>
        {title} <small>({unit})</small>
        {series.length > 1 && (
          <span className="crash-chart-legend">
            {series.map((s) => (
              <span key={s.name}>
                <span
                  className="crash-chart-key"
                  style={{ background: s.color, opacity: s.faint ? 0.6 : 1 }}
                />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${title}: ${series.map((s) => `${s.name} from ${fmt(Math.min(...s.values))} to ${fmt(Math.max(...s.values))} ${unit}`).join('; ')}, over ${fmt(t1)} ms`}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(nearest(((e.clientX - r.left) / r.width) * W));
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        {spans.map((s) => (
          <rect
            key={s.label}
            className="crash-chart-span"
            x={x(s.from)}
            y={pad.top}
            width={Math.max(0, x(s.to) - x(s.from))}
            height={H - pad.top - pad.bottom}
          >
            <title>{s.label}</title>
          </rect>
        ))}
        {ticks.map((v) => (
          <g key={`y${v}`}>
            <line
              className="crash-chart-grid"
              x1={pad.left}
              x2={W - pad.right}
              y1={y(v)}
              y2={y(v)}
            />
            <text className="crash-chart-tick" x={pad.left - 4} y={y(v) + 3} textAnchor="end">
              {tickText(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text
            key={`x${v}`}
            className="crash-chart-tick"
            x={x(v)}
            y={H - pad.bottom + 12}
            textAnchor="middle"
          >
            {tickText(v)}
          </text>
        ))}
        <text className="crash-chart-tick" x={W - pad.right} y={H - 2} textAnchor="end">
          ms
        </text>
        {series.map((s) => (
          <path
            key={s.name}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.faint ? 1.5 : 2}
            strokeOpacity={s.faint ? 0.6 : 1}
            strokeLinejoin="round"
          />
        ))}
        {marker !== undefined && marker >= t0 && marker <= t1 && (
          <line
            className="crash-chart-marker"
            x1={x(marker)}
            x2={x(marker)}
            y1={pad.top}
            y2={H - pad.bottom}
          />
        )}
        {hover !== undefined && (
          <g>
            <line
              className="crash-chart-cross"
              x1={x(time[hover]!)}
              x2={x(time[hover]!)}
              y1={pad.top}
              y2={H - pad.bottom}
            />
            {series.map((s) => (
              <circle
                key={s.name}
                cx={x(time[hover]!)}
                cy={y(s.values[hover]!)}
                r={4}
                fill={s.color}
                className="crash-chart-dot"
              />
            ))}
          </g>
        )}
      </svg>
      <p className="crash-chart-readout" aria-live="polite">
        {hover !== undefined
          ? `${fmt(time[hover])} ms: ${series.map((s) => `${s.name} ${fmt(s.values[hover])} ${unit}`).join(', ')}`
          : ' '}
      </p>
    </figure>
  );
}

/** Round ends and about five ticks between them. */
function niceTicks(lo: number, hi: number): [number, number, number[]] {
  const span = hi - lo || 1;
  const raw = span / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? 10 * mag;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return [a, b, ticks];
}
const tickText = (v: number) => String(Number(v.toPrecision(4)));
