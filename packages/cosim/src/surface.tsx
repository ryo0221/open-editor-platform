import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Play, Plus, Redo2, RotateCcw, Square, StepForward, Trash2, Undo2 } from 'lucide-react';
import {
  EditorHistoryContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import type { CosimBinding, CosimFrame, CosimSourceRef } from '@editor-platform/cosim-core';
import { LadderDiagramView } from '@editor-platform/ladder';
import {
  SchematicSheetView,
  schematicSimOverlay,
  schematicSiText,
  type SchematicSimResult,
} from '@editor-platform/schematic';
import type { SchematicDocument } from '@editor-platform/schematic-core';
import {
  cosimSwitches,
  cosimVariables,
  type CosimController,
  type CosimNotice,
  type CosimSource,
  type CosimSourceEntry,
  type CosimSurfaceState,
} from './controller';
import { Choice, Field, useSettle } from './fields';

const messages: Record<string, string> = {
  'permission-denied': 'You can only view this co-simulation.',
  running: 'Stop the simulation to edit it.',
  'sources-missing': 'Choose a schematic and a ladder program first.',
  loading: 'The chosen versions are still being read.',
  'cosim-variable': 'A binding names a variable that is not a BOOL input or output of the program.',
  'cosim-net': 'A binding names a net the calculation does not use, ground, or a net bound twice.',
  'ladder-invalid': 'The ladder program has errors.',
  'no-free-variable': 'Every variable of that kind is bound already.',
  'no-free-net': 'Every net is bound already, or the schematic cannot be calculated.',
  'binding-duplicate': 'A variable or a net is bound twice.',
  'source-missing': 'That version is gone or changed.',
  'source-invalid': 'That version is not a valid document.',
  'input-value': 'Only an unbound BOOL input can be set here.',
  'cosim-base-mismatch': 'The document changed; try again.',
};
export const cosimNoticeText = (n: CosimNotice) =>
  `${messages[n.code] ?? n.code}${n.variable ? ` (${n.variable})` : ''}${n.net ? ` (${n.net})` : ''}`;

export function useCosimState(controller: CosimController): CosimSurfaceState {
  return useSyncExternalStore(
    (l) => controller.subscribe(l),
    () => controller.state,
  );
}

/** The overlay the schematic sheet draws for one co-simulation frame (net voltages, LED glow). */
export function cosimOverlay(doc: SchematicDocument, frame: CosimFrame) {
  const one = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, [v]]));
  const result: SchematicSimResult = {
    mode: 'tran',
    times: [frame.time],
    voltages: one(frame.voltages),
    currents: one(frame.currents),
    inputs: {},
    left: [],
  };
  return schematicSimOverlay(doc, result, frame.time);
}

export function CosimSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
}: {
  controller: CosimController;
  name: string;
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
}) {
  const state = useCosimState(controller);
  const settle = useSettle();
  const history = useContext(EditorHistoryContext);
  const running = state.run.running;
  const locked = state.readOnly || running;
  const why = state.readOnly ? 'Read only' : 'Stop to edit';
  const { schematic, ladder } = state.loaded;
  const frame = state.run.frame;
  useEffect(() => {
    void controller.load();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      // Like the toolbar's Undo/Redo: not while read only or running (stop, then edit).
      if (!history || locked) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, locked]);
  const overlay = useMemo(
    () => (schematic && frame ? cosimOverlay(schematic, frame) : undefined),
    [schematic, frame],
  );
  const ladderState = controller.ladderState();
  const time = frame ? frame.time : 0;
  return (
    <div className="cosim-surface" data-testid="cosim-surface">
      <EditorLayout
        viewKey="cosim"
        leftLabel="Setup"
        inspectorLabel="Run"
        toolbar={
          <Toolbar label="Co-simulation tools">
            {!hostHistory && (
              <>
                <IconButton
                  icon={Undo2}
                  label="Undo"
                  disabled={locked}
                  reason={why}
                  onClick={() => settle(() => onUndo?.())}
                />
                <IconButton
                  icon={Redo2}
                  label="Redo"
                  disabled={locked}
                  reason={why}
                  onClick={() => settle(() => onRedo?.())}
                />
              </>
            )}
            {running ? (
              <IconButton icon={Square} label="Stop" onClick={() => controller.stop()} />
            ) : (
              <IconButton
                icon={Play}
                label="Run"
                disabled={state.loading || !schematic || !ladder}
                reason={state.loading ? 'Loading' : 'Choose a schematic and a ladder program'}
                onClick={() => settle(() => controller.start())}
              />
            )}
            <IconButton
              icon={StepForward}
              label="One scan"
              disabled={running || state.loading || !schematic || !ladder}
              reason={
                running
                  ? 'Running'
                  : state.loading
                    ? 'Loading'
                    : 'Choose a schematic and a ladder program'
              }
              onClick={() => settle(() => controller.step())}
            />
            <IconButton icon={RotateCcw} label="Reset" onClick={() => controller.reset()} />
          </Toolbar>
        }
        left={
          <div className="cosim-panel">
            <Section title="Co-simulation">
              <Field
                readOnly={locked}
                label="Name"
                value={state.content.name}
                onCommit={(text) => !controller.setName(text)}
              />
            </Section>
            <Section title="Sources">
              <SourcePicker
                label="Schematic"
                source={controller.sources.schematics}
                value={state.content.schematic}
                error={state.loaded.errors.schematic ?? state.loaded.circuitError}
                disabled={locked}
                onChange={(ref) => settle(() => controller.setSource('schematic', ref))}
              />
              <SourcePicker
                label="Ladder program"
                source={controller.sources.ladders}
                value={state.content.ladder}
                error={state.loaded.errors.ladder}
                disabled={locked}
                onChange={(ref) => settle(() => controller.setSource('ladder', ref))}
              />
            </Section>
            <Bindings controller={controller} state={state} locked={locked} />
          </div>
        }
        inspector={<RunPanel controller={controller} state={state} />}
        status={
          <span className="cosim-status" data-testid="cosim-status">
            {state.loading ? 'Loading' : running ? 'Running' : 'Stopped'} · scan {frame?.scan ?? 0}{' '}
            · {schematicSiText(time, 's')}
            {ladder && ` · ${ladder.scanMs} ms per scan`}
            {state.notice && (
              <span className="cosim-notice" role="alert" data-testid="cosim-notice">
                {' '}
                · {cosimNoticeText(state.notice)}
              </span>
            )}
          </span>
        }
        {...layout}
      >
        <div className="cosim-main">
          <div className="cosim-sheet" data-testid="cosim-sheet" aria-label={`${name} schematic`}>
            {schematic ? (
              <SchematicSheetView doc={schematic} overlay={overlay} />
            ) : (
              <p className="cosim-empty">Choose a saved schematic version.</p>
            )}
          </div>
          <div className="cosim-ladder" data-testid="cosim-ladder">
            {ladder && ladderState ? (
              <LadderDiagramView
                doc={ladder}
                name={ladder.name}
                ladder={ladderState}
                power={frame?.power ?? {}}
              />
            ) : (
              <p className="cosim-empty">Choose a saved ladder program version.</p>
            )}
          </div>
        </div>
      </EditorLayout>
    </div>
  );
}

