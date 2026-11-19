import { useMemo, useRef } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { Section } from '@editor-platform/editor-ui';
import {
  isLadderDocument,
  ladderFromPlcopen,
  ladderStarter,
  validateLadder,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import { LadderDiagramView } from '@editor-platform/ladder';
import {
  factoryActuatorKinds,
  factoryActuatorSignals,
  factorySensorKinds,
  factorySensorSignals,
  freshFactoryId,
  type FactoryActuator,
  type FactoryControl,
  type FactoryDocument,
  type FactoryObjectKind,
  type FactoryRunResult,
  type FactorySensor,
} from '@editor-platform/factory-core';
import type { FactoryController } from './controller';
import { Choice, Field, useSettle } from './fields';

/**
 * FT6 (docs/cad/factory-twin.md): the PLC control of the model. The program is read from a
 * PLCopen XML file or a ladder JSON file (as the ladder Editor exports them); the wiring rows
 * join BOOL variables to the objects' sensors and actuators. Every change is one operation
 * (`setControl`), checked as a whole.
 */

/** A ladder program from a file's text: PLCopen XML or ladder JSON (schema 1). */
export function readLadderProgram(text: string): LadderDocument {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return ladderFromPlcopen(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('program-unreadable');
  }
  // A Playground artifact export keeps the program under `draft.content`; a bare record under
  // `content`.
  const rec = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  if (rec(value) && rec(value.draft) && 'content' in value.draft) value = value.draft.content;
  else if (rec(value) && 'content' in value) value = value.content;
  let errors: ReturnType<typeof validateLadder>;
  try {
    errors = validateLadder(value).filter((d) => d.severity === 'error');
  } catch {
    throw new Error('program-invalid:malformed');
  }
  if (errors.length || !isLadderDocument(value))
    throw new Error(`program-invalid:${errors[0]?.code ?? 'shape'}`);
  return value;
}

const applies = (
  kinds: Readonly<Record<string, readonly FactoryObjectKind[]>>,
  signal: string,
  kind: FactoryObjectKind,
) => kinds[signal]!.includes(kind);

const signalLabels: Record<string, string> = {
  occupied: 'Occupied',
  ready: 'Part ready',
  blocked: 'Blocked',
  full: 'Full',
  failed: 'Failed',
  run: 'Motor run',
  release: 'Release',
  admit: 'Admit',
};

export function ControlSection({
  controller,
  doc,
  locked,
}: {
  controller: FactoryController;
  doc: FactoryDocument;
  locked: boolean;
}) {
  const settle = useSettle();
  const file = useRef<HTMLInputElement>(null);
  const control = doc.control;
  const set = (next: FactoryControl | null) =>
    !controller.apply({ type: 'setControl', control: next });
  const vars = (role: 'input' | 'output') =>
    (control?.program.variables ?? [])
      .filter((v) => v.type === 'BOOL' && v.role === role)
      .map((v) => v.name);
  const load = (text: string) => {
    let program: LadderDocument;
    try {
      program = readLadderProgram(text);
    } catch (error) {
      const [code, detail] = (error instanceof Error ? error.message : 'program').split(':');
      const known = code === 'program-unreadable' || code === 'program-invalid';
      return controller.notify({
        code: known ? code! : 'program-invalid',
        message: known ? detail : error instanceof Error ? error.message : undefined,
      });
    }
    // The file is read asynchronously: keep the wiring as it is now, not as it was when the read
    // began.
    const now = controller.state.content.control;
    return set({ ...(now ?? { sensors: [], actuators: [] }), program }) ? undefined : 'refused';
  };
  const wiring = (
    what: 'sensors' | 'actuators',
    rows: (FactorySensor | FactoryActuator)[],
    signals: readonly string[],
    kinds: Readonly<Record<string, readonly FactoryObjectKind[]>>,
    role: 'input' | 'output',
  ) => {
    const put = (i: number, row: FactorySensor | FactoryActuator) => {
      const list = [...rows];
      list[i] = row;
      return set({ ...control!, [what]: list });
    };
    const names = vars(role);
    return (
      <ul className="fac-list" data-testid={`fac-${what}`}>
        {rows.map((w, i) => {
          const kind = doc.objects.find((o) => o.id === w.objectId)?.kind;
          return (
            <li key={w.id} className="fac-calendar fac-wire">
              <Choice
                label={`Object of ${w.id}`}
                value={w.objectId}
                disabled={locked}
                options={doc.objects
                  .filter((o) => applies(kinds, w.signal, o.kind) || o.id === w.objectId)
                  .map((o) => ({ value: o.id, label: o.name || o.id }))}
                onChange={(v) => settle(() => put(i, { ...w, objectId: v }))}
              />
              <Choice
                label={`Signal of ${w.id}`}
                value={w.signal}
                disabled={locked}
                options={signals
                  .filter((s) => !kind || applies(kinds, s, kind) || s === w.signal)
                  .map((s) => ({ value: s, label: signalLabels[s] ?? s }))}
                onChange={(v) => settle(() => put(i, { ...w, signal: v } as typeof w))}
              />
              <Choice
                label={`Variable of ${w.id}`}
                value={w.variable}
                disabled={locked}
                options={names.includes(w.variable) ? names : [w.variable, ...names]}
                onChange={(v) => settle(() => put(i, { ...w, variable: v }))}
              />
              <button
                disabled={locked}
                aria-label={`Remove ${w.id}`}
                onClick={() =>
                  settle(() => set({ ...control!, [what]: rows.filter((_, j) => j !== i) }))
                }
              >
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    );
  };
  const add = (what: 'sensors' | 'actuators') => {
    const c = control!;
    const role = what === 'sensors' ? 'input' : 'output';
    const used = new Set(c.sensors.map((s) => s.variable.toUpperCase()));
    const variable = vars(role).find((n) => role === 'output' || !used.has(n.toUpperCase()));
    if (!variable)
      return controller.notify({
        code: 'no-variable',
        message: `the program has no free BOOL ${role} variable`,
      });
    const kinds = what === 'sensors' ? factorySensorKinds : factoryActuatorKinds;
    const signals = what === 'sensors' ? factorySensorSignals : factoryActuatorSignals;
    const taken = new Set(c[what].map((w) => `${w.objectId}\u0000${w.signal}`));
    for (const o of doc.objects)
      for (const signal of signals)
        if (applies(kinds, signal, o.kind) && !taken.has(`${o.id}\u0000${signal}`)) {
          const id = freshFactoryId(doc, what === 'sensors' ? 'sensor' : 'actuator');
          return set({ ...c, [what]: [...c[what], { id, objectId: o.id, signal, variable }] })
            ? undefined
            : 'refused';
        }
    return controller.notify({ code: 'no-signal', message: 'every signal is wired already' });
  };
  return (
    <Section title="PLC control">
      <div data-testid="fac-control">
        {!control ? (
          <>
            <p className="fac-empty">No PLC. The flow runs without control.</p>
            <button
              disabled={locked}
              onClick={() =>
                settle(() => set({ program: ladderStarter(), sensors: [], actuators: [] }))
              }
            >
              Add PLC
            </button>
          </>
        ) : (
          <>
            <p className="fac-empty" data-testid="fac-program">
              {control.program.name}: {control.program.variables.length} variables,{' '}
              {control.program.rungs.length} rungs, scan {control.program.scanMs} ms
            </p>
            <div className="fac-row">
              <button disabled={locked} onClick={() => file.current?.click()}>
                <Upload size={14} /> Import program
              </button>
              <button
                disabled={locked}
                aria-label="Remove PLC"
                onClick={() => settle(() => set(null))}
              >
                <Trash2 size={14} /> Remove PLC
              </button>
            </div>
            <input
              ref={file}
              type="file"
              accept=".xml,.json,application/xml,application/json"
              aria-label="Ladder program file"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) {
                  const text = await f.text();
                  settle(() => void load(text));
                }
              }}
            />
            <Field
              readOnly={locked}
              label="Stall after (s)"
              value={String((control.stallMs ?? 60_000) / 1000)}
              onCommit={(v) => {
                const n = Number(v);
                return (
                  v.trim() !== '' &&
                  Number.isFinite(n) &&
                  n > 0 &&
                  set({ ...control, stallMs: Math.round(n * 1000) })
                );
              }}
            />
            <h4 className="fac-sub">Sensors (inputs)</h4>
            {wiring('sensors', control.sensors, factorySensorSignals, factorySensorKinds, 'input')}
            <button disabled={locked} onClick={() => settle(() => void add('sensors'))}>
              Add sensor
            </button>
            <h4 className="fac-sub">Actuators (outputs)</h4>
            {wiring(
              'actuators',
              control.actuators,
              factoryActuatorSignals,
              factoryActuatorKinds,
              'output',
            )}
            <button disabled={locked} onClick={() => settle(() => void add('actuators'))}>
              Add actuator
            </button>
          </>
        )}
      </div>
    </Section>
  );
}

const secs = (ms: number) => +(ms / 1000).toFixed(3);

/** The PLC part of a run's result: scans, stalls and the program as it was at the last scan. */
export function ControlResults({
  doc,
  result,
  stale,
}: {
  doc: FactoryDocument;
  result: FactoryRunResult;
  /** The model changed since the run: its program may differ, so the diagram is not drawn. */
  stale?: boolean;
}) {
  const c = result.control;
  const program = doc.control?.program;
  const names = useMemo(() => new Map(doc.objects.map((o) => [o.id, o.name || o.id])), [doc]);
  if (!c) return null;
  return (
    <div className="fac-control-result" data-testid="fac-plc">
      {c.stalls.length > 0 && (
        <p className="fac-stale" role="alert" data-testid="fac-stall">
          The PLC stopped the flow:{' '}
          {c.stalls
            .map(
              (s) =>
                `${names.get(s.objectId) ?? s.objectId} held by ${signalLabels[s.signal]!.toLowerCase()} off since ${secs(s.sinceMs)} s`,
            )
            .join('; ')}
          . No part moved after {secs(c.lastMoveMs)} s.
        </p>
      )}
      <p className="fac-empty" data-testid="fac-plc-summary">
        {c.scans} scans, last part moved at {secs(c.lastMoveMs)} s
        {c.stalls.length ? '' : ', no stall'}.
      </p>
      {program && !stale && (
        <div className="fac-ladder" data-testid="fac-ladder">
          <LadderDiagramView doc={program} name={program.name} ladder={c.state} power={c.power} />
        </div>
      )}
    </div>
  );
}
