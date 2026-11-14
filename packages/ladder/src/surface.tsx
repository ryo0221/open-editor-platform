import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowUp,
  CircleDot,
  GitBranch,
  ListPlus,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  EditorHistoryContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  ladderCoilKinds,
  ladderCompareOps,
  ladderContactKinds,
  ladderCounterTypes,
  ladderRoles,
  ladderTimerTypes,
  ladderTypes,
  ladderVariableMap,
  validateLadder,
  type LadderCoil,
  type LadderCounterState,
  type LadderDocument,
  type LadderNode,
  type LadderOperand,
  type LadderRung,
  type LadderState,
  type LadderTimerState,
  type LadderType,
  type LadderVariable,
} from '@editor-platform/ladder-core';
import {
  ladderElementKinds,
  ladderFind,
  type LadderController,
  type LadderElementKind,
  type LadderNotice,
  type LadderSurfaceState,
} from './controller';
import { Choice, Field, useSelect, useSettle } from './fields';
import { ladderLayout, type LadderCell } from './layout';

const kindLabels: Record<LadderElementKind, string> = {
  no: 'Normally open contact',
  nc: 'Normally closed contact',
  rising: 'Rising-edge contact',
  falling: 'Falling-edge contact',
  timer: 'Timer',
  counter: 'Counter',
  compare: 'Compare',
};
const opText: Record<string, string> = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' };
const noticeWords: Record<string, string> = {
  running: 'Stop the program to edit it.',
  'permission-denied': 'This program is read only.',
  'not-found': 'The element is gone.',
  'variable-missing': 'A variable it uses does not exist (still in use, or not declared).',
  'variable-type': 'A variable has the wrong type for its use.',
  'rung-no-coil': 'A rung needs at least one coil.',
  'coil-input': 'An input variable cannot be a coil.',
  'branch-target': 'An empty rung takes no branch: add an element first.',
  'move-into-self': 'An element cannot move into itself.',
  'coil-target': 'Coils stay at the right; choose a contact or box.',
  'no-rung': 'Add a rung first.',
  'name-invalid': 'A name is an IEC identifier: a letter, then letters, digits or single _.',
  'name-duplicate': 'Another variable has this name.',
  'variable-role': 'Timers and counters are internal variables.',
  'instance-duplicate': 'A timer or counter instance is used once.',
  'scan-ms': 'The scan period is 1 to 10000 ms.',
  preset: 'The preset is out of range.',
  initial: 'The initial value does not fit the type.',
  'input-value': 'The value does not fit the variable (INT -32768 to 32767, TIME 0 ms or more).',
  operand: 'An operand is a whole number or an INT/TIME variable (NAME.CV, NAME.ET).',
};
export const ladderNoticeText = (n: LadderNotice) =>
  `${noticeWords[n.code] ?? 'The edit was refused.'} (${n.code})`;

export function useLadderState(controller: LadderController): LadderSurfaceState {
  return useSyncExternalStore(
    useCallback((fn) => controller.subscribe(fn), [controller]),
    () => controller.state,
  );
}