const refText = (r?: CosimSourceRef) => (r ? `${r.artifactId}\u0000${r.versionId}` : '');

function SourcePicker<T>({
  label,
  source,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  source: CosimSource<T>;
  value?: CosimSourceRef;
  error?: string;
  disabled: boolean;
  onChange(ref: CosimSourceRef | undefined): void;
}) {
  const [entries, setEntries] = useState<CosimSourceEntry[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    source.list().then(
      (e) => live && setEntries(e),
      () => live && setEntries([]),
    );
    return () => {
      live = false;
    };
  }, [source, tick]);
  const options = [{ value: '', label: 'None' }];
  for (const e of entries)
    for (const v of e.versions)
      options.push({
        value: `${e.artifactId}\u0000${v.versionId}`,
        label: `${e.name} · ${v.label}`,
      });
  const current = refText(value);
  if (current && !options.some((o) => o.value === current))
    options.push({ value: current, label: `${value!.artifactId} (not found)` });
  return (
    <div className="cosim-source" onFocus={() => setTick((n) => n + 1)}>
      <Choice
        label={label}
        value={current}
        options={options}
        disabled={disabled}
        onChange={(v) => {
          if (!v) return onChange(undefined);
          const [artifactId, versionId] = v.split('\u0000');
          const version = entries
            .find((e) => e.artifactId === artifactId)
            ?.versions.find((x) => x.versionId === versionId);
          if (version) onChange({ artifactId, versionId, contentHash: version.contentHash });
        }}
      />
      {error && (
        <p className="cosim-error" data-testid={`cosim-source-error-${label}`}>
          {messages[error] ?? error}
        </p>
      )}
    </div>
  );
}

