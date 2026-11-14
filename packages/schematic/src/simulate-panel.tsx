import { useEffect, useMemo, useRef, useState } from 'react';
import { Section } from '@editor-platform/editor-ui';
import { schematicNets, type SchematicDocument } from '@editor-platform/schematic-core';
import type { SchematicState } from './controller';
import { Choice, Field, useSettle } from './fields';
import {
  SchematicSimJobs,
  schematicSimAt,
  schematicSimCsv,
  schematicSimDefaults,
  schematicSimGpio,
  type SchematicSimPin,
  type SchematicSimResult,
  type SchematicSimSettings,
} from './simulate';

/**
 * SL5b: the "Simulation" section. Its settings and results are the screen's (never saved in the
 * document); a result is shown only while the drawing is the one it was calculated for.
 */
export interface SchematicSimulation {
  settings: SchematicSimSettings;
  /** A value, or an update of the latest settings (several drafts may commit in one settle). */
  setSettings(
    s: SchematicSimSettings | ((previous: SchematicSimSettings) => SchematicSimSettings),
  ): void;
  running: boolean;
  run(): void;
  cancel(): void;
  /** The result for the drawing as it is now. */
  result?: SchematicSimResult;
  /** A result for an earlier drawing. */
  stale: boolean;
  error?: string;
  time: number;
  setTime(t: number): void;
  probes: string[];
  setProbes(p: string[]): void;
}

/**
 * What the canvas draws from a result at the time cursor: a voltage tag per net (at its labels,
 * or its first wire's start when it has none) and each LED's brightness (0–1) and colour.
 */
export interface SchematicSimOverlay {
  tags: { key: string; net: string; at: readonly [number, number]; text: string }[];
  leds: { id: string; at: readonly [number, number]; glow: number; color: string }[];
}

/** Full brightness at this LED current (A). */
const ledFull = 0.01;

export function useSchematicSimulation(
  state: SchematicState,
  jobs?: () => SchematicSimJobs,
): SchematicSimulation {
  const owner = useRef<SchematicSimJobs | undefined>(undefined);
  useEffect(() => () => owner.current?.dispose(), []);
  const [settings, setSettings] = useState(schematicSimDefaults);
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<{
    hash: string;
    /** The settings the answer was calculated with (as JSON). */
    settings: string;
    result?: SchematicSimResult;
    error?: string;
  }>();
  const [time, setTime] = useState(0);
  const [probes, setProbes] = useState<string[]>([]);
  // Run is asked for, then started after the render that follows: inputs settled by the click
  // (a committed Stop or part value) are in the settings and the drawing it uses.
  const [request, setRequest] = useState(0);
  const run = () => setRequest((n) => n + 1);
  const start = () => {
    owner.current ??= jobs ? jobs() : new SchematicSimJobs();
    const hash = state.hash;
    const asked = JSON.stringify(settings);
    setRunning(true);
    void owner.current.run(state.content, settings).then((r) => {
      if (r.status === 'failed' && r.message === 'cancelled') return;
      setRunning(false);
      if (r.status === 'done') {
        setAnswer({ hash, settings: asked, result: r.result });
        setTime(r.result.times.at(-1) ?? 0);
      } else
        setAnswer({
          hash,
          settings: asked,
          error:
            r.status === 'refused'
              ? [r.code, r.node ?? r.element].filter(Boolean).join(' · ')
              : r.message,
        });
    });
  };
  const starter = useRef(start);
  useEffect(() => {
    starter.current = start;
  });
  useEffect(() => {
    if (request) starter.current();
  }, [request]);
  const cancel = () => {
    owner.current?.cancel();
    setRunning(false);
  };
  // A result belongs to the drawing and the settings it was calculated with.
  const current =
    answer?.hash === state.hash && answer.settings === JSON.stringify(settings)
      ? answer
      : undefined;
  return {
    settings,
    setSettings,
    running,
    run,
    cancel,
    result: current?.result,
    error: current?.error,
    stale: !!answer && !current,
    time,
    setTime,
    probes,
    setProbes,
  };
}

const ledColors: Record<string, string> = {
  red: '#ff3b30',
  green: '#34c759',
  blue: '#0a84ff',
  yellow: '#ffd60a',
  white: '#f5f5f5',
};

