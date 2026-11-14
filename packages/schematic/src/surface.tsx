import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Cable,
  CircleDot,
  Cpu,
  FlipHorizontal2,
  Maximize,
  MousePointer2,
  Redo2,
  RotateCw,
  Tag,
  Trash2,
  Undo2,
  Zap,
} from 'lucide-react';
import {
  CommitInput,
  EditorHistoryContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  partDrawPoint,
  placedPins,
  schematicMove,
  schematicNets,
  schematicOrientations,
  schematicPowerStyles,
  schematicRotations,
  schematicSheetSize,
  schematicSheetSizes,
  snapSchematic,
  toGrid,
  fromGrid,
  validateSchematic,
  type SchematicDocument,
  type SchematicLabel,
  type SchematicPart,
  type SchematicPower,
  type SchematicSymbol,
  type Vec2,
} from '@editor-platform/schematic-core';
import type { SchematicController, SchematicNotice, SchematicState } from './controller';
import { Choice, Field, useSelect, useSettle } from './fields';
import { ErcList, PartDataInspector, SymbolGenerator } from './part-data';
import {
  schematicSimOverlay,
  SimulationPanel,
  useSchematicSimulation,
  type SchematicSimOverlay,
} from './simulate-panel';
import {
  fitSchematicView,
  partBox,
  pinLine,
  schematicViewBox,
  screenToSheet,
  segmentDistance,
  sheetToScreen,
  wireLeg,
  zoomSchematicView,
  type SchematicView,
} from './view';

export type SchematicTool = 'select' | 'part' | 'wire' | 'label' | 'power' | 'junction';
const toolInfo: Record<SchematicTool, { label: string; hint: string }> = {
  select: { label: 'Select', hint: '' },
  part: { label: 'Place part', hint: 'Click to place the chosen symbol. R turns it. Esc to stop.' },
  wire: {
    label: 'Draw wire',
    hint: 'Click the points; a click on a pin or wire end, a double-click or Enter ends the wire. Esc to cancel.',
  },
  label: { label: 'Add net label', hint: 'Click a wire end or pin to name its net. Esc to stop.' },
  power: {
    label: 'Add power port',
    hint: 'Click a wire end or pin to tie it to the supply. Esc to stop.',
  },
  junction: { label: 'Add junction', hint: 'Click where wires meet to join them. Esc to stop.' },
};

const noticeWords: Record<string, string> = {
  'grid-off': 'Points must lie on the 1.27 mm grid.',
  'off-sheet': 'Everything must lie on the sheet.',
  'ref-duplicate': 'Two parts have the same reference.',
  ref: 'A reference starts with a letter, then letters, digits or _.',
  'net-name': 'A net name has no spaces (1–64 characters).',
  'wire-diagonal': 'Wires run horizontally or vertically.',
  'wire-degenerate': 'A wire needs two different points.',
  'wire-overlap': 'A wire may not double back over itself.',
  'wire-points': 'A wire needs at least two points.',
  'symbol-missing': 'The symbol is not in this schematic.',
  'permission-denied': 'This schematic is read only.',
  'not-found': 'The item is gone.',
  'move-changes-nets':
    'Moving would change which pins are connected; draw or delete wires to change the circuit.',
};
export const schematicNoticeText = (n: SchematicNotice) =>
  `${noticeWords[n.code] ?? 'The edit was refused.'} (${n.code})`;

export function useSchematicState(controller: SchematicController): SchematicState {
  return useSyncExternalStore(
    useCallback((fn) => controller.subscribe(fn), [controller]),
    () => controller.state,
  );
}
const mm = (v: number) => String(Math.round(v * 1e3) / 1e3);