export function LadderSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
}: {
  controller: LadderController;
  name: string;
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
}) {
  const state = useLadderState(controller);
  const [kind, setKind] = useState<LadderElementKind>('no');
  const settle = useSettle();
  const running = state.run.running;
  const locked = state.readOnly || running;
  const why = state.readOnly ? 'Read only' : 'Stop to edit';
  const history = useContext(EditorHistoryContext);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => () => controller.stop(), [controller]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && !locked && controller.state.selection) {
        e.preventDefault();
        // Like the toolbar's Delete: a refused draft in a panel keeps everything as it is.
        settleRef.current(() => controller.deleteSelection());
        return;
      }
      // Like the toolbar's Undo/Redo: not while read only or running (stop, then edit).
      if (!history || state.readOnly || running) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, history, locked, running, state.readOnly]);
  const at = ladderFind(state.content, state.selection);
  const warnings = useMemo(
    () => validateLadder(state.content).filter((d) => d.severity === 'warning'),
    [state.content],
  );
  const scans = state.run.state.scans;
  return (
    <div className="lad-surface" data-testid="lad-surface">
      <EditorLayout
        viewKey="ladder"
        leftLabel="Ladder"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Ladder tools">
            {!hostHistory && (
              <>
                <IconButton
                  icon={Undo2}
                  label="Undo"
                  disabled={locked}
                  reason={state.readOnly ? 'Read only' : 'Stop to edit'}
                  onClick={() => settle(() => onUndo?.())}
                />
                <IconButton
                  icon={Redo2}
                  label="Redo"
                  disabled={locked}
                  reason={state.readOnly ? 'Read only' : 'Stop to edit'}
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
                onClick={() => settle(() => controller.start())}
              />
            )}
            <IconButton
              icon={StepForward}
              label="One scan"
              disabled={running}
              reason="Running"
              onClick={() => settle(() => controller.step())}
            />
            <IconButton icon={RotateCcw} label="Reset" onClick={() => controller.reset()} />
            <span className="lad-sep" />
            <IconButton
              icon={ListPlus}
              label="Add rung"
              disabled={locked}
              reason={why}
              onClick={() => settle(() => controller.addRung())}
            />
            <label className="lad-pick">
              Element
              <select
                aria-label="Element to add"
                value={kind}
                onChange={(e) => setKind(e.target.value as LadderElementKind)}
              >
                {ladderElementKinds.map((k) => (
                  <option key={k} value={k}>
                    {kindLabels[k]}
                  </option>
                ))}
              </select>
            </label>
            <IconButton
              icon={Plus}
              label="Add after"
              disabled={locked}
              reason={why}
              onClick={() => settle(() => controller.addElement(kind, 'after'))}
            />
            <IconButton
              icon={ArrowLeftToLine}
              label="Add before"
              disabled={locked}
              reason={why}
              onClick={() => settle(() => controller.addElement(kind, 'before'))}
            />
            <IconButton
              icon={GitBranch}
              label="Add branch"
              disabled={locked}
              reason={why}
              onClick={() => settle(() => controller.addElement(kind, 'branch'))}
            />
            <IconButton
              icon={CircleDot}
              label="Add coil"
              disabled={locked}
              reason={why}
              onClick={() => settle(() => controller.addCoil())}
            />
            <IconButton
              icon={Trash2}
              label="Delete selection"
              disabled={locked || !state.selection}
              reason={locked ? why : 'Select something'}
              onClick={() => settle(() => controller.deleteSelection())}
            />
          </Toolbar>
        }
        left={
          <>
            <ProgramSection controller={controller} state={state} locked={locked} />
          </>
        }
        inspector={
          <div className="lad-inspector">
            {at?.element ? (
              <ElementInspector
                key={at.element.id}
                controller={controller}
                doc={state.content}
                element={at.element}
                locked={locked}
              />
            ) : at ? (
              <RungInspector
                key={at.rung.id}
                controller={controller}
                doc={state.content}
                rung={at.rung}
                locked={locked}
              />
            ) : (
              <Section title="Selection">
                <p className="lad-empty">Click an element, a coil or a rung&apos;s number.</p>
              </Section>
            )}
            {warnings.length > 0 && (
              <Section title="Warnings">
                <ul className="lad-list" data-testid="lad-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      {w.code} {w.id}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        }
        status={
          <span className="lad-status" data-testid="lad-status">
            {running ? 'Running' : 'Stopped'} · scan {scans} · {state.run.state.timeMs} ms (virtual)
            · {state.content.scanMs} ms per scan
            {state.notice && (
              <span className="lad-notice" role="alert" data-testid="lad-notice">
                {' '}
                · {ladderNoticeText(state.notice)}
              </span>
            )}
          </span>
        }
        {...layout}
      >
        <div className="lad-main">
          <Diagram controller={controller} state={state} name={name} locked={locked} />
          <VariableTable controller={controller} state={state} locked={locked} />
        </div>
      </EditorLayout>
    </div>
  );
}

// The diagram.

const CW = 96;
const CH = 64;
const LEFT = 44;
const TOP = 26;
const PAD = 18;

function Diagram({
  controller,
  state,
  name,
  locked,
}: {
  /** None for a view only (no selecting or moving). */
  controller?: LadderController;
  state: LadderSurfaceState;
  name: string;
  locked: boolean;
}) {
  const select = useSelect(controller);
  const settle = useSettle();
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string>();
  const doc = state.content;
  const shown = state.run.state.scans > 0;
  const on = (source: string) => shown && (source === '' || state.run.power[source] === true);
  const vars = useMemo(() => ladderVariableMap(doc), [doc]);

  const press = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || !controller) return;
    e.stopPropagation();
    drag.current = { id, x: e.clientX, y: e.clientY, moved: false };
    const move = (m: PointerEvent) => {
      const d = drag.current;
      if (!d || d.moved || locked) return;
      if (Math.hypot(m.clientX - d.x, m.clientY - d.y) > 6) {
        d.moved = true;
        setDragging(d.id);
      }
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = drag.current;
      drag.current = null;
      setDragging(undefined);
      if (!d) return;
      if (!d.moved) {
        select(d.id);
        return;
      }
      const hit = document
        .elementFromPoint(u.clientX, u.clientY)
        ?.closest<SVGElement>('[data-ladder-id], [data-ladder-rung]');
      if (!hit) return;
      const target = hit.dataset.ladderId ?? hit.dataset.ladderRung!;
      if (target === d.id) return;
      const box = hit.getBoundingClientRect();
      const side =
        hit.dataset.ladderId && u.clientX < box.left + box.width / 2 ? 'before' : 'after';
      settle(() => {
        if (!controller.moveElement(d.id, target, side)) controller.select(d.id);
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="lad-viewport" data-testid="lad-diagram" aria-label={`${name} ladder diagram`}>
      {doc.rungs.length === 0 && <p className="lad-empty">No rungs yet: add one.</p>}
      {doc.rungs.map((rung, i) => {
        const l = ladderLayout(rung);
        const width = LEFT + (l.coilCol + 1) * CW + PAD;
        const height = TOP + l.rows * CH + 6;
        const X = (x: number) => LEFT + x * CW;
        const Y = (y: number) => TOP + y * CH;
        const rail = X(l.coilCol + 1);
        const selected = state.selection === rung.id;
        return (
          <svg
            key={rung.id}
            className="lad-rung"
            data-rung={rung.id}
            data-ladder-rung={rung.id}
            data-selected={selected || undefined}
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="group"
            aria-label={`Rung ${i + 1}`}
            onPointerDown={(e) => press(e, rung.id)}
          >
            <rect className="lad-rung-bg" x={0} y={0} width={width} height={height} />
            <text className="lad-rung-no" x={8} y={TOP + CH / 2 + 5}>
              {i + 1}
            </text>
            {rung.comment && (
              <text className="lad-comment" x={LEFT + 4} y={16}>
                {rung.comment}
              </text>
            )}
            <line
              className="lad-rail"
              data-on={shown || undefined}
              x1={X(0)}
              y1={TOP}
              x2={X(0)}
              y2={TOP + l.rows * CH}
            />
            <line className="lad-rail" x1={rail} y1={TOP} x2={rail} y2={TOP + l.rows * CH} />
            {l.wires.map((w, k) => (
              <line
                key={k}
                className="lad-wire"
                data-on={on(w.source) || undefined}
                x1={X(w.x1)}
                y1={Y(w.y1)}
                x2={X(w.x2)}
                y2={Y(w.y2)}
              />
            ))}
            {l.cells.map((c) => (
              <Cell
                key={c.id}
                cell={c}
                x={X(c.col)}
                y={Y(c.row)}
                rail={rail}
                inOn={on(c.source)}
                outOn={shown && state.run.power[c.id] === true}
                selected={state.selection === c.id}
                dragging={dragging === c.id}
                type={(n: string) => vars.get(n)?.type}
                block={(n: string) => {
                  const v = vars.get(n);
                  return v ? state.run.state.blocks[v.name] : undefined;
                }}
                shown={shown}
                onPointerDown={(e) => press(e, c.id)}
              />
            ))}
          </svg>
        );
      })}
    </div>
  );
}

/**
 * SL8: a ladder program drawn read only with the power of a scan that ran elsewhere (the
 * co-simulation): the same diagram as the Surface, without selecting or editing.
 */
export function LadderDiagramView({
  doc,
  name,
  ladder,
  power,
}: {
  doc: LadderDocument;
  name: string;
  /** The state after the scan (initial state before any). */
  ladder: LadderState;
  power: Readonly<Record<string, boolean>>;
}) {
  const state = useMemo<LadderSurfaceState>(
    () => ({
      content: doc,
      key: '',
      readOnly: true,
      run: { running: false, state: ladder, power: { ...power }, inputs: {}, forced: {} },
    }),
    [doc, ladder, power],
  );
  return <Diagram state={state} name={name} locked />;
}

const operandText = (o: LadderOperand) =>
  'value' in o ? String(o.value) : o.member ? `${o.variable}.${o.member}` : o.variable;

function Cell({
  cell,
  x,
  y,
  rail,
  inOn,
  outOn,
  selected,
  dragging,
  type,
  block,
  shown,
  onPointerDown,
}: {
  cell: LadderCell;
  x: number;
  y: number;
  rail: number;
  inOn: boolean;
  outOn: boolean;
  selected: boolean;
  dragging: boolean;
  type(name: string): LadderType | undefined;
  block(name: string): LadderTimerState | LadderCounterState | undefined;
  shown: boolean;
  onPointerDown(e: ReactPointerEvent): void;
}) {
  const e = cell.element;
  const cy = y + CH / 2;
  const cx = x + CW / 2;
  const stub = (from: number, to: number, powered: boolean) => (
    <line className="lad-wire" data-on={powered || undefined} x1={from} y1={cy} x2={to} y2={cy} />
  );
  let body;
  let label: string;
  let half = 10;
  if (!('kind' in e)) {
    // A coil: ( ), (/), (S), (R).
    const mark =
      e.coil === 'negated' ? '/' : e.coil === 'set' ? 'S' : e.coil === 'reset' ? 'R' : '';
    label = `Coil ${e.variable}${mark ? ` (${e.coil})` : ''}`;
    body = (
      <>
        <path
          className="lad-symbol"
          data-on={outOn || undefined}
          d={`M ${cx - 6} ${cy - 13} A 14 14 0 0 0 ${cx - 6} ${cy + 13} M ${cx + 6} ${cy - 13} A 14 14 0 0 1 ${cx + 6} ${cy + 13}`}
        />
        {mark && (
          <text className="lad-mark" x={cx} y={cy + 5}>
            {mark}
          </text>
        )}
        <text className="lad-name" x={cx} y={cy - 20}>
          {e.variable}
        </text>
      </>
    );
    return (
      <g
        className="lad-cell"
        data-ladder-id={e.id}
        data-kind="coil"
        data-on={outOn || undefined}
        data-selected={selected || undefined}
        data-dragging={dragging || undefined}
        role="button"
        aria-label={label}
        aria-pressed={selected}
        onPointerDown={onPointerDown}
      >
        <rect className="lad-hit" x={x} y={y} width={CW} height={CH} />
        {stub(x, cx - 10, inOn)}
        {stub(cx + 10, rail, inOn)}
        {body}
      </g>
    );
  }
  if (e.kind === 'contact') {
    const mark = e.contact === 'rising' ? 'P' : e.contact === 'falling' ? 'N' : '';
    label = `${e.contact.toUpperCase()} contact ${e.variable}`;
    half = 8;
    body = (
      <>
        <line
          className="lad-symbol"
          data-on={outOn || undefined}
          x1={cx - 8}
          y1={cy - 14}
          x2={cx - 8}
          y2={cy + 14}
        />
        <line
          className="lad-symbol"
          data-on={outOn || undefined}
          x1={cx + 8}
          y1={cy - 14}
          x2={cx + 8}
          y2={cy + 14}
        />
        {e.contact === 'nc' && (
          <line className="lad-symbol" x1={cx - 12} y1={cy + 12} x2={cx + 12} y2={cy - 12} />
        )}
        {mark && (
          <text className="lad-mark" x={cx} y={cy + 5}>
            {mark}
          </text>
        )}
        <text className="lad-name" x={cx} y={cy - 20}>
          {e.variable}
        </text>
      </>
    );
  } else if (e.kind === 'timer' || e.kind === 'counter' || e.kind === 'compare') {
    half = 32;
    let title: string;
    let lines: string[];
    if (e.kind === 'compare') {
      title = 'CMP';
      lines = [`${operandText(e.a)} ${opText[e.op]} ${operandText(e.b)}`];
      label = `Compare ${lines[0]}`;
    } else if (e.kind === 'timer') {
      title = type(e.instance) ?? 'TON';
      const t = block(e.instance) as LadderTimerState | undefined;
      lines = [`PT ${e.presetMs} ms`, shown && t ? `ET ${t.et} ms` : ''];
      label = `Timer ${e.instance}`;
    } else {
      title = type(e.instance) ?? 'CTU';
      const c = block(e.instance) as LadderCounterState | undefined;
      lines = [`PV ${e.preset}`, shown && c ? `CV ${c.cv}` : ''];
      label = `Counter ${e.instance}`;
    }
    body = (
      <>
        <rect
          className="lad-box"
          data-on={outOn || undefined}
          x={cx - half}
          y={cy - 22}
          width={half * 2}
          height={44}
          rx={3}
        />
        <text className="lad-box-title" x={cx} y={cy - 9}>
          {title}
        </text>
        {lines.map((t, i) => (
          <text key={i} className="lad-box-line" x={cx} y={cy + 5 + i * 12} data-line={i}>
            {t}
          </text>
        ))}
        {e.kind !== 'compare' && (
          <text className="lad-name" x={cx} y={cy - 27}>
            {e.instance}
          </text>
        )}
      </>
    );
  } else {
    return null;
  }
  return (
    <g
      className="lad-cell"
      data-ladder-id={e.id}
      data-kind={e.kind}
      data-on={outOn || undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      onPointerDown={onPointerDown}
    >
      <rect className="lad-hit" x={x} y={y} width={CW} height={CH} />
      {stub(x, cx - half, inOn)}
      {stub(cx + half, x + CW, outOn)}
      {body}
    </g>
  );
}

// Panels.

function ProgramSection({
  controller,
  state,
  locked,
}: {
  controller: LadderController;
  state: LadderSurfaceState;
  locked: boolean;
}) {
  return (
    <Section title="Program">
      <Field
        readOnly={locked}
        label="Name"
        value={state.content.name}
        onCommit={(v) => !controller.setProgram({ name: v })}
      />
      <Field
        readOnly={locked}
        label="Scan period (ms)"
        value={String(state.content.scanMs)}
        onCommit={(v) => {
          const n = Number(v);
          if (!/^\d+$/.test(v.trim())) {
            controller.report({ code: 'scan-ms' });
            return false;
          }
          return !controller.setProgram({ scanMs: n });
        }}
      />
    </Section>
  );
}

const isBlock = (t: LadderType) =>
  (ladderTimerTypes as readonly string[]).includes(t) ||
  (ladderCounterTypes as readonly string[]).includes(t);

function VariableTable({
  controller,
  state,
  locked,
}: {
  controller: LadderController;
  state: LadderSurfaceState;
  locked: boolean;
}) {
  const settle = useSettle();
  const run = state.run;
  const shown = run.state.scans > 0;
  const change = (v: LadderVariable, patch: Partial<LadderVariable>) => {
    const next: LadderVariable = { ...v, ...patch };
    if (patch.type && patch.type !== v.type) {
      delete next.initial;
      if (isBlock(patch.type)) next.role = 'internal';
    }
    return controller.updateVariable(v.name, next);
  };
  const value = (v: LadderVariable) => {
    if (isBlock(v.type)) {
      const b = run.state.blocks[v.name];
      if (!b || !shown) return '';
      return 'et' in b ? `ET ${b.et} ms · Q ${b.q ? 1 : 0}` : `CV ${b.cv} · Q ${b.q ? 1 : 0}`;
    }
    const x = run.state.values[v.name];
    return typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : String(x);
  };
  return (
    <section className="lad-var-panel" aria-label="Variables">
      <h3>Variables</h3>
      <table className="lad-vars" data-testid="lad-vars">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Role</th>
            <th>Value</th>
            <th>Input / force</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.content.variables.map((v) => {
            const val = value(v);
            const forced = run.forced[v.name];
            const held = run.inputs[v.name] === true;
            return (
              <tr key={v.name} data-variable={v.name}>
                <td>
                  <Field
                    readOnly={locked}
                    label={`Name of ${v.name}`}
                    value={v.name}
                    onCommit={(n) => !change(v, { name: n.trim() })}
                  />
                </td>
                <td>
                  <Choice
                    label={`Type of ${v.name}`}
                    value={v.type}
                    options={ladderTypes}
                    disabled={locked}
                    onChange={(t) => settle(() => change(v, { type: t as LadderType }))}
                  />
                </td>
                <td>
                  <Choice
                    label={`Role of ${v.name}`}
                    value={v.role}
                    options={ladderRoles}
                    disabled={locked || isBlock(v.type)}
                    onChange={(r) => settle(() => change(v, { role: r as LadderVariable['role'] }))}
                  />
                </td>
                <td>
                  <output
                    className="lad-value"
                    data-testid={`lad-value-${v.name}`}
                    data-value={val}
                    data-forced={forced !== undefined || undefined}
                  >
                    {val}
                  </output>
                </td>
                <td className="lad-io">
                  {v.type === 'BOOL' && v.role === 'input' && (
                    <>
                      <button
                        type="button"
                        className="lad-press"
                        aria-label={`Press ${v.name}`}
                        onPointerDown={(e) => {
                          e.currentTarget.setPointerCapture?.(e.pointerId);
                          controller.setInput(v.name, true);
                        }}
                        onPointerUp={() => controller.setInput(v.name, false)}
                        onPointerCancel={() => controller.setInput(v.name, false)}
                      >
                        Press
                      </button>
                      <button
                        type="button"
                        aria-label={`Hold ${v.name} on`}
                        aria-pressed={held}
                        onClick={() => controller.setInput(v.name, !held)}
                      >
                        {held ? 'On' : 'Off'}
                      </button>
                    </>
                  )}
                  {(v.type === 'INT' || v.type === 'TIME') && v.role === 'input' && (
                    <Field
                      readOnly={false}
                      label={`Input ${v.name}`}
                      value={String(run.inputs[v.name] ?? run.state.values[v.name] ?? 0)}
                      onCommit={(n) => {
                        if (!/^-?\d+$/.test(n.trim())) {
                          controller.report({ code: 'input-value', id: v.name });
                          return false;
                        }
                        return !controller.setInput(v.name, Number(n));
                      }}
                    />
                  )}
                  {v.type === 'BOOL' && (
                    <select
                      aria-label={`Force ${v.name}`}
                      value={forced === undefined ? '' : forced ? 'TRUE' : 'FALSE'}
                      onChange={(e) =>
                        controller.force(
                          v.name,
                          e.target.value === '' ? undefined : e.target.value === 'TRUE',
                        )
                      }
                    >
                      <option value="">Not forced</option>
                      <option value="TRUE">Force TRUE</option>
                      <option value="FALSE">Force FALSE</option>
                    </select>
                  )}
                </td>
                <td>
                  <IconButton
                    icon={Trash2}
                    label={`Delete ${v.name}`}
                    disabled={locked}
                    reason={locked ? 'Stop to edit' : ''}
                    onClick={() => settle(() => controller.deleteVariable(v.name))}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        type="button"
        disabled={locked}
        onClick={() => settle(() => controller.addVariable())}
      >
        Add variable
      </button>
    </section>
  );
}

function RungInspector({
  controller,
  doc,
  rung,
  locked,
}: {
  controller: LadderController;
  doc: LadderDocument;
  rung: LadderRung;
  locked: boolean;
}) {
  const settle = useSettle();
  const index = doc.rungs.indexOf(rung);
  return (
    <Section title={`Rung ${index + 1}`}>
      <Field
        readOnly={locked}
        label="Comment"
        value={rung.comment ?? ''}
        onCommit={(v) => !controller.setRungComment(rung.id, v)}
      />
      <div className="lad-row">
        <IconButton
          icon={ArrowUp}
          label="Move rung up"
          disabled={locked || index === 0}
          onClick={() => settle(() => controller.moveRung(rung.id, -1))}
        />
        <IconButton
          icon={ArrowDown}
          label="Move rung down"
          disabled={locked || index === doc.rungs.length - 1}
          onClick={() => settle(() => controller.moveRung(rung.id, 1))}
        />
        <IconButton
          icon={Trash2}
          label="Delete rung"
          disabled={locked}
          onClick={() => settle(() => controller.deleteSelection())}
        />
      </div>
    </Section>
  );
}

/** "12", "NAME", "NAME.CV" or "NAME.ET" as an operand; undefined when it is none of them. */
export function ladderParseOperand(text: string): LadderOperand | undefined {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return { value: Number(t) };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(CV|ET))?$/i.exec(t);
  if (!m) return undefined;
  return m[2] ? { variable: m[1], member: m[2].toUpperCase() as 'CV' | 'ET' } : { variable: m[1] };
}

function ElementInspector({
  controller,
  doc,
  element,
  locked,
}: {
  controller: LadderController;
  doc: LadderDocument;
  element: LadderNode | LadderCoil;
  locked: boolean;
}) {
  const settle = useSettle();
  const bools = doc.variables.filter((v) => v.type === 'BOOL').map((v) => v.name);
  // References may differ in case from the declaration; selectors show the declared spelling.
  const vars = ladderVariableMap(doc);
  const declared = (name: string) => vars.get(name)?.name ?? name;
  const put = (next: LadderNode | LadderCoil) => settle(() => controller.replace(next));
  if (!('kind' in element))
    return (
      <Section title="Coil">
        <Choice
          label="Variable"
          value={declared(element.variable)}
          options={doc.variables
            .filter((v) => v.type === 'BOOL' && v.role !== 'input')
            .map((v) => v.name)}
          disabled={locked}
          onChange={(variable) => put({ ...element, variable })}
        />
        <Choice
          label="Coil"
          value={element.coil}
          options={ladderCoilKinds}
          disabled={locked}
          onChange={(coil) => put({ ...element, coil: coil as LadderCoil['coil'] })}
        />
      </Section>
    );
  switch (element.kind) {
    case 'contact':
      return (
        <Section title="Contact">
          <Choice
            label="Variable"
            value={declared(element.variable)}
            options={bools}
            disabled={locked}
            onChange={(variable) => put({ ...element, variable })}
          />
          <Choice
            label="Contact"
            value={element.contact}
            options={ladderContactKinds}
            disabled={locked}
            onChange={(c) => put({ ...element, contact: c as typeof element.contact })}
          />
        </Section>
      );
    case 'timer':
    case 'counter': {
      const timer = element.kind === 'timer';
      const v = doc.variables.find((x) => x.name.toUpperCase() === element.instance.toUpperCase());
      return (
        <Section title={timer ? 'Timer' : 'Counter'}>
          <p className="lad-facts">Instance {element.instance}</p>
          {v && (
            <Choice
              label="Type"
              value={v.type}
              options={timer ? ladderTimerTypes : ladderCounterTypes}
              disabled={locked}
              onChange={(t) =>
                settle(() => controller.updateVariable(v.name, { ...v, type: t as LadderType }))
              }
            />
          )}
          <Field
            readOnly={locked}
            label={timer ? 'Preset (ms)' : 'Preset'}
            value={String(timer ? element.presetMs : (element as { preset: number }).preset)}
            onCommit={(text) => {
              if (!/^-?\d+$/.test(text.trim())) {
                controller.report({ code: 'preset', id: element.id });
                return false;
              }
              const n = Number(text);
              return !controller.replace(
                element.kind === 'timer' ? { ...element, presetMs: n } : { ...element, preset: n },
              );
            }}
          />
          {element.kind === 'counter' && (
            <Choice
              label={v?.type === 'CTD' ? 'Load (LD)' : 'Reset (R)'}
              value={element.reset ? declared(element.reset) : ''}
              options={[
                { value: '', label: 'None' },
                ...bools.map((b) => ({ value: b, label: b })),
              ]}
              disabled={locked}
              onChange={(r) => {
                const { reset: _, ...rest } = element;
                put(r ? { ...rest, reset: r } : rest);
              }}
            />
          )}
        </Section>
      );
    }
    case 'compare':
      return (
        <Section title="Compare">
          <Field
            readOnly={locked}
            label="A"
            value={operandText(element.a)}
            onCommit={(t) => {
              const a = ladderParseOperand(t);
              if (!a) {
                controller.report({ code: 'operand', id: element.id });
                return false;
              }
              return !controller.replace({ ...element, a });
            }}
          />
          <Choice
            label="Operator"
            value={element.op}
            options={ladderCompareOps.map((o) => ({ value: o, label: opText[o] }))}
            disabled={locked}
            onChange={(op) => put({ ...element, op: op as typeof element.op })}
          />
          <Field
            readOnly={locked}
            label="B"
            value={operandText(element.b)}
            onCommit={(t) => {
              const b = ladderParseOperand(t);
              if (!b) {
                controller.report({ code: 'operand', id: element.id });
                return false;
              }
              return !controller.replace({ ...element, b });
            }}
          />
        </Section>
      );
    default:
      return null;
  }
}