export function schematicSimOverlay(
  doc: SchematicDocument,
  result: SchematicSimResult,
  time: number,
): SchematicSimOverlay {
  const tags: SchematicSimOverlay['tags'] = [];
  const wires = new Map(doc.wires.map((w) => [w.id, w]));
  for (const n of schematicNets(doc)) {
    const v = result.voltages[n.name];
    if (!v || n.power) continue;
    const text = schematicSiText(schematicSimAt(result.times, v, time), 'V');
    const labels = doc.labels.filter((l) => n.items.includes(l.id));
    if (labels.length)
      for (const l of labels) tags.push({ key: l.id, net: n.name, at: l.at, text });
    else {
      const w = n.items.map((id) => wires.get(id)).find(Boolean);
      if (w) tags.push({ key: w.id, net: n.name, at: w.points[0], text });
    }
  }
  const leds: SchematicSimOverlay['leds'] = [];
  for (const p of doc.parts)
    if (p.model?.kind === 'led' && result.currents[p.id]) {
      const i = schematicSimAt(result.times, result.currents[p.id], time);
      leds.push({
        id: p.id,
        at: p.at,
        glow: Math.max(0, Math.min(1, i / ledFull)),
        color: ledColors[String(p.model.params.color)] ?? ledColors.red,
      });
    }
  return { tags, leds };
}

/** Volts, amps and seconds with an SI prefix: 3.3 V, 2.51 mA, 1.2 ms. */
export function schematicSiText(value: number, unit: string): string {
  if (!Number.isFinite(value)) return `– ${unit}`;
  const a = Math.abs(value);
  const [scale, prefix] =
    a >= 1 || a === 0 ? [1, ''] : a >= 1e-3 ? [1e3, 'm'] : a >= 1e-6 ? [1e6, 'µ'] : [1e9, 'n'];
  const v = value * scale;
  return `${Math.abs(v) < 1e-9 ? '0' : Number(v.toPrecision(3))} ${prefix}${unit}`;
}

const ms = (s: number | undefined) =>
  s === undefined ? '' : String(Number((s * 1e3).toPrecision(6)));
/** A time field in ms: blank is none; anything else must be a number ≥ 0. */
const readMs = (v: string): number | undefined | false => {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n / 1e3 : false;
};

const pinChoices = [
  { value: '', label: 'Not a pin' },
  { value: 'high', label: 'Output high' },
  { value: 'low', label: 'Output low' },
  { value: 'up', label: 'Input, pull-up' },
  { value: 'down', label: 'Input, pull-down' },
  { value: 'none', label: 'Input, no pull' },
];
const pinValue = (p: SchematicSimPin | undefined) =>
  !p ? '' : p.kind === 'output' ? (p.high ? 'high' : 'low') : p.pull;