export function SchematicSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
}: {
  controller: SchematicController;
  name: string;
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
}) {
  const state = useSchematicState(controller);
  const [tool, setTool] = useState<SchematicTool>('select');
  const [chosenSymbol, setSymbol] = useState(state.content.symbols[0]?.id ?? '');
  // The chosen symbol may go away (Undo of its creation, a deletion elsewhere): place the first
  // symbol still in the document instead.
  const symbol = state.content.symbols.some((s) => s.id === chosenSymbol)
    ? chosenSymbol
    : (state.content.symbols[0]?.id ?? '');
  const [labelName, setLabelName] = useState('NET1');
  const [powerName, setPowerName] = useState('GND');
  // Read by the canvas at the press itself: a name committed by that press's flush is current.
  const names = useRef({ label: 'NET1', power: 'GND' });
  const [fitKey, setFitKey] = useState(0);
  const [cursor, setCursor] = useState<Vec2>();
  const settle = useSettle();
  const select = useSelect(controller);
  const readOnly = state.readOnly;
  const activeTool: SchematicTool = readOnly ? 'select' : tool;
  const history = useContext(EditorHistoryContext);
  useEffect(() => {
    if (!history || readOnly) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) history!.redo();
      else history!.undo();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, readOnly]);
  const nets = useMemo(() => schematicNets(state.content), [state.content]);
  const warnings = useMemo(
    () => validateSchematic(state.content).filter((d) => d.severity === 'warning'),
    [state.content],
  );
  const selectedPart = state.content.parts.find((p) => p.id === state.selection[0]);
  const selectedLabel = state.content.labels.find((p) => p.id === state.selection[0]);
  const selectedPower = state.content.powers.find((p) => p.id === state.selection[0]);
  const pick = (t: SchematicTool) => settle(() => setTool(t));
  const sim = useSchematicSimulation(state);
  const overlay = useMemo(
    () => (sim.result ? schematicSimOverlay(state.content, sim.result, sim.time) : undefined),
    [state.content, sim.result, sim.time],
  );
  return (
    <div className="sch-surface" data-testid="sch-surface">
      <EditorLayout
        viewKey="schematic"
        leftLabel="Schematic"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Schematic tools">
            {!hostHistory && (
              <>
                <IconButton icon={Undo2} label="Undo" onClick={() => settle(() => onUndo?.())} />
                <IconButton icon={Redo2} label="Redo" onClick={() => settle(() => onRedo?.())} />
              </>
            )}
            {(
              [
                ['select', MousePointer2],
                ['part', Cpu],
                ['wire', Cable],
                ['label', Tag],
                ['power', Zap],
                ['junction', CircleDot],
              ] as const
            ).map(([t, icon]) => (
              <IconButton
                key={t}
                icon={icon}
                label={toolInfo[t].label}
                aria-pressed={activeTool === t}
                disabled={t !== 'select' && readOnly}
                reason="Read only"
                onClick={() => pick(t)}
              />
            ))}
            <label className="sch-pick">
              Symbol
              <select
                aria-label="Symbol to place"
                value={symbol}
                disabled={readOnly}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  setTool('part');
                }}
              >
                {state.content.symbols.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <CommitInput
              label="Label name"
              value={labelName}
              onCommit={(v) => {
                names.current.label = v.trim();
                setLabelName(v.trim());
                return true;
              }}
            />
            <CommitInput
              label="Power name"
              value={powerName}
              onCommit={(v) => {
                names.current.power = v.trim();
                setPowerName(v.trim());
                return true;
              }}
            />
            <IconButton
              icon={RotateCw}
              label="Rotate part"
              disabled={readOnly || !selectedPart}
              reason={readOnly ? 'Read only' : 'Select a part'}
              onClick={() => settle(() => controller.rotateSelection())}
            />
            <IconButton
              icon={FlipHorizontal2}
              label="Mirror part"
              disabled={readOnly || !selectedPart}
              reason={readOnly ? 'Read only' : 'Select a part'}
              onClick={() => settle(() => controller.mirrorSelection())}
            />
            <IconButton
              icon={Trash2}
              label="Delete selection"
              disabled={readOnly || !state.selection.length}
              reason={readOnly ? 'Read only' : 'Select something'}
              onClick={() => settle(() => controller.deleteSelection())}
            />
            <IconButton icon={Maximize} label="Fit sheet" onClick={() => setFitKey((k) => k + 1)} />
          </Toolbar>
        }
        left={
          <>
            <SchematicTree controller={controller} state={state} nets={nets} />
            <SymbolGenerator
              controller={controller}
              readOnly={readOnly}
              onAdded={(id) => {
                setSymbol(id);
                setTool('part');
              }}
            />
          </>
        }
        inspector={
          <div className="sch-inspector">
            {selectedPart ? (
              <PartInspector
                key={selectedPart.id}
                controller={controller}
                part={selectedPart}
                symbol={state.content.symbols.find((s) => s.id === selectedPart.symbol)}
                readOnly={readOnly}
              />
            ) : selectedLabel ? (
              <LabelInspector
                key={selectedLabel.id}
                controller={controller}
                label={selectedLabel}
                readOnly={readOnly}
              />
            ) : selectedPower ? (
              <PowerInspector
                key={selectedPower.id}
                controller={controller}
                power={selectedPower}
                readOnly={readOnly}
              />
            ) : state.selection.length ? (
              <Section title="Selection">
                <p>{state.selection.length} item(s)</p>
                <button type="button" onClick={() => select([])}>
                  Sheet
                </button>
              </Section>
            ) : (
              <SheetInspector controller={controller} state={state} />
            )}
            <ErcList controller={controller} doc={state.content} nets={nets} />
            <SimulationPanel state={state} sim={sim} />
            {warnings.length > 0 && (
              <Section title="Warnings">
                <ul className="sch-list" aria-label="Warnings" data-testid="sch-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <button type="button" onClick={() => w.id && select([w.id])}>
                        {w.code} · {w.id ?? w.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        }
        status={
          <span className="sch-status" data-testid="sch-status">
            {name} · {state.content.sheet.size} {state.content.sheet.orientation} ·{' '}
            {state.content.parts.length} parts · {state.content.wires.length} wires · {nets.length}{' '}
            nets
            {cursor && ` · x ${mm(cursor[0])} y ${mm(cursor[1])}`}
          </span>
        }
        {...layout}
      >
        <SheetCanvas
          controller={controller}
          state={state}
          tool={activeTool}
          symbol={symbol}
          names={names}
          fitKey={fitKey}
          overlay={overlay}
          onCursor={setCursor}
          onToolDone={() => setTool('select')}
        />
      </EditorLayout>
    </div>
  );
}

function SchematicTree({
  controller,
  state,
  nets,
}: {
  controller: SchematicController;
  state: SchematicState;
  nets: ReturnType<typeof schematicNets>;
}) {
  const select = useSelect(controller);
  const refOf = new Map(state.content.parts.map((p) => [p.id, p.ref]));
  return (
    <div className="sch-tree">
      <Section title="Parts">
        {state.content.parts.length === 0 ? (
          <p className="sch-empty">No parts yet.</p>
        ) : (
          <ul className="sch-list" aria-label="Parts">
            {[...state.content.parts]
              .sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
              .map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={state.selection.includes(p.id)}
                    onClick={() => select([p.id])}
                  >
                    {p.ref} · {p.value}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </Section>
      <Section title="Nets">
        {nets.length === 0 ? (
          <p className="sch-empty">No nets yet.</p>
        ) : (
          <ul className="sch-list" aria-label="Nets" data-testid="sch-nets">
            {nets.map((n) => (
              <li key={n.name} data-net={n.name}>
                <button type="button" onClick={() => select(n.items)}>
                  <strong>{n.name}</strong> ·{' '}
                  {n.pins.map(([p, q]) => `${refOf.get(p) ?? p}.${q}`).join(', ')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function SheetInspector({
  controller,
  state,
}: {
  controller: SchematicController;
  state: SchematicState;
}) {
  const settle = useSettle();
  const sheet = state.content.sheet;
  const readOnly = state.readOnly;
  const [w, h] = schematicSheetSize(sheet);
  return (
    <Section title="Sheet">
      <Field
        readOnly={readOnly}
        label="Title"
        value={sheet.title}
        onCommit={(v) => !controller.setSheet({ title: v })}
      />
      <Choice
        label="Sheet size"
        value={sheet.size}
        options={schematicSheetSizes}
        disabled={readOnly}
        onChange={(v) => settle(() => controller.setSheet({ size: v as 'A4' }))}
      />
      <Choice
        label="Orientation"
        value={sheet.orientation}
        options={schematicOrientations}
        disabled={readOnly}
        onChange={(v) => settle(() => controller.setSheet({ orientation: v as 'landscape' }))}
      />
      <p className="sch-facts">
        {w} × {h} mm, 1.27 mm grid
      </p>
    </Section>
  );
}

function PartInspector({
  controller,
  part,
  symbol,
  readOnly,
}: {
  controller: SchematicController;
  part: SchematicPart;
  symbol?: SchematicSymbol;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const select = useSelect(controller);
  const edit = (patch: Partial<SchematicPart>) => !controller.updatePart({ ...part, ...patch });
  return (
    <>
      <Section title={`Part ${part.ref}`}>
        <Field
          readOnly={readOnly}
          label="Reference"
          value={part.ref}
          onCommit={(v) => edit({ ref: v.trim() })}
        />
        <Field
          readOnly={readOnly}
          label="Value"
          value={part.value}
          onCommit={(v) => edit({ value: v })}
        />
        <Choice
          label="Rotation"
          value={part.rotationDeg}
          options={schematicRotations}
          disabled={readOnly}
          onChange={(v) => settle(() => edit({ rotationDeg: Number(v) as 0 }))}
        />
        <label className="ep-field sch-check">
          <input
            type="checkbox"
            aria-label="Mirrored"
            checked={part.mirror}
            disabled={readOnly}
            onChange={(e) => {
              const mirror = e.target.checked;
              settle(() => edit({ mirror }));
            }}
          />
          Mirrored
        </label>
        <p className="sch-facts">
          At {mm(part.at[0])}, {mm(part.at[1])} mm
        </p>
        <div className="sch-actions">
          <button type="button" onClick={() => select([])}>
            Sheet
          </button>
          {!readOnly && (
            <button type="button" onClick={() => settle(() => controller.deleteSelection())}>
              <Trash2 size={14} aria-hidden="true" /> Delete part
            </button>
          )}
        </div>
      </Section>
      {symbol && (
        <PartDataInspector
          controller={controller}
          part={part}
          symbol={symbol}
          readOnly={readOnly}
        />
      )}
    </>
  );
}

function LabelInspector({
  controller,
  label,
  readOnly,
}: {
  controller: SchematicController;
  label: SchematicLabel;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const select = useSelect(controller);
  return (
    <Section title={`Label ${label.name}`}>
      <Field
        readOnly={readOnly}
        label="Net name"
        value={label.name}
        onCommit={(v) => !controller.updateLabel({ ...label, name: v.trim() })}
      />
      <div className="sch-actions">
        <button type="button" onClick={() => select([])}>
          Sheet
        </button>
        {!readOnly && (
          <button type="button" onClick={() => settle(() => controller.deleteSelection())}>
            <Trash2 size={14} aria-hidden="true" /> Delete label
          </button>
        )}
      </div>
    </Section>
  );
}

function PowerInspector({
  controller,
  power,
  readOnly,
}: {
  controller: SchematicController;
  power: SchematicPower;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const select = useSelect(controller);
  return (
    <Section title={`Power ${power.name}`}>
      <Field
        readOnly={readOnly}
        label="Supply name"
        value={power.name}
        onCommit={(v) => !controller.updatePower({ ...power, name: v.trim() })}
      />
      <Choice
        label="Style"
        value={power.style}
        options={schematicPowerStyles}
        disabled={readOnly}
        onChange={(v) => settle(() => controller.updatePower({ ...power, style: v as 'ground' }))}
      />
      <div className="sch-actions">
        <button type="button" onClick={() => select([])}>
          Sheet
        </button>
        {!readOnly && (
          <button type="button" onClick={() => settle(() => controller.deleteSelection())}>
            <Trash2 size={14} aria-hidden="true" /> Delete power port
          </button>
        )}
      </div>
    </Section>
  );
}

/** Pixels within which a click picks an item or ends a wire on a connection point. */
const pickPx = 8;

/** The drawn symbol of a placed part (graphics and pins). */
function PartGlyph({
  part,
  symbol,
  selected,
  px1,
}: {
  part: SchematicPart;
  symbol: SchematicSymbol;
  selected: boolean;
  px1: number;
}) {
  const t = (p: Vec2) => partDrawPoint(part, p);
  const stroke = selected ? '#2f81f7' : '#8a1c1c';
  const w = Math.max(0.254, (selected ? 2 : 1) * px1);
  const pts = (ps: Vec2[]) => ps.map((p) => t(p).join(',')).join(' ');
  const box = partBox(part, symbol);
  return (
    <g data-testid={`sch-part-${part.id}`} className="sch-part">
      {symbol.graphics.map((g, i) => {
        if (g.kind === 'line')
          return (
            <polyline key={i} points={pts(g.points)} fill="none" stroke={stroke} strokeWidth={w} />
          );
        if (g.kind === 'polygon')
          return (
            <polygon
              key={i}
              points={pts(g.points)}
              fill={g.filled ? stroke : '#fffbe6'}
              stroke={stroke}
              strokeWidth={w}
            />
          );
        if (g.kind === 'rect')
          return (
            <polygon
              key={i}
              points={pts([g.from, [g.to[0], g.from[1]], g.to, [g.from[0], g.to[1]]])}
              fill={g.filled ? stroke : '#fffbe6'}
              stroke={stroke}
              strokeWidth={w}
            />
          );
        if (g.kind === 'circle') {
          const c = t(g.center);
          return (
            <circle
              key={i}
              cx={c[0]}
              cy={c[1]}
              r={g.radiusMm}
              fill={g.filled ? stroke : 'none'}
              stroke={stroke}
              strokeWidth={w}
            />
          );
        }
        const at = t(g.at);
        return (
          <text key={i} x={at[0]} y={at[1]} fontSize={g.sizeMm} fill={stroke}>
            {g.text}
          </text>
        );
      })}
      {symbol.pins.map((pin) => {
        const [a, b] = pinLine(pin).map(t);
        const nc = part.noConnect?.includes(pin.number);
        const x = 0.8;
        return (
          <g key={pin.number}>
            <line
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={selected ? '#2f81f7' : '#8a1c1c'}
              strokeWidth={w}
            />
            {nc && (
              // The not-connected mark: a cross on the pin's end.
              <path
                data-testid={`sch-nc-${part.id}-${pin.number}`}
                d={`M${a[0] - x} ${a[1] - x}L${a[0] + x} ${a[1] + x}M${a[0] - x} ${a[1] + x}L${a[0] + x} ${a[1] - x}`}
                stroke="#1f6feb"
                strokeWidth={w}
              />
            )}
          </g>
        );
      })}
      <text x={box[2] + 0.6} y={box[1] - 0.4} fontSize={1.6} fill="#1f4e79" className="sch-ref">
        {part.ref}
      </text>
      <text x={box[2] + 0.6} y={box[3] + 1.8} fontSize={1.4} fill="#555">
        {part.value}
      </text>
    </g>
  );
}

function PowerGlyph({
  power,
  selected,
  px1,
}: {
  power: SchematicPower;
  selected: boolean;
  px1: number;
}) {
  const [x, y] = power.at;
  const c = selected ? '#2f81f7' : '#8a1c1c';
  const w = Math.max(0.254, (selected ? 2 : 1) * px1);
  return (
    // Turned clockwise about its connection point, as parts are (y down: SVG rotate is clockwise).
    <g data-testid={`sch-power-${power.id}`} transform={`rotate(${power.rotationDeg} ${x} ${y})`}>
      {power.style === 'ground' ? (
        <path
          d={`M${x} ${y}V${y + 1.27}M${x - 1.27} ${y + 1.27}H${x + 1.27}M${x - 0.762} ${y + 1.778}H${x + 0.762}M${x - 0.254} ${y + 2.286}H${x + 0.254}`}
          stroke={c}
          strokeWidth={w}
          fill="none"
        />
      ) : (
        <path
          d={`M${x} ${y}V${y - 1.27}M${x - 1.27} ${y - 1.27}H${x + 1.27}`}
          stroke={c}
          strokeWidth={w}
          fill="none"
        />
      )}
      <text
        x={x}
        y={power.style === 'ground' ? y + 4 : y - 1.9}
        fontSize={1.4}
        textAnchor="middle"
        fill={c}
      >
        {power.name}
      </text>
    </g>
  );
}

/**
 * True when a key belongs to a Host dialog, not to the canvas: the key comes from inside a
 * dialog, or a modal dialog is open, that does not hold the canvas.
 */
function behindModal(target: EventTarget | null, canvas: Element | null): boolean {
  const layers = '[role="dialog"],[role="alertdialog"],dialog';
  const outside = (layer: Element | null | undefined) => !!layer && !layer.contains(canvas);
  if (target instanceof Element && outside(target.closest(layers))) return true;
  return [...document.querySelectorAll('[aria-modal="true"],dialog[open]')].some(outside);
}

type Drag =
  | { kind: 'pan'; start: Vec2; center: Vec2 }
  | { kind: 'move'; ids: string[]; start: Vec2; from: Vec2; moved: boolean };

export function SheetCanvas({
  controller,
  state,
  tool,
  symbol,
  names,
  fitKey,
  overlay,
  onCursor,
  onToolDone,
}: {
  controller: SchematicController;
  state: SchematicState;
  tool: SchematicTool;
  symbol: string;
  /** The label and power names to place, read when placing. */
  names: { readonly current: { label: string; power: string } };
  fitKey: number;
  /** A simulation result to draw over the sheet (SL5b). */
  overlay?: SchematicSimOverlay;
  onCursor(p: Vec2 | undefined): void;
  onToolDone(): void;
}) {
  const settle = useSettle();
  const select = useSelect(controller);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  /** False until the viewport is measured: the first fit waits for the real size. */
  const [measured, setMeasured] = useState(false);
  const [view, setView] = useState<SchematicView>();
  const [points, setPoints] = useState<Vec2[]>([]);
  const [hover, setHover] = useState<Vec2>();
  const [placeRotation, setPlaceRotation] = useState<0 | 90 | 180 | 270>(0);
  const drag = useRef<Drag | undefined>(undefined);
  const [delta, setDelta] = useState<Vec2>();
  const doc = state.content;
  const [sw, sh] = schematicSheetSize(doc.sheet);
  const bounds = useMemo(() => [0, 0, sw, sh] as const, [sw, sh]);
  const symbols = useMemo(() => new Map(doc.symbols.map((s) => [s.id, s])), [doc.symbols]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.max(r.width, 1), height: Math.max(r.height, 1) });
      if (r.width >= 1 && r.height >= 1) setMeasured(true);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setView(fitSchematicView(bounds, size));
  }, [fitKey, bounds, measured]);
  useEffect(() => setPoints([]), [tool]);
  const v = view ?? fitSchematicView(bounds, size);

  const local = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toSheet = (px: Vec2): Vec2 => snapSchematic(screenToSheet(v, size, px));
  const near = (a: Vec2, px: Vec2) => {
    const s = sheetToScreen(v, size, a);
    return Math.hypot(s[0] - px[0], s[1] - px[1]) <= pickPx;
  };
  /** Points a wire can end on: pin ends, wire vertices, labels, power ports, junctions. */
  const connectionPoints = useMemo(() => {
    const out: Vec2[] = placedPins(doc).map((p) => fromGrid(p.end));
    for (const w of doc.wires) out.push(...w.points);
    for (const x of [...doc.labels, ...doc.powers, ...doc.junctions]) out.push(x.at);
    return out;
  }, [doc]);
  const hit = (px: Vec2): string | undefined => {
    for (const j of doc.junctions) if (near(j.at, px)) return j.id;
    for (const x of [...doc.labels, ...doc.powers]) if (near(x.at, px)) return x.id;
    const p = screenToSheet(v, size, px);
    for (const part of [...doc.parts].reverse()) {
      const s = symbols.get(part.symbol);
      if (!s) continue;
      const [x0, y0, x1, y1] = partBox(part, s);
      if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) return part.id;
    }
    const tol = pickPx / v.pxPerMm;
    for (const w of doc.wires)
      for (let i = 1; i < w.points.length; i++)
        if (segmentDistance(p, w.points[i - 1], w.points[i]) <= tol) return w.id;
    return undefined;
  };

  const finishWire = (pts: Vec2[]) => {
    if (pts.length >= 2 && !controller.addWire(pts)) setPoints([]);
    else if (pts.length < 2) setPoints([]);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTextInput(e.target) || behindModal(e.target, host.current))
        return;
      if (e.key === 'Escape') {
        // Cancelling a drag leaves content and history unchanged; the release does nothing.
        if (drag.current) {
          drag.current = undefined;
          setDelta(undefined);
        } else if (points.length) setPoints([]);
        else onToolDone();
      } else if (e.key === 'Enter' && tool === 'wire') {
        e.preventDefault();
        finishWire(points);
      } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
        if (tool === 'part') setPlaceRotation((r) => ((r + 90) % 360) as 0);
        else if (tool === 'select' && !state.readOnly) settle(() => controller.rotateSelection());
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select') {
        if (state.selection.length && !state.readOnly) {
          e.preventDefault();
          settle(() => controller.deleteSelection());
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = local(e);
    const panButton = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    if (panButton) {
      drag.current = { kind: 'pan', start: px, center: v.center };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // Settle the Inspector's inputs first (each item has its own Inspector, keyed by ID): every
    // left press below may edit or select.
    let settled = false;
    settle(() => (settled = true));
    if (!settled) return;
    const p = toSheet(px);
    switch (tool) {
      case 'part':
        controller.addPart(symbol, p, placeRotation);
        return;
      case 'label':
        controller.addLabel(names.current.label, p);
        return;
      case 'power':
        controller.addPower(
          names.current.power,
          names.current.power.toUpperCase().includes('GND') ? 'ground' : 'rail',
          p,
        );
        return;
      case 'junction':
        controller.addJunction(p);
        return;
      case 'wire': {
        if (!points.length) {
          setPoints([p]);
          return;
        }
        const next = [...points, ...wireLeg(points[points.length - 1], p)];
        // Ending on a connection point finishes the wire.
        if (connectionPoints.some((c) => c[0] === p[0] && c[1] === p[1]) && next.length >= 2)
          finishWire(next);
        else setPoints(next);
        return;
      }
    }
    const id = hit(px);
    if (id) {
      const ids = state.selection.includes(id) ? state.selection : [id];
      if (!select(ids)) return;
      if (!state.readOnly) {
        drag.current = { kind: 'move', ids, start: px, from: p, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    select([]);
    drag.current = { kind: 'pan', start: px, center: v.center };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = local(e);
    const p = toSheet(px);
    onCursor(p);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView({
        pxPerMm: v.pxPerMm,
        center: [
          d.center[0] - (px[0] - d.start[0]) / v.pxPerMm,
          d.center[1] - (px[1] - d.start[1]) / v.pxPerMm,
        ],
      });
      return;
    }
    if (!d.moved && Math.hypot(px[0] - d.start[0], px[1] - d.start[1]) < 3) return;
    d.moved = true;
    const g0 = toGrid(d.from);
    const g1 = toGrid(p);
    setDelta(fromGrid([g1[0] - g0[0], g1[1] - g0[1]]));
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = undefined;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.kind === 'move' && d.moved && delta && (delta[0] || delta[1]))
      controller.moveSelection(delta);
    setDelta(undefined);
  };
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    setView(zoomSchematicView(v, size, local(e), Math.exp(-e.deltaY * 0.0015)));
  };

  // While dragging, draw the moved drawing (wires following) without changing the document.
  const shown: SchematicDocument = useMemo(() => {
    if (!delta || !state.selection.length) return doc;
    try {
      return schematicMove(doc, state.selection, delta);
    } catch {
      return doc;
    }
  }, [doc, delta, state.selection]);
  const [vx, vy, vw, vh] = schematicViewBox(v, size);
  const px1 = 1 / v.pxPerMm;
  const sel = new Set(state.selection);
  const wireWidth = Math.max(0.2, 1.5 * px1);
  const preview =
    tool === 'wire' && points.length && hover
      ? [...points, ...wireLeg(points[points.length - 1], hover)]
      : points;
  return (
    <div className="sch-viewport" ref={host}>
      <svg
        className="sch-canvas"
        data-testid="sch-canvas"
        data-tool={tool}
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          // Both presses of a double-click land on the last point (no new leg); finish there.
          if (tool === 'wire') finishWire(points);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          onCursor(undefined);
          setHover(undefined);
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="sch-grid" width={2.54} height={2.54} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={Math.max(0.12, px1)} fill="#c9d1d9" />
          </pattern>
        </defs>
        <rect
          x={0}
          y={0}
          width={sw}
          height={sh}
          fill="#ffffff"
          stroke="#8b949e"
          strokeWidth={px1}
        />
        {v.pxPerMm * 2.54 >= 6 && (
          <rect x={0} y={0} width={sw} height={sh} fill="url(#sch-grid)" pointerEvents="none" />
        )}
        <text x={sw - 4} y={sh - 4} fontSize={3} textAnchor="end" fill="#57606a">
          {doc.sheet.title}
        </text>
        {shown.wires.map((w) => (
          <polyline
            key={w.id}
            data-testid={`sch-wire-${w.id}`}
            points={w.points.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke={sel.has(w.id) ? '#2f81f7' : '#1a7f37'}
            strokeWidth={wireWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {shown.parts.map((part) => {
          const s = symbols.get(part.symbol);
          return s ? (
            <PartGlyph key={part.id} part={part} symbol={s} selected={sel.has(part.id)} px1={px1} />
          ) : null;
        })}
        {shown.junctions.map((j) => (
          <circle
            key={j.id}
            data-testid={`sch-junction-${j.id}`}
            cx={j.at[0]}
            cy={j.at[1]}
            r={0.5}
            fill={sel.has(j.id) ? '#2f81f7' : '#1a7f37'}
          />
        ))}
        {shown.labels.map((l) => (
          <g
            key={l.id}
            data-testid={`sch-label-${l.id}`}
            transform={`rotate(${l.rotationDeg} ${l.at[0]} ${l.at[1]})`}
          >
            <path
              d={`M${l.at[0]} ${l.at[1]}l-0.8 -1.2h-${0.95 * l.name.length + 1.2}v2.4h${0.95 * l.name.length + 1.2}z`}
              fill="#fff8c5"
              stroke={sel.has(l.id) ? '#2f81f7' : '#9a6700'}
              strokeWidth={Math.max(0.15, px1)}
            />
            <text
              x={l.at[0] - 1.4}
              y={l.at[1] + 0.55}
              fontSize={1.6}
              textAnchor="end"
              fill="#6e4b00"
            >
              {l.name}
            </text>
          </g>
        ))}
        {shown.powers.map((p) => (
          <PowerGlyph key={p.id} power={p} selected={sel.has(p.id)} px1={px1} />
        ))}
        {preview.length > 0 && (
          <polyline
            data-testid="sch-wire-preview"
            points={preview.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="#2f81f7"
            strokeWidth={wireWidth}
            strokeDasharray={`${4 * px1} ${3 * px1}`}
          />
        )}
        {overlay?.leds.map((l) => (
          <circle
            key={`glow-${l.id}`}
            data-testid={`sch-sim-glow-${l.id}`}
            data-glow={l.glow.toFixed(3)}
            cx={l.at[0]}
            cy={l.at[1]}
            r={3.2}
            fill={l.color}
            opacity={0.6 * l.glow}
            pointerEvents="none"
          />
        ))}
        {overlay?.tags.map((t) => (
          <g key={`tag-${t.key}`} data-testid={`sch-sim-tag-${t.net}`} pointerEvents="none">
            <rect
              x={t.at[0] + 0.4}
              y={t.at[1] - 3.9}
              width={0.95 * t.text.length + 0.8}
              height={2.2}
              rx={0.4}
              fill="#ddf4ff"
              stroke="#0969da"
              strokeWidth={Math.max(0.1, px1)}
            />
            <text x={t.at[0] + 0.8} y={t.at[1] - 2.3} fontSize={1.5} fill="#0a3069">
              {t.text}
            </text>
          </g>
        ))}
        {tool !== 'select' && hover && (
          <circle cx={hover[0]} cy={hover[1]} r={3 * px1} fill="#2f81f7" />
        )}
      </svg>
      {(tool !== 'select' || state.notice) && (
        <p className="sch-viewport-note" role="status">
          {state.notice ? schematicNoticeText(state.notice) : toolInfo[tool].hint}
        </p>
      )}
    </div>
  );
}