function Bindings({
  controller,
  state,
  locked,
}: {
  controller: CosimController;
  state: CosimSurfaceState;
  locked: boolean;
}) {
  const settle = useSettle();
  const { ladder, nets } = state.loaded;
  const put = (i: number, b: CosimBinding) => settle(() => controller.updateBinding(i, b));
  const choices = (current: string, all: string[]) =>
    all.includes(current) ? all : [current, ...all];
  return (
    <Section title="Bindings">
      {state.content.bindings.length === 0 && (
        <p className="cosim-empty">No bindings: add an input or an output.</p>
      )}
      <ul className="cosim-bindings" data-testid="cosim-bindings">
        {state.content.bindings.map((b, i) => (
          <li key={i} data-binding={b.variable}>
            <span className="cosim-kind">{b.kind === 'input' ? 'Input ←' : 'Output →'}</span>
            <Choice
              label={`Variable ${i + 1}`}
              value={b.variable}
              options={choices(b.variable, cosimVariables(ladder, b.kind))}
              disabled={locked}
              onChange={(variable) => put(i, { ...b, variable })}
            />
            <Choice
              label={`Net ${i + 1}`}
              value={b.net}
              options={choices(b.net, nets)}
              disabled={locked}
              onChange={(net) => put(i, { ...b, net })}
            />
            {b.kind === 'input' && (
              <Choice
                label={`Pull ${i + 1}`}
                value={b.pull ?? 'up'}
                options={['up', 'down', 'none']}
                disabled={locked}
                onChange={(pull) => put(i, { ...b, pull: pull as CosimBinding['pull'] })}
              />
            )}
            <label className="ep-field cosim-check">
              <input
                type="checkbox"
                aria-label={`Active low ${i + 1}`}
                checked={!!b.activeLow}
                disabled={locked}
                onChange={(e) => put(i, { ...b, activeLow: e.target.checked })}
              />
              Active low
            </label>
            <IconButton
              icon={Trash2}
              label={`Delete binding ${i + 1}`}
              disabled={locked}
              reason={state.readOnly ? 'Read only' : 'Stop to edit'}
              onClick={() => settle(() => controller.deleteBinding(i))}
            />
          </li>
        ))}
      </ul>
      <div className="cosim-row">
        <IconButton
          icon={Plus}
          label="Add input binding"
          disabled={locked || !ladder}
          reason={locked ? 'Stop to edit' : 'Choose a ladder program'}
          onClick={() => settle(() => controller.addBinding('input'))}
        />
        <IconButton
          icon={Plus}
          label="Add output binding"
          disabled={locked || !ladder}
          reason={locked ? 'Stop to edit' : 'Choose a ladder program'}
          onClick={() => settle(() => controller.addBinding('output'))}
        />
      </div>
    </Section>
  );
}

function RunPanel({
  controller,
  state,
}: {
  controller: CosimController;
  state: CosimSurfaceState;
}) {
  const { schematic, ladder } = state.loaded;
  const frame = state.run.frame;
  const switches = cosimSwitches(schematic);
  const bound = new Set(state.content.bindings.map((b) => b.variable.toUpperCase()));
  const free = cosimVariables(ladder, 'input').filter((v) => !bound.has(v.toUpperCase()));
  const ledParts = (schematic?.parts ?? []).filter((p) => p.model?.kind === 'led');
  const values = controller.ladderState()?.values ?? {};
  const settle = useSettle();
  return (
    <div className="cosim-panel">
      <Section title="Switches">
        {switches.length === 0 && <p className="cosim-empty">The schematic has no switches.</p>}
        {switches.map((s) => {
          const closed = !!state.run.switches[s.id];
          return (
            <div key={s.id} className="cosim-row">
              <span>{s.ref}</span>
              <button
                type="button"
                className="cosim-press"
                aria-label={`Press ${s.ref}`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  // A draft is settled first (its commit would reset the run); refused, no press.
                  settle(() => controller.press(s.id, true));
                }}
                onPointerUp={() => controller.press(s.id, false)}
                onPointerCancel={() => controller.press(s.id, false)}
              >
                Press
              </button>
              <button
                type="button"
                aria-label={`Hold ${s.ref} closed`}
                aria-pressed={closed}
                onClick={() => settle(() => controller.press(s.id, !closed))}
              >
                {closed ? 'Closed' : 'Open'}
              </button>
            </div>
          );
        })}
      </Section>
      {free.length > 0 && (
        <Section title="Unbound inputs">
          {free.map((v) => {
            // A typed value, else what the program holds now (its initial value before a scan).
            const on = (state.run.inputs[v] ?? values[v]) === true;
            return (
              <div key={v} className="cosim-row">
                <span>{v}</span>
                <button
                  type="button"
                  aria-label={`Hold ${v} on`}
                  aria-pressed={on}
                  onClick={() => settle(() => controller.setInput(v, !on))}
                >
                  {on ? 'On' : 'Off'}
                </button>
              </div>
            );
          })}
        </Section>
      )}
      <Section title="Program">
        <table className="cosim-table">
          <tbody>
            {(ladder?.variables ?? [])
              .filter((v) => v.type === 'BOOL')
              .map((v) => (
                <tr key={v.name}>
                  <th scope="row">{v.name}</th>
                  <td>
                    <output data-testid={`cosim-var-${v.name}`} data-value={String(values[v.name])}>
                      {values[v.name] ? 'TRUE' : 'FALSE'}
                    </output>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
      <Section title="Circuit">
        <table className="cosim-table">
          <tbody>
            {ledParts.map((p) => {
              const i = frame?.currents[p.id] ?? 0;
              return (
                <tr key={p.id}>
                  <th scope="row">{p.ref} current</th>
                  <td>
                    <output data-testid={`cosim-current-${p.ref}`} data-value={i}>
                      {schematicSiText(i, 'A')}
                    </output>
                  </td>
                </tr>
              );
            })}
            {state.loaded.nets.map((n) => {
              const v = frame?.voltages[n] ?? 0;
              return (
                <tr key={n}>
                  <th scope="row">{n}</th>
                  <td>
                    <output data-testid={`cosim-volts-${n}`} data-value={v}>
                      {schematicSiText(v, 'V')}
                    </output>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