export function SimulationPanel({
  state,
  sim,
}: {
  state: SchematicState;
  sim: SchematicSimulation;
}) {
  const settle = useSettle();
  const doc = state.content;
  const nets = useMemo(() => schematicNets(doc), [doc]);
  const pinNets = nets.filter((n) => n.named && !n.power).map((n) => n.name);
  const switches = doc.parts.filter((p) => p.model?.kind === 'switch');
  const s = sim.settings;
  // Every change updates the latest settings: several drafts may commit in one settle.
  const update = (f: (p: SchematicSimSettings) => Partial<SchematicSimSettings>) =>
    sim.setSettings((p) => ({ ...p, ...f(p) }));
  const set = (patch: Partial<SchematicSimSettings>) => update(() => patch);
  const own = <T,>(o: Record<string, T>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
  const pinOf = (net: string) => own(s.pins, net);
  // Own properties only (a net may be called `__proto__`): rebuilt, never assigned.
  const withKey = <T,>(o: Record<string, T>, k: string, v: T | undefined) =>
    Object.fromEntries([
      ...Object.entries(o).filter(([x]) => x !== k),
      ...(v === undefined ? [] : [[k, v] as const]),
    ]) as Record<string, T>;
  const setPin = (net: string, v: string) =>
    update((p) => {
      const old = own(p.pins, net);
      const pin: SchematicSimPin | undefined =
        v === ''
          ? undefined
          : v === 'high' || v === 'low'
            ? {
                kind: 'output',
                high: v === 'high',
                ...(old?.kind === 'output' && old.toggleAt !== undefined
                  ? { toggleAt: old.toggleAt }
                  : {}),
              }
            : { kind: 'input', pull: v as 'up' | 'down' | 'none' };
      return { pins: withKey(p.pins, net, pin) };
    });
  const r = sim.result;
  // Probes of nets the result has (a renamed or deleted net drops out).
  const probes = r ? sim.probes.filter((p) => Object.hasOwn(r.voltages, p)) : [];
  const tran = s.mode === 'tran';
  const at = (v: number[]) => (r ? schematicSimAt(r.times, v, sim.time) : Number.NaN);
  const download = () => {
    if (!r) return;
    const csv = schematicSimCsv(
      r,
      probes.length ? probes : Object.keys(r.voltages),
      doc.parts
        .filter((p) => r.currents[p.id])
        .sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true })),
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${doc.sheet.title || 'schematic'}-${s.mode}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  return (
    <Section title="Simulation">
      <div className="sch-sim" data-testid="sch-sim">
        <Choice
          label="Analysis"
          value={s.mode}
          options={[
            { value: 'dc', label: 'DC operating point' },
            { value: 'tran', label: 'Transient' },
          ]}
          // Changes that remove inputs (another mode, a pin no longer an output) settle them first.
          onChange={(v) => settle(() => set({ mode: v as 'dc' | 'tran' }))}
        />
        {tran && (
          <Field
            readOnly={false}
            label="Stop (ms)"
            value={ms(s.stop)}
            onCommit={(v) => {
              const t = readMs(v);
              if (!t) return false;
              set({ stop: t });
              return true;
            }}
          />
        )}
        {pinNets.length > 0 && (
          <fieldset className="sch-sim-group" aria-label="GPIO pins">
            <legend>GPIO pins ({schematicSiText(3.3, 'V')})</legend>
            {pinNets.map((net) => {
              const pin = pinOf(net);
              return (
                <div key={net} className="sch-sim-row">
                  <Choice
                    label={net}
                    value={pinValue(pin)}
                    options={pinChoices}
                    onChange={(v) => settle(() => setPin(net, v))}
                  />
                  {tran && pin?.kind === 'output' && (
                    <Field
                      readOnly={false}
                      label={`${net} toggles at (ms)`}
                      value={ms(pin.toggleAt)}
                      onCommit={(v) => {
                        const t = readMs(v);
                        if (t === false) return false;
                        update((p) => {
                          const cur = own(p.pins, net);
                          if (cur?.kind !== 'output') return {};
                          const { toggleAt: _t, ...rest } = cur;
                          return {
                            pins: withKey(
                              p.pins,
                              net,
                              t === undefined ? rest : { ...rest, toggleAt: t },
                            ),
                          };
                        });
                        return true;
                      }}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        {switches.length > 0 && (
          <fieldset className="sch-sim-group" aria-label="Switches">
            <legend>Switches</legend>
            {switches.map((p) => {
              const press = own(s.presses, p.id) ?? { pressed: false };
              const put = (patch: Partial<typeof press>) =>
                update((q) => {
                  const next: { pressed: boolean; from?: number; to?: number } = {
                    ...(own(q.presses, p.id) ?? { pressed: false }),
                    ...patch,
                  };
                  if (next.from === undefined) delete next.from;
                  if (next.to === undefined) delete next.to;
                  return { presses: withKey(q.presses, p.id, next) };
                });
              return tran ? (
                <div key={p.id} className="sch-sim-row">
                  {(['from', 'to'] as const).map((k) => (
                    <Field
                      key={k}
                      readOnly={false}
                      label={`${p.ref} ${k === 'from' ? 'pressed at' : 'released at'} (ms)`}
                      value={ms(press[k])}
                      onCommit={(v) => {
                        const t = readMs(v);
                        if (t === false) return false;
                        put({ [k]: t });
                        return true;
                      }}
                    />
                  ))}
                </div>
              ) : (
                <label key={p.id} className="sch-check">
                  <input
                    type="checkbox"
                    aria-label={`${p.ref} pressed`}
                    checked={press.pressed}
                    onChange={(e) => put({ pressed: e.target.checked })}
                  />
                  {p.ref} pressed
                </label>
              );
            })}
          </fieldset>
        )}
        <div className="sch-sim-actions">
          {sim.running ? (
            <button type="button" onClick={sim.cancel}>
              Stop
            </button>
          ) : (
            <button type="button" onClick={() => settle(sim.run)}>
              Run
            </button>
          )}
          {r && (
            <button type="button" onClick={download}>
              Download CSV
            </button>
          )}
        </div>
        {sim.running && <p role="status">Calculating…</p>}
        {sim.stale && !sim.running && (
          <p className="sch-empty">
            The drawing or the settings changed since the last run: run again.
          </p>
        )}
        {sim.error && (
          <p className="sch-error" role="alert" data-testid="sch-sim-error">
            The circuit was not calculated ({sim.error}).
          </p>
        )}
        {r && r.left.length > 0 && (
          <p className="sch-empty" data-testid="sch-sim-left">
            Not simulated:{' '}
            {r.left
              .map((l) => `${l.ref} (${l.reason === 'no-model' ? 'no model' : 'model pins'})`)
              .join(', ')}
            .
          </p>
        )}
        {r && r.mode === 'tran' && (
          <label className="ep-field">
            Time {schematicSiText(sim.time, 's')}
            <input
              type="range"
              aria-label="Time"
              min={0}
              max={r.times.at(-1)}
              step={(r.times.at(-1) ?? 1) / 1000}
              value={sim.time}
              onChange={(e) => sim.setTime(Number(e.target.value))}
            />
          </label>
        )}
        {r && (
          <>
            <table className="sch-sim-table" data-testid="sch-sim-voltages">
              <caption>Net voltages</caption>
              <tbody>
                {Object.entries(r.voltages).map(([net, v]) => (
                  <tr key={net} data-net={net}>
                    <th scope="row">
                      {r.mode === 'tran' ? (
                        <label className="sch-check">
                          <input
                            type="checkbox"
                            aria-label={`Probe ${net}`}
                            checked={sim.probes.includes(net)}
                            onChange={(e) =>
                              sim.setProbes(
                                e.target.checked
                                  ? [...sim.probes, net]
                                  : sim.probes.filter((p) => p !== net),
                              )
                            }
                          />
                          {net}
                        </label>
                      ) : (
                        net
                      )}
                    </th>
                    <td>{schematicSiText(at(v), 'V')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="sch-sim-table" data-testid="sch-sim-currents">
              <caption>Part currents</caption>
              <tbody>
                {doc.parts
                  .filter((p) => r.currents[p.id])
                  .sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
                  .map((p) => (
                    <tr key={p.id} data-part={p.ref}>
                      <th scope="row">{p.ref}</th>
                      <td>{schematicSiText(at(r.currents[p.id]), 'A')}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {Object.keys(r.inputs).length > 0 && (
              <ul className="sch-list" aria-label="Inputs read" data-testid="sch-sim-inputs">
                {Object.keys(r.inputs).map((net) => (
                  // Read from the voltage at the cursor, as the table and the sheet show it.
                  <li key={net} data-net={net}>
                    {net} reads{' '}
                    {at(r.voltages[net] ?? []) > schematicSimGpio.thresholdVolts ? 'high' : 'low'}
                  </li>
                ))}
              </ul>
            )}
            {r.mode === 'tran' && probes.length > 0 && (
              <Waveform result={r} probes={probes} time={sim.time} />
            )}
          </>
        )}
      </div>
    </Section>
  );
}

const colors = ['#0969da', '#cf222e', '#1a7f37', '#8250df', '#bc4c00', '#0a3069'];

/** The probed nets' voltages over time, with the time cursor. */
function Waveform({
  result,
  probes,
  time,
}: {
  result: SchematicSimResult;
  probes: string[];
  time: number;
}) {
  const w = 240;
  const h = 120;
  const end = result.times.at(-1) || 1;
  // A loop, not a spread: a long run has more samples than a call takes arguments.
  let lo = 0;
  let hi = -Infinity;
  for (const p of probes)
    for (const v of result.voltages[p] ?? [])
      if (Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  hi = Math.max(hi, lo + 1e-3);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (t: number) => (t / end) * w;
  const y = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  return (
    <figure className="sch-sim-wave">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`Waveform of ${probes.join(', ')}`}
        data-testid="sch-sim-wave"
      >
        <rect x={0} y={0} width={w} height={h} fill="#f6f8fa" />
        <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="#d0d7de" strokeWidth={0.5} />
        {probes.map((p, k) => (
          <polyline
            key={p}
            data-net={p}
            points={result.times
              .map((t, i) => `${x(t)},${y(result.voltages[p]?.[i] ?? 0)}`)
              .join(' ')}
            fill="none"
            stroke={colors[k % colors.length]}
            strokeWidth={1.2}
          />
        ))}
        <line
          x1={x(time)}
          x2={x(time)}
          y1={0}
          y2={h}
          stroke="#57606a"
          strokeDasharray="2 2"
          strokeWidth={0.6}
        />
      </svg>
      <figcaption>
        {probes.map((p, k) => (
          <span key={p} style={{ color: colors[k % colors.length] }}>
            {p}{' '}
          </span>
        ))}
        · {schematicSiText(lo, 'V')} to {schematicSiText(hi, 'V')} · 0 to{' '}
        {schematicSiText(end, 's')}
      </figcaption>
    </figure>
  );
}
