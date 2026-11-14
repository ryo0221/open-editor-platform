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
  Box,
  BoxSelect,
  CircleDot,
  Cpu,
  FlipHorizontal2,
  Maximize,
  MousePointer2,
  PenTool,
  Redo2,
  RotateCcw,
  Spline,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  CommitInput,
  EditorHistoryContext,
  EditorInputsContext,
  EditorLayout,
  IconButton,
  isTextInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  componentCourtyard,
  componentPads,
  componentTransform,
  generateFootprint,
  loopArea,
  loopBounds,
  loopEdges,
  pcbGenerators,
  pcbCopperLayerNames,
  pcbPadNet,
  pcbPadNets,
  pcbParsePin,
  pcbPinText,
  pcbPlacementProblems,
  pcbDrc,
  pcbFabricationFiles,
  pcbFabricationZip,
  type PcbFabFile,
  pcbRatsnest,
  pcbTrapezoidPath,
  type PcbDrcResult,
  type PcbDrcRule,
  type PcbDrcViolation,
  pcbZoneFills,
  pcbPadConnections,
  segmentDistance,
  type PcbZone,
  type PcbZoneFill,
  pcbSides,
  pointInLoop,
  transformLoop,
  type PcbComponent,
  type PcbFootprint,
  type PcbNet,
  type PcbNetClass,
  type PcbTrack,
  type PcbVia,
  type PcbPlacementProblem,
  pcbCopperCounts,
  pcbFinishes,
  pcbLayerNames,
  pcbMaskColors,
  pcbSilkColors,
  type PcbHole,
  type Vec2,
} from '@editor-platform/pcb-core';
import type { PcbKernel } from './kernel';
import { constrain45, pcbLayerColor, pcbRouteTarget } from './routing';
import { StackPanel, useStackedBoards, type PcbBoardSource } from './stack';
import { SchematicSyncPanel, type PcbSchematicSource } from './schematic-sync';
import { PcbView3d } from './view3d';
import { pcbBoardSize, type PcbController, type PcbNotice, type PcbState } from './controller';
import {
  boardToScreen,
  drawnGridStep,
  fitPcbView,
  loopsPath,
  pcbGridSteps,
  pcbViewBox,
  screenToBoard,
  snapToGrid,
  zoomPcbView,
  type PcbView,
} from './view';

export type PcbTool = 'select' | 'hole' | 'outline' | 'part' | 'route' | 'zone';
const toolInfo: Record<PcbTool, { label: string; hint: string }> = {
  select: { label: 'Select', hint: '' },
  hole: { label: 'Add mounting hole', hint: 'Click to place a hole. Esc to stop.' },
  route: {
    label: 'Route track',
    hint: 'Click a pad to start, click to bend, click a pad of the same net or press Enter to finish. V adds a via and changes layer; Esc cancels.',
  },
  zone: {
    label: 'Draw zone',
    hint: 'Pick the net in the inspector, then click the corners on the active layer; Enter or click the first corner to close. Esc to cancel.',
  },
  part: {
    label: 'Place part',
    hint: 'Pick a part in the inspector, then click to place it. Esc to stop.',
  },
  outline: {
    label: 'Draw board outline',
    hint: 'Click the corners; Enter or click the first corner to close. Esc to cancel.',
  },
};
export const maskFill: Record<string, string> = {
  green: '#1f7a3e',
  red: '#b3261e',
  blue: '#1d4f91',
  black: '#1d1f22',
  white: '#e8e8e4',
  purple: '#5b2a86',
};

/** Words for a refusal's code; the code itself is shown too. */
const noticeWords: Record<string, string> = {
  'hole-outside': 'The hole must lie inside the board, clear of its edge.',
  'hole-in-cutout': 'The hole overlaps a cut-out.',
  'holes-overlap': 'Holes may not overlap.',
  'hole-keepout': 'The keep-out must be 0 or larger than the drill.',
  'loop-not-simple': 'The outline crosses or touches itself.',
  'loop-vertices': 'An outline needs at least 3 corners.',
  'loop-duplicate-vertex': 'Two consecutive corners are at the same point.',
  'limit-board-size': 'The board is larger than 1000 mm.',
  'cutout-outside': 'A cut-out must lie inside the board.',
  'corner-radius': 'The corner radius must be less than half the shorter side.',
  'permission-denied': 'This board is read only.',
  dimension: 'The value is out of range.',
  'generator-param': 'A part setting is out of range.',
  ref: 'A reference starts with a letter, then letters, digits or _ (like R12).',
  'ref-duplicate': 'Another part already has this reference.',
  rotation: 'The rotation must be at least 0 and less than 360.',
  'in-use': 'It is still in use (a footprint by a part, a class by a net, a net by copper).',
  'zone-no-net': 'Add a net first; a zone pours one net.',
  priority: 'The priority is a whole number from 0 to 100.',
  'limit-count': 'Too many items for one board.',
  'route-no-net': 'Start a track on a pad, via or track that is in a net.',
  'route-other-net': 'That copper belongs to another net.',
  layer: 'The board has no such copper layer.',
  'track-zero-length': 'A track needs two different ends.',
  'net-pin-missing': 'No such pin: write pins as REF.PAD of a placed part (like J1.6).',
  'net-pin-duplicate': 'A pad belongs to one net only.',
  'net-name-duplicate': 'Another net already has this name.',
  'net-class-missing': 'No net class has that name.',
  'net-class-name-duplicate': 'Another net class already has this name.',
  'via-drill': 'The via drill must be smaller than its diameter.',
  json: 'The net list is not valid JSON.',
  name: 'The name is empty or has spaces at its ends.',
  locked: 'The part is locked: unlock it to move or turn it.',
};
/** Words for a placement problem; shown, never refused. */
const problemWords: Record<PcbPlacementProblem['code'], string> = {
  'courtyard-overlap': 'Parts overlap',
  'part-outside-board': 'Part leaves the board',
  'part-over-hole': 'Part is over a hole',
};
/** Words for a DRC rule (PB5). */
const drcWords: Record<PcbDrcRule, string> = {
  short: 'Short',
  clearance: 'Clearance',
  'edge-clearance': 'Too near the edge',
  'hole-clearance': 'Too near a hole',
  'track-width': 'Track too narrow',
  'drill-size': 'Drill too small',
  'annular-ring': 'Annular ring too thin',
  unconnected: 'Not connected',
  'silk-over-pad': 'Silkscreen over a pad',
  'courtyard-overlap': 'Parts overlap',
  'part-outside-board': 'Part leaves the board',
  'part-over-hole': 'Part is over a hole',
};
/** Pad copper colours per side; bottom-side parts are drawn see-through. */
const copper = { top: '#d4a72c', bottom: '#5b8dd6' } as const;
export const pcbNoticeText = (n: PcbNotice) =>
  `${noticeWords[n.code] ?? 'The edit was refused.'} (${n.code})`;

export function usePcbState(controller: PcbController): PcbState {
  return useSyncExternalStore(
    useCallback((fn) => controller.subscribe(fn), [controller]),
    () => controller.state,
  );
}
/**
 * Commits the inspector's pending inputs before `run`; when one is refused, `run` is skipped
 * (the input keeps its draft and shows why) and the result is false.
 */
function useSettle() {
  const inputs = useContext(EditorInputsContext);
  return (run: () => void): boolean => {
    try {
      inputs?.flush();
    } catch {
      return false;
    }
    run();
    return true;
  };
}
const mm = (v: number) => String(Math.round(v * 1e4) / 1e4);
const num = (s: string) => Number(s);

export function PcbSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
  kernel,
  boards,
  schematics,
}: {
  controller: PcbController;
  name: string;
  /** The geometry kernel for the 3D view (PB7b); without it the view says it is missing. */
  kernel?: PcbKernel;
  /** PB8: the Host's other boards, for stacking one over this board in 3D. */
  boards?: PcbBoardSource;
  /** SL3: the Host's schematics, whose parts and nets this board can take. */
  schematics?: PcbSchematicSource;
  /** The Host shows Undo/Redo itself (Playground); else the Surface's toolbar has them. */
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
}) {
  const state = usePcbState(controller);
  const [tool, setTool] = useState<PcbTool>('select');
  const [grid, setGrid] = useState<number>(0.5);
  const [snap, setSnap] = useState(true);
  const [fitKey, setFitKey] = useState(0);
  const [cursor, setCursor] = useState<Vec2>();
  const [placing, setPlacing] = useState<PcbPlacing>(() => defaultPlacing('chip'));
  // The latest settings, also between renders: inputs committed by a flush just before a click
  // must reach the part that click places.
  const placingRef = useRef(placing);
  const updatePlacing = useCallback((change: (p: PcbPlacing) => PcbPlacing) => {
    placingRef.current = change(placingRef.current);
    setPlacing(placingRef.current);
  }, []);
  const settle = useSettle();
  const readOnly = state.readOnly;
  const activeTool: PcbTool = readOnly ? 'select' : tool;
  const copperNames = pcbCopperLayerNames(state.content.board.copperLayers);
  const [layerPick, setLayer] = useState('F.Cu');
  const activeLayer = copperNames.includes(layerPick) ? layerPick : 'F.Cu';
  const [angle45, setAngle45] = useState(true);
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
  const size = pcbBoardSize(state.content.board);
  const selected = state.content.holes.find((h) => h.id === state.selection[0]);
  const selectedPart = state.content.components.find((c) => c.id === state.selection[0]);
  const problems = useMemo(() => pcbPlacementProblems(state.content), [state.content]);
  const selectedNet = state.content.nets.find((n) => n.id === state.selection[0]);
  const selectedTrack = state.content.tracks.find((t) => t.id === state.selection[0]);
  const selectedVia = state.content.vias.find((t) => t.id === state.selection[0]);
  const selectedZone = state.content.zones.find((z) => z.id === state.selection[0]);
  // One fill for the screen, the ratsnest and (later) DRC and Gerber.
  const fills = useMemo(() => pcbZoneFills(state.content), [state.content]);
  const unrouted = useMemo(() => pcbRatsnest(state.content, fills).length, [state.content, fills]);
  const drc = useMemo(() => pcbDrc(state.content, fills), [state.content, fills]);
  /** A place the view is asked to centre on (a DRC finding), with a counter to repeat it. */
  const [focus, setFocus] = useState<{ at: Vec2; n: number }>();
  const [zoneNetPick, setZoneNet] = useState('');
  const [view3d, setView3d] = useState(false);
  const stacked = useStackedBoards(state.content, view3d ? boards : undefined);
  const zoneNet = state.content.nets.some((n) => n.id === zoneNetPick)
    ? zoneNetPick
    : (state.content.nets.find((n) => n.name === 'GND') ?? state.content.nets[0])?.id;
  return (
    <div className="pcb-surface" data-testid="pcb-surface">
      <EditorLayout
        viewKey="pcb"
        leftLabel="Board"
        inspectorLabel="Inspector"
        toolbar={
          <Toolbar label="Board tools">
            {!hostHistory && (
              <>
                <IconButton icon={Undo2} label="Undo" onClick={onUndo} />
                <IconButton icon={Redo2} label="Redo" onClick={onRedo} />
              </>
            )}
            {(
              [
                ['select', MousePointer2],
                ['hole', CircleDot],
                ['outline', PenTool],
                ['part', Cpu],
                ['route', Spline],
                ['zone', BoxSelect],
              ] as const
            ).map(([t, icon]) => (
              <IconButton
                key={t}
                icon={icon}
                label={toolInfo[t].label}
                aria-pressed={activeTool === t}
                disabled={t !== 'select' && readOnly}
                reason="Read only"
                onClick={() => settle(() => setTool(t))}
              />
            ))}
            <IconButton icon={Maximize} label="Fit board" onClick={() => setFitKey((k) => k + 1)} />
            <IconButton
              icon={Box}
              label="3D view"
              aria-pressed={view3d}
              onClick={() => settle(() => setView3d((v) => !v))}
            />
            <label className="pcb-pick">
              Layer
              <select
                aria-label="Active layer"
                value={activeLayer}
                onChange={(e) => setLayer(e.target.value)}
              >
                {copperNames.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="pcb-pick">
              <input
                type="checkbox"
                aria-label="45° angles"
                checked={angle45}
                onChange={(e) => setAngle45(e.target.checked)}
              />
              45°
            </label>
            <label className="pcb-pick">
              Grid
              <select
                aria-label="Grid (mm)"
                value={grid}
                onChange={(e) => setGrid(Number(e.target.value))}
              >
                {pcbGridSteps.map((s) => (
                  <option key={s} value={s}>
                    {s} mm
                  </option>
                ))}
              </select>
            </label>
            <label className="pcb-pick">
              <input
                type="checkbox"
                aria-label="Snap to grid"
                checked={snap}
                onChange={(e) => setSnap(e.target.checked)}
              />
              Snap
            </label>
          </Toolbar>
        }
        left={
          <BoardTree
            controller={controller}
            state={state}
            problems={problems}
            drc={drc}
            fills={fills}
            onFocus={(at) => setFocus((f) => ({ at, n: (f?.n ?? 0) + 1 }))}
          />
        }
        inspector={
          <div className="pcb-inspector">
            {activeTool === 'part' ? (
              <PlacePanel placing={placing} onChange={updatePlacing} />
            ) : activeTool === 'zone' ? (
              <ZonePanel state={state} net={zoneNet} onNet={setZoneNet} layer={activeLayer} />
            ) : selectedZone ? (
              <ZoneInspector
                controller={controller}
                state={state}
                zone={selectedZone}
                fill={fills.find((f) => f.zone === selectedZone.id)}
                readOnly={readOnly}
              />
            ) : selectedPart ? (
              <PartInspector
                controller={controller}
                state={state}
                part={selectedPart}
                readOnly={readOnly}
              />
            ) : selectedTrack ? (
              <TrackInspector
                controller={controller}
                state={state}
                track={selectedTrack}
                readOnly={readOnly}
              />
            ) : selectedVia ? (
              <ViaInspector
                controller={controller}
                state={state}
                via={selectedVia}
                readOnly={readOnly}
              />
            ) : selectedNet ? (
              <NetInspector
                controller={controller}
                state={state}
                fills={fills}
                net={selectedNet}
                readOnly={readOnly}
              />
            ) : selected ? (
              <HoleInspector controller={controller} hole={selected} readOnly={readOnly} />
            ) : (
              <BoardInspector
                controller={controller}
                state={state}
                boards={boards}
                schematics={schematics}
              />
            )}
          </div>
        }
        status={
          <span className="pcb-status" data-testid="pcb-status">
            {name} · {mm(size.width)} × {mm(size.height)} mm · {state.content.board.copperLayers}{' '}
            copper layers · {state.content.holes.length} holes · {state.content.components.length}{' '}
            parts · {state.content.nets.length} nets · {state.content.tracks.length} tracks ·{' '}
            {state.content.vias.length} vias · {state.content.zones.length} zones · {unrouted}{' '}
            unrouted
            {problems.length ? ` · ${problems.length} placement problems` : ''}
            {` · ${drc.errors} DRC errors`}
            {cursor && ` · x ${mm(cursor[0])} y ${mm(cursor[1])}`}
          </span>
        }
        {...layout}
      >
        {view3d ? (
          <PcbView3d
            doc={state.content}
            fills={fills}
            kernel={kernel}
            fileStem={fileStem(name)}
            current={() => controller.state.content}
            stacked={view3d ? stacked : undefined}
          />
        ) : (
          <BoardCanvas
            controller={controller}
            state={state}
            tool={activeTool}
            grid={grid}
            snap={snap}
            fitKey={fitKey}
            placing={placing}
            latestPlacing={() => placingRef.current}
            layer={activeLayer}
            angle45={angle45}
            onLayer={setLayer}
            fills={fills}
            zoneNet={zoneNet}
            drc={drc.violations}
            focus={focus}
            problems={problems}
            onCursor={setCursor}
            onToolDone={() => setTool('select')}
          />
        )}
      </EditorLayout>
    </div>
  );
}

function BoardTree({
  controller,
  state,
  problems,
  drc,
  fills,
  onFocus,
}: {
  controller: PcbController;
  state: PcbState;
  problems: PcbPlacementProblem[];
  drc: PcbDrcResult;
  fills: PcbZoneFill[];
  onFocus(at: Vec2): void;
}) {
  const settle = useSettle();
  const layers = pcbLayerNames(state.content.board.copperLayers);
  const names = new Map(state.content.footprints.map((f) => [f.id, f.name]));
  const label = (id: string) =>
    state.content.components.find((c) => c.id === id)?.ref ??
    state.content.holes.find((h) => h.id === id)?.name ??
    id;
  const warnings = drc.violations.length - drc.errors;
  const known = new Set(
    [
      state.content.components,
      state.content.holes,
      state.content.tracks,
      state.content.vias,
      state.content.zones,
    ].flatMap((l) => l.map((e) => e.id)),
  );
  const detail = (v: PcbDrcViolation) =>
    v.distanceMm !== undefined && v.requiredMm !== undefined
      ? ` (${mm(v.distanceMm)} < ${mm(v.requiredMm)} mm)`
      : '';
  return (
    <div className="pcb-tree">
      <Section title="Parts">
        {state.content.components.length === 0 ? (
          <p className="pcb-empty">No parts yet.</p>
        ) : (
          <ul className="pcb-list" aria-label="Parts">
            {state.content.components.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={state.selection.includes(c.id)}
                  onClick={() => settle(() => controller.select([c.id]))}
                >
                  {c.ref} · {names.get(c.footprint) ?? c.footprint}
                  {c.side === 'bottom' ? ' · bottom' : ''}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Nets">
        {state.content.nets.length === 0 ? (
          <p className="pcb-empty">No nets yet.</p>
        ) : (
          <ul className="pcb-list" aria-label="Nets">
            {state.content.nets.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  aria-pressed={state.selection.includes(n.id)}
                  onClick={() => settle(() => controller.select([n.id]))}
                >
                  {n.name} · {n.pins.length} pins
                </button>
              </li>
            ))}
          </ul>
        )}
        {!state.readOnly && (
          <button
            type="button"
            className="pcb-add"
            onClick={() => settle(() => controller.addNet())}
          >
            Add net
          </button>
        )}
      </Section>
      {state.content.zones.length > 0 && (
        <Section title="Zones">
          <ul className="pcb-list" aria-label="Zones">
            {state.content.zones.map((z) => (
              <li key={z.id}>
                <button
                  type="button"
                  aria-pressed={state.selection.includes(z.id)}
                  onClick={() => settle(() => controller.select([z.id]))}
                >
                  {state.content.nets.find((n) => n.id === z.net)?.name ?? z.net} · {z.layer}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="DRC">
        <p className="pcb-drc-summary" data-testid="pcb-drc-summary">
          {drc.errors} errors · {warnings} warnings
        </p>
        {drc.violations.length > 0 && (
          <ul className="pcb-list pcb-problems" aria-label="DRC">
            {drc.violations.map((v, i) => (
              <li key={i} data-severity={v.severity}>
                <button
                  type="button"
                  onClick={() => {
                    if (settle(() => controller.select(v.items.filter((id) => known.has(id)))))
                      onFocus(v.at);
                  }}
                >
                  {drcWords[v.rule]}: {v.items.map(label).join(', ')}
                  {v.layer ? ` · ${v.layer}` : ''}
                  {detail(v)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <FabricationPanel controller={controller} state={state} drc={drc} fills={fills} />
      {problems.length > 0 && (
        <Section title="Placement problems">
          <ul className="pcb-list pcb-problems" aria-label="Placement problems">
            {problems.map((p, i) => (
              <li key={i}>
                <button type="button" onClick={() => settle(() => controller.select(p.ids))}>
                  {problemWords[p.code]}: {p.ids.map(label).join(', ')}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Holes">
        {state.content.holes.length === 0 ? (
          <p className="pcb-empty">No holes yet.</p>
        ) : (
          <ul className="pcb-list" aria-label="Holes">
            {state.content.holes.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  aria-pressed={state.selection.includes(h.id)}
                  onClick={() => settle(() => controller.select([h.id]))}
                >
                  {h.name} · Ø{mm(h.drillMm)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Layers">
        <ul className="pcb-list pcb-layers" aria-label="Layers">
          {layers.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** A safe file-name stem: letters, digits, `-` and `_`. */
const fileStem = (text: string) => text.trim().replace(/[^A-Za-z0-9_-]+/g, '_') || 'board';

/**
 * Fabrication data (PB6): Gerber per layer, drill files, BOM and placement CSV, as one zip
 * download. The zone copper is the fill the screen and DRC use. The inspector's pending inputs
 * are committed first: a refused one keeps its draft and nothing is exported, and the files are
 * written from the board as it is after the commit.
 */
function FabricationPanel({
  controller,
  state,
  drc,
  fills,
}: {
  controller: PcbController;
  state: PcbState;
  drc: PcbDrcResult;
  fills: PcbZoneFill[];
}) {
  const settle = useSettle();
  const [name, setName] = useState('board');
  // The committed name, read after the inputs are settled (state updates are not yet rendered).
  const nameRef = useRef(name);
  const [files, setFiles] = useState<PcbFabFile[]>([]);
  const exportZip = () => settle(writeZip);
  const writeZip = () => {
    const stem = fileStem(nameRef.current);
    const doc = controller.state.content;
    // The shown fills when the board is the one shown, else the same fill of the new board.
    const out = pcbFabricationFiles(doc, stem, doc === state.content ? fills : pcbZoneFills(doc));
    const zip = pcbFabricationZip(out);
    const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}-fabrication.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFiles(out);
  };
  return (
    <Section title="Fabrication">
      <CommitInput
        label="File name"
        value={name}
        onCommit={(v) => {
          const stem = fileStem(v);
          nameRef.current = stem;
          setName(stem);
          return stem;
        }}
      />
      {drc.errors > 0 && (
        <p className="pcb-empty" data-testid="pcb-fab-warning">
          {drc.errors} DRC errors: fix them before ordering.
        </p>
      )}
      <button type="button" onClick={exportZip}>
        Export Gerber, drill and CSV (zip)
      </button>
      {files.length > 0 && (
        <ul className="pcb-list" aria-label="Fabrication files" data-testid="pcb-fab-files">
          {files.map((f) => (
            <li key={f.name}>
              {f.name} · {f.role}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function BoardInspector({
  controller,
  state,
  boards,
  schematics,
}: {
  controller: PcbController;
  state: PcbState;
  boards: PcbBoardSource | undefined;
  schematics: PcbSchematicSource | undefined;
}) {
  const board = state.content.board;
  const size = pcbBoardSize(board);
  const readOnly = state.readOnly;
  const [rect, setRectState] = useState({ w: size.width, h: size.height, r: 1 });
  // The committed sizes, read after the inputs are settled (state updates are not yet rendered).
  const rectRef = useRef(rect);
  const setRect = (change: (r: typeof rect) => typeof rect) => {
    rectRef.current = change(rectRef.current);
    setRectState(rectRef.current);
  };
  const settle = useSettle();
  const commit = (run: () => string | undefined) => !run();
  return (
    <>
      <Section title="Board">
        <dl className="pcb-facts">
          <dt>Size</dt>
          <dd data-testid="pcb-board-size">
            {mm(size.width)} × {mm(size.height)} mm
          </dd>
          <dt>Area</dt>
          <dd>{mm(Math.abs(loopArea(board.outline)))} mm²</dd>
          <dt>Outline</dt>
          <dd>
            {board.outline.length} corners
            {board.cutouts.length ? `, ${board.cutouts.length} cut-outs` : ''}
          </dd>
        </dl>
        {!readOnly && (
          <fieldset className="pcb-rect">
            <legend>Rectangle from the origin</legend>
            <CommitInput
              label="Width (mm)"
              type="number"
              min={1}
              step={0.1}
              value={rect.w}
              onCommit={(v) => setRect((r) => ({ ...r, w: num(v) }))}
            />
            <CommitInput
              label="Height (mm)"
              type="number"
              min={1}
              step={0.1}
              value={rect.h}
              onCommit={(v) => setRect((r) => ({ ...r, h: num(v) }))}
            />
            <CommitInput
              label="Corner radius (mm)"
              type="number"
              min={0}
              step={0.1}
              value={rect.r}
              onCommit={(v) => setRect((r) => ({ ...r, r: num(v) }))}
            />
            <button
              type="button"
              onClick={() =>
                // A refused size keeps its draft and the outline stays as it is.
                settle(() => {
                  const { w, h, r } = rectRef.current;
                  controller.setRectangle(w, h, r);
                })
              }
            >
              Apply rectangle
            </button>
          </fieldset>
        )}
      </Section>
      <NetClasses controller={controller} state={state} />
      {!readOnly && <NetListImport controller={controller} />}
      <Section title="Design rules">
        <CommitInput
          label="Edge clearance (mm)"
          type="number"
          min={0.05}
          max={10}
          step={0.05}
          value={board.edgeClearanceMm}
          onCommit={(v) => commit(() => controller.setBoard({ edgeClearanceMm: num(v) }))}
        />
        <CommitInput
          label="Hole clearance (mm)"
          type="number"
          min={0.05}
          max={10}
          step={0.05}
          value={board.holeClearanceMm}
          onCommit={(v) => commit(() => controller.setBoard({ holeClearanceMm: num(v) }))}
        />
        <CommitInput
          label="Min track width (mm)"
          type="number"
          min={0.05}
          max={10}
          step={0.01}
          value={board.minTrackWidthMm}
          onCommit={(v) => commit(() => controller.setBoard({ minTrackWidthMm: num(v) }))}
        />
        <CommitInput
          label="Min drill (mm)"
          type="number"
          min={0.1}
          max={10}
          step={0.05}
          value={board.minDrillMm}
          onCommit={(v) => commit(() => controller.setBoard({ minDrillMm: num(v) }))}
        />
        <CommitInput
          label="Min annular ring (mm)"
          type="number"
          min={0.05}
          max={10}
          step={0.01}
          value={board.minAnnularRingMm}
          onCommit={(v) => commit(() => controller.setBoard({ minAnnularRingMm: num(v) }))}
        />
      </Section>
      <Section title="Stack-up">
        <CommitInput
          label="Thickness (mm)"
          type="number"
          min={0.2}
          max={6}
          step={0.1}
          value={board.thicknessMm}
          onCommit={(v) => commit(() => controller.setBoard({ thicknessMm: num(v) }))}
        />
        <Choice
          label="Copper layers"
          value={board.copperLayers}
          options={pcbCopperCounts}
          disabled={readOnly}
          onChange={(v) => controller.setBoard({ copperLayers: Number(v) as 2 })}
        />
        <Choice
          label="Solder mask"
          value={board.maskColor}
          options={pcbMaskColors}
          disabled={readOnly}
          onChange={(v) => controller.setBoard({ maskColor: v as 'green' })}
        />
        <Choice
          label="Silkscreen"
          value={board.silkColor}
          options={pcbSilkColors}
          disabled={readOnly}
          onChange={(v) => controller.setBoard({ silkColor: v as 'white' })}
        />
        <Choice
          label="Finish"
          value={board.finish}
          options={pcbFinishes}
          disabled={readOnly}
          onChange={(v) => controller.setBoard({ finish: v as 'hasl' })}
        />
      </Section>
      {schematics && (
        <SchematicSyncPanel controller={controller} state={state} source={schematics} />
      )}
      <StackPanel controller={controller} state={state} source={boards} />
    </>
  );
}

function Choice({
  label,
  value,
  options,
  disabled,
  names,
  onChange,
}: {
  label: string;
  value: string | number;
  options: readonly (string | number)[];
  disabled?: boolean;
  names?: Record<string, string>;
  onChange(v: string): void;
}) {
  return (
    <label className="ep-field">
      {label}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {names?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function HoleInspector({
  controller,
  hole,
  readOnly,
}: {
  controller: PcbController;
  hole: PcbHole;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const edit = (patch: Partial<PcbHole>) => !controller.updateHole({ ...hole, ...patch });
  return (
    <Section title={`Hole ${hole.name}`}>
      <CommitInput label="Name" value={hole.name} onCommit={(v) => edit({ name: v })} />
      <CommitInput
        label="X (mm)"
        type="number"
        step={0.01}
        value={hole.at[0]}
        onCommit={(v) => edit({ at: [num(v), hole.at[1]] })}
      />
      <CommitInput
        label="Y (mm)"
        type="number"
        step={0.01}
        value={hole.at[1]}
        onCommit={(v) => edit({ at: [hole.at[0], num(v)] })}
      />
      <CommitInput
        label="Drill (mm)"
        type="number"
        min={0.1}
        step={0.05}
        value={hole.drillMm}
        onCommit={(v) => edit({ drillMm: num(v) })}
      />
      <CommitInput
        label="Keep-out (mm)"
        type="number"
        min={0}
        step={0.05}
        value={hole.keepoutMm}
        onCommit={(v) => edit({ keepoutMm: num(v) })}
      />
      <label className="ep-field pcb-check">
        <input
          type="checkbox"
          aria-label="Plated"
          checked={hole.plated}
          disabled={readOnly}
          onChange={(e) => edit({ plated: e.target.checked })}
        />
        Plated
      </label>
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!readOnly && (
          <button type="button" onClick={() => controller.deleteSelection()}>
            <Trash2 size={14} aria-hidden="true" /> Delete hole
          </button>
        )}
      </div>
    </Section>
  );
}

/** A track run being routed (not yet in the document). */
interface PcbRouteRun {
  net: string;
  /** Corners from the start; segment i joins points[i] and points[i + 1] on segLayers[i]. */
  points: Vec2[];
  segLayers: string[];
  /** The layer the next segment goes on. */
  layer: string;
  vias: Vec2[];
}

/** What the Place part tool places next: a generator, its numbers and the side. */
export interface PcbPlacing {
  kind: string;
  params: Record<string, number | string>;
  side: PcbComponent['side'];
}
export function defaultPlacing(kind: string): PcbPlacing {
  const spec = pcbGenerators.get(kind)!;
  return {
    kind,
    params: Object.fromEntries(spec.params.map((p) => [p.name, p.default])),
    side: 'top',
  };
}
/** The footprint the tool would add, or the reason it cannot. */
function placingFootprint(placing: PcbPlacing): PcbFootprint | { error: string } {
  try {
    return generateFootprint('preview', placing.kind, placing.params);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function PlacePanel({
  placing,
  onChange,
}: {
  placing: PcbPlacing;
  onChange(change: (p: PcbPlacing) => PcbPlacing): void;
}) {
  const spec = pcbGenerators.get(placing.kind)!;
  const fp = placingFootprint(placing);
  return (
    <Section title="Place part">
      <Choice
        label="Part"
        value={placing.kind}
        options={[...pcbGenerators.keys()]}
        names={Object.fromEntries([...pcbGenerators.values()].map((g) => [g.kind, g.label]))}
        onChange={(k) => onChange(() => defaultPlacing(k))}
      />
      {spec.params.map((p) =>
        p.options ? (
          <Choice
            key={`${placing.kind}-${p.name}`}
            label={p.label}
            value={String(placing.params[p.name])}
            options={p.options}
            onChange={(v) => onChange((c) => ({ ...c, params: { ...c.params, [p.name]: v } }))}
          />
        ) : (
          <CommitInput
            key={`${placing.kind}-${p.name}`}
            label={p.label}
            type="number"
            min={p.min}
            max={p.max}
            step={p.step ?? 0.01}
            value={placing.params[p.name]}
            onCommit={(v) => onChange((c) => ({ ...c, params: { ...c.params, [p.name]: num(v) } }))}
          />
        ),
      )}
      <Choice
        label="Side"
        value={placing.side}
        options={pcbSides}
        onChange={(v) => onChange((c) => ({ ...c, side: v as PcbComponent['side'] }))}
      />
      <p className="pcb-empty" data-testid="pcb-place-summary">
        {'error' in fp
          ? `Cannot make this part (${fp.error}).`
          : `${fp.name} · ${fp.pads.length} pads · ${mm(fp.heightMm)} mm high`}
      </p>
    </Section>
  );
}

function PartInspector({
  controller,
  state,
  part,
  readOnly,
}: {
  controller: PcbController;
  state: PcbState;
  part: PcbComponent;
  readOnly: boolean;
}) {
  const fp = state.content.footprints.find((f) => f.id === part.footprint);
  const edit = (patch: Partial<PcbComponent>) => !controller.updateComponent({ ...part, ...patch });
  /** Position and rotation stay while the part is locked; unlocking is the way out. */
  const place = (patch: Partial<PcbComponent>) => {
    if (part.locked) {
      controller.report({ code: 'locked', ids: [part.id] });
      return false;
    }
    return edit(patch);
  };
  const fixed = readOnly || part.locked;
  const settle = useSettle();
  const padNets = useMemo(() => pcbPadNets(state.content), [state.content]);
  return (
    <Section title={`Part ${part.ref}`}>
      <dl className="pcb-facts">
        <dt>Footprint</dt>
        <dd>{fp?.name ?? part.footprint}</dd>
        <dt>Pads</dt>
        <dd>{fp?.pads.length ?? 0}</dd>
        <dt>Height</dt>
        <dd>{mm(fp?.heightMm ?? 0)} mm</dd>
      </dl>
      <CommitInput label="Reference" value={part.ref} onCommit={(v) => edit({ ref: v })} />
      <CommitInput label="Value" value={part.value} onCommit={(v) => edit({ value: v })} />
      <CommitInput
        label="X (mm)"
        type="number"
        step={0.01}
        value={part.at[0]}
        onCommit={(v) => place({ at: [num(v), part.at[1]] })}
      />
      <CommitInput
        label="Y (mm)"
        type="number"
        step={0.01}
        value={part.at[1]}
        onCommit={(v) => place({ at: [part.at[0], num(v)] })}
      />
      <CommitInput
        label="Rotation (°)"
        type="number"
        min={0}
        max={359.99}
        step={90}
        value={part.rotationDeg}
        onCommit={(v) => place({ rotationDeg: num(v) })}
      />
      <Choice
        label="Side"
        value={part.side}
        options={pcbSides}
        disabled={fixed}
        onChange={(v) => edit({ side: v as PcbComponent['side'] })}
      />
      <label className="ep-field pcb-check">
        <input
          type="checkbox"
          aria-label="Locked"
          checked={part.locked}
          disabled={readOnly}
          onChange={(e) => edit({ locked: e.target.checked })}
        />
        Locked
      </label>
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!fixed && (
          <>
            <button type="button" onClick={() => controller.rotateSelection(90)}>
              <RotateCcw size={14} aria-hidden="true" /> Rotate
            </button>
            <button type="button" onClick={() => controller.flipSelection()}>
              <FlipHorizontal2 size={14} aria-hidden="true" /> Flip
            </button>
            <button type="button" onClick={() => controller.deleteSelection()}>
              <Trash2 size={14} aria-hidden="true" /> Delete part
            </button>
          </>
        )}
      </div>
      {fp && fp.pads.length > 0 && (
        <table className="pcb-pins" aria-label="Pins">
          <thead>
            <tr>
              <th scope="col">Pad</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {fp.pads.map((pad) => (
              <tr key={pad.number}>
                <td>{pad.number}</td>
                <td>
                  <select
                    aria-label={`Net of pad ${pad.number}`}
                    value={pcbPadNet(padNets, part.id, pad.number) ?? ''}
                    disabled={readOnly || pad.type === 'npth'}
                    onChange={(e) =>
                      controller.setPadNet(part.id, pad.number, e.target.value || undefined)
                    }
                  >
                    <option value="">—</option>
                    {state.content.nets.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function ZonePanel({
  state,
  net,
  onNet,
  layer,
}: {
  state: PcbState;
  net: string | undefined;
  onNet(net: string): void;
  layer: string;
}) {
  const nets = state.content.nets;
  return (
    <Section title="New zone">
      {nets.length === 0 ? (
        <p className="pcb-empty">Add a net first; a zone pours one net.</p>
      ) : (
        <Choice
          label="Zone net"
          value={net ?? ''}
          options={nets.map((n) => n.id)}
          names={Object.fromEntries(nets.map((n) => [n.id, n.name]))}
          onChange={onNet}
        />
      )}
      <dl className="pcb-facts">
        <dt>Layer</dt>
        <dd>{layer}</dd>
      </dl>
    </Section>
  );
}

function ZoneInspector({
  controller,
  state,
  zone,
  fill,
  readOnly,
}: {
  controller: PcbController;
  state: PcbState;
  zone: PcbZone;
  fill: PcbZoneFill | undefined;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const nets = state.content.nets;
  const edit = (patch: Partial<PcbZone>) => !controller.updateZone({ ...zone, ...patch });
  const islands = fill ? new Set(fill.islands).size : 0;
  return (
    <Section title="Zone">
      <Choice
        label="Net"
        value={zone.net}
        options={nets.map((n) => n.id)}
        names={Object.fromEntries(nets.map((n) => [n.id, n.name]))}
        disabled={readOnly}
        onChange={(v) => edit({ net: v })}
      />
      <Choice
        label="Layer"
        value={zone.layer}
        options={pcbCopperLayerNames(state.content.board.copperLayers)}
        disabled={readOnly}
        onChange={(v) => edit({ layer: v })}
      />
      <CommitInput
        label="Priority"
        type="number"
        min={0}
        max={100}
        step={1}
        value={zone.priority}
        onCommit={(v) => edit({ priority: num(v) })}
      />
      <CommitInput
        label="Clearance (mm)"
        type="number"
        min={0.05}
        max={10}
        step={0.05}
        value={zone.clearanceMm}
        onCommit={(v) => edit({ clearanceMm: num(v) })}
      />
      <Choice
        label="Pad connection"
        value={zone.padConnection}
        options={pcbPadConnections}
        disabled={readOnly}
        onChange={(v) => edit({ padConnection: v as PcbZone['padConnection'] })}
      />
      <CommitInput
        label="Thermal gap (mm)"
        type="number"
        min={0.05}
        max={10}
        step={0.05}
        value={zone.thermalGapMm}
        onCommit={(v) => edit({ thermalGapMm: num(v) })}
      />
      <CommitInput
        label="Spoke width (mm)"
        type="number"
        min={0.05}
        max={10}
        step={0.05}
        value={zone.spokeWidthMm}
        onCommit={(v) => edit({ spokeWidthMm: num(v) })}
      />
      <dl className="pcb-facts">
        <dt>Filled</dt>
        <dd data-testid="pcb-zone-area">{mm(fill?.areaMm2 ?? 0)} mm²</dd>
        <dt>Islands</dt>
        <dd>{islands}</dd>
      </dl>
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!readOnly && (
          <button type="button" onClick={() => controller.deleteSelection()}>
            <Trash2 size={14} aria-hidden="true" /> Delete zone
          </button>
        )}
      </div>
    </Section>
  );
}

function TrackInspector({
  controller,
  state,
  track,
  readOnly,
}: {
  controller: PcbController;
  state: PcbState;
  track: PcbTrack;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const net = state.content.nets.find((n) => n.id === track.net);
  const edit = (patch: Partial<PcbTrack>) => !controller.updateTrack({ ...track, ...patch });
  const length = Math.hypot(track.to[0] - track.from[0], track.to[1] - track.from[1]);
  return (
    <Section title="Track">
      <dl className="pcb-facts">
        <dt>Net</dt>
        <dd>{net?.name ?? track.net}</dd>
        <dt>Length</dt>
        <dd>{mm(length)} mm</dd>
      </dl>
      <Choice
        label="Layer"
        value={track.layer}
        options={pcbCopperLayerNames(state.content.board.copperLayers)}
        disabled={readOnly}
        onChange={(v) => edit({ layer: v })}
      />
      <CommitInput
        label="Width (mm)"
        type="number"
        min={0.05}
        max={10}
        step={0.05}
        value={track.widthMm}
        onCommit={(v) => edit({ widthMm: num(v) })}
      />
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!readOnly && (
          <button type="button" onClick={() => controller.deleteSelection()}>
            <Trash2 size={14} aria-hidden="true" /> Delete track
          </button>
        )}
      </div>
    </Section>
  );
}

function ViaInspector({
  controller,
  state,
  via,
  readOnly,
}: {
  controller: PcbController;
  state: PcbState;
  via: PcbVia;
  readOnly: boolean;
}) {
  const settle = useSettle();
  const net = state.content.nets.find((n) => n.id === via.net);
  const edit = (patch: Partial<PcbVia>) => !controller.updateVia({ ...via, ...patch });
  return (
    <Section title="Via">
      <dl className="pcb-facts">
        <dt>Net</dt>
        <dd>{net?.name ?? via.net}</dd>
      </dl>
      <CommitInput
        label="Diameter (mm)"
        type="number"
        min={0.05}
        max={10}
        step={0.05}
        value={via.diameterMm}
        onCommit={(v) => edit({ diameterMm: num(v) })}
      />
      <CommitInput
        label="Hole (mm)"
        type="number"
        min={0.1}
        max={10}
        step={0.05}
        value={via.drillMm}
        onCommit={(v) => edit({ drillMm: num(v) })}
      />
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!readOnly && (
          <button type="button" onClick={() => controller.deleteSelection()}>
            <Trash2 size={14} aria-hidden="true" /> Delete via
          </button>
        )}
      </div>
    </Section>
  );
}

function NetInspector({
  controller,
  state,
  net,
  fills,
  readOnly,
}: {
  controller: PcbController;
  state: PcbState;
  net: PcbNet;
  fills: PcbZoneFill[];
  readOnly: boolean;
}) {
  const settle = useSettle();
  const doc = state.content;
  const edit = (patch: Partial<PcbNet>) => !controller.updateNet({ ...net, ...patch });
  const lines = pcbRatsnest({ ...doc, nets: [net] }, fills).length;
  const pins = net.pins.map((p) => pcbPinText(doc, p)).join(', ');
  return (
    <Section title={`Net ${net.name}`}>
      <CommitInput label="Name" value={net.name} onCommit={(v) => edit({ name: v })} />
      <Choice
        label="Class"
        value={net.class}
        options={doc.netClasses.map((k) => k.id)}
        names={Object.fromEntries(doc.netClasses.map((k) => [k.id, k.name]))}
        disabled={readOnly}
        onChange={(v) => edit({ class: v })}
      />
      <CommitInput
        label="Pins (REF.PAD, comma separated)"
        value={pins}
        onCommit={(v) => {
          const words = v
            .split(/[\s,]+/)
            .map((w) => w.trim())
            .filter(Boolean);
          const parsed = words.map((w) => pcbParsePin(doc, w));
          const bad = parsed.findIndex((p) => !p);
          if (bad >= 0) {
            controller.report({ code: 'net-pin-missing', path: words[bad], ids: [net.id] });
            return false;
          }
          return edit({ pins: parsed as [string, string][] });
        }}
      />
      <dl className="pcb-facts">
        <dt>Pins</dt>
        <dd data-testid="pcb-net-pins">{net.pins.length}</dd>
        <dt>Unrouted</dt>
        <dd>{lines} connections</dd>
      </dl>
      <div className="pcb-actions">
        <button type="button" onClick={() => settle(() => controller.select([]))}>
          Board
        </button>
        {!readOnly && (
          <button type="button" onClick={() => controller.deleteSelection()}>
            <Trash2 size={14} aria-hidden="true" /> Delete net
          </button>
        )}
      </div>
    </Section>
  );
}

function NetClasses({ controller, state }: { controller: PcbController; state: PcbState }) {
  const readOnly = state.readOnly;
  const used = new Set(state.content.nets.map((n) => n.class));
  const field = (k: PcbNetClass, key: keyof PcbNetClass, label: string) => (
    <CommitInput
      label={`${label} (mm)`}
      type="number"
      min={key === 'viaDrillMm' ? 0.1 : 0.05}
      max={10}
      step={0.01}
      value={k[key]}
      onCommit={(v) => !controller.updateNetClass({ ...k, [key]: num(v) })}
    />
  );
  return (
    <Section title="Net classes">
      {state.content.netClasses.map((k) => (
        <fieldset key={k.id} className="pcb-class" aria-label={`Net class ${k.name}`}>
          <legend>{k.name}</legend>
          <CommitInput
            label="Class name"
            value={k.name}
            onCommit={(v) => !controller.updateNetClass({ ...k, name: v })}
          />
          {field(k, 'trackWidthMm', 'Track width')}
          {field(k, 'clearanceMm', 'Clearance')}
          {field(k, 'viaDiameterMm', 'Via diameter')}
          {field(k, 'viaDrillMm', 'Via drill')}
          {!readOnly && state.content.netClasses.length > 1 && !used.has(k.id) && (
            <button type="button" onClick={() => controller.deleteNetClass(k.id)}>
              <Trash2 size={14} aria-hidden="true" /> Delete class
            </button>
          )}
        </fieldset>
      ))}
      {!readOnly && (
        <button type="button" className="pcb-add" onClick={() => controller.addNetClass()}>
          Add net class
        </button>
      )}
    </Section>
  );
}

function NetListImport({ controller }: { controller: PcbController }) {
  const [text, setText] = useState('');
  return (
    <Section title="Import net list">
      <label className="ep-field">
        Net list (JSON)
        <textarea
          aria-label="Net list (JSON)"
          rows={5}
          spellCheck={false}
          placeholder={'{"nets":[{"name":"GND","pins":["J1.6","R1.2"]}]}'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!text.trim()}
        onClick={() => {
          if (!controller.importNets(text)) setText('');
        }}
      >
        Import nets
      </button>
    </Section>
  );
}

/** One part drawn on the board: courtyard, pads, silkscreen and its reference. */
function PartShape({
  doc,
  part,
  fp,
  selected,
  problem,
  px1,
  ghost,
}: {
  doc: PcbState['content'];
  part: PcbComponent;
  fp: PcbFootprint;
  selected: boolean;
  problem: boolean;
  px1: number;
  ghost?: boolean;
}) {
  const f = componentTransform(part);
  const pads = componentPads(doc, part, fp);
  const silkColor = doc.board.silkColor === 'white' ? '#f0f0ea' : '#202020';
  const bottom = part.side === 'bottom';
  const centre = f([0, 0]);
  return (
    <g
      className="pcb-part"
      data-testid={ghost ? 'pcb-part-ghost' : `pcb-part-${part.id}`}
      data-side={part.side}
      opacity={ghost ? 0.55 : bottom ? 0.6 : 1}
      pointerEvents="none"
    >
      <path
        d={loopsPath([transformLoop(fp.courtyard, part)])}
        fill={selected ? 'rgb(47 129 247 / 12%)' : 'none'}
        stroke={problem ? '#e5534b' : selected ? '#2f81f7' : 'rgb(255 255 255 / 35%)'}
        strokeWidth={(selected || problem ? 2 : 1) * px1}
        strokeDasharray={selected || problem ? undefined : `${3 * px1} ${2 * px1}`}
      />
      {pads
        .filter((p) => p.layers.length > 0)
        .map((p) => (
          <path key={p.pad.number} d={loopsPath([p.loop])} fill={copper[part.side]} stroke="none" />
        ))}
      {pads
        .filter((p) => p.pad.drillMm)
        .map((p) => (
          <circle
            key={`d${p.pad.number}`}
            cx={p.at[0]}
            cy={-p.at[1]}
            r={p.pad.drillMm! / 2}
            fill="#f4f6f8"
          />
        ))}
      {!bottom &&
        fp.silk.map((g, i) => {
          if (g.kind === 'line') {
            const a = f(g.from);
            const b = f(g.to);
            return (
              <line
                key={i}
                x1={a[0]}
                y1={-a[1]}
                x2={b[0]}
                y2={-b[1]}
                stroke={silkColor}
                strokeWidth={g.widthMm}
                strokeLinecap="round"
              />
            );
          }
          const c = f(g.center);
          return (
            <circle
              key={i}
              cx={c[0]}
              cy={-c[1]}
              r={g.radiusMm}
              fill={g.filled ? silkColor : 'none'}
              stroke={silkColor}
              strokeWidth={g.widthMm}
            />
          );
        })}
      {!ghost && (
        <text
          x={centre[0]}
          y={-centre[1]}
          fontSize={Math.max(0.8, Math.min(2, 12 * px1))}
          textAnchor="middle"
          dominantBaseline="central"
          fill={bottom ? '#bcd3f5' : silkColor}
          className="pcb-ref"
        >
          {part.ref}
        </text>
      )}
    </g>
  );
}

/** Pixels within which a click picks a hole or closes an outline. */
const pickPx = 8;

function BoardCanvas({
  controller,
  state,
  tool,
  grid,
  snap,
  fitKey,
  placing,
  latestPlacing,
  layer,
  angle45,
  onLayer,
  fills,
  zoneNet,
  drc,
  focus,
  problems,
  onCursor,
  onToolDone,
}: {
  controller: PcbController;
  state: PcbState;
  tool: PcbTool;
  grid: number;
  snap: boolean;
  fitKey: number;
  placing: PcbPlacing;
  /** The settings after any pending inputs are committed. */
  latestPlacing(): PcbPlacing;
  /** The copper layer new tracks go on. */
  layer: string;
  angle45: boolean;
  onLayer(layer: string): void;
  fills: PcbZoneFill[];
  /** The net a new zone pours. */
  zoneNet: string | undefined;
  drc: PcbDrcViolation[];
  focus: { at: Vec2; n: number } | undefined;
  problems: PcbPlacementProblem[];
  onCursor(p: Vec2 | undefined): void;
  onToolDone(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<PcbView>();
  /** Whether the viewport has been measured once: the first fit waits for it. */
  const [measured, setMeasured] = useState(false);
  const settle = useSettle();
  const [points, setPoints] = useState<Vec2[]>([]);
  /** A track run being routed: its net, the corners so far and the layer of each segment. */
  const [route, setRoute] = useState<PcbRouteRun>();
  const [hover, setHover] = useState<Vec2>();
  const drag = useRef<
    | { kind: 'pan'; start: Vec2; center: Vec2 }
    | { kind: 'move'; ids: string[]; start: Vec2; anchor: Vec2; moved: boolean }
    | undefined
  >(undefined);
  /** The offset of the selection being dragged, before it is applied. */
  const [moving, setMoving] = useState<{ ids: Set<string>; delta: Vec2 }>();
  const footprints = useMemo(
    () => new Map(state.content.footprints.map((f) => [f.id, f])),
    [state.content.footprints],
  );
  const courtyards = useMemo(
    () =>
      state.content.components.flatMap((c) => {
        const loop = componentCourtyard(state.content, c);
        return loop ? [{ c, edges: loopEdges(loop) }] : [];
      }),
    [state.content],
  );
  const ghostFp = useMemo(() => {
    const fp = placingFootprint(placing);
    return 'error' in fp ? undefined : fp;
  }, [placing]);
  const board = state.content.board;
  const bounds = useMemo(() => loopBounds(board.outline), [board.outline]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.max(r.width, 1), height: Math.max(r.height, 1) });
      setMeasured(true);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Fit on open and on request.
  useEffect(() => {
    setView(fitPcbView(bounds, size));
  }, [fitKey, measured]);
  // A DRC finding picked in the list: centre on it, zoomed in enough to see it.
  useEffect(() => {
    if (!focus) return;
    setView((cur) => {
      const base = cur ?? fitPcbView(bounds, size);
      return { pxPerMm: Math.max(base.pxPerMm, 40), center: focus.at };
    });
  }, [focus]);
  // A new tool starts from nothing.
  useEffect(() => {
    setPoints([]);
    setRoute(undefined);
  }, [tool]);
  const v = view ?? fitPcbView(bounds, size);

  const local = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toBoard = (px: Vec2, snapped = snap): Vec2 => {
    const p = screenToBoard(v, size, px);
    return snapped
      ? snapToGrid(p, grid)
      : [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4];
  };
  const holeAt = (px: Vec2) =>
    [...state.content.holes].reverse().find((h) => {
      const s = boardToScreen(v, size, h.at);
      const r = Math.max(h.drillMm / 2, h.keepoutMm / 2) * v.pxPerMm;
      return Math.hypot(s[0] - px[0], s[1] - px[1]) <= Math.max(r, pickPx);
    });
  /** The via or track under a point (vias first; tracks on the active layer first). */
  const copperAt = (px: Vec2): { id: string; at: Vec2 } | undefined => {
    const p = screenToBoard(v, size, px);
    const slack = pickPx / v.pxPerMm / 2;
    const via = [...doc.vias]
      .reverse()
      .find((x) => Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) <= x.diameterMm / 2 + slack);
    if (via) return via;
    const near = (t: PcbTrack) => segmentDistance(p, p, t.from, t.to) <= t.widthMm / 2 + slack;
    const t =
      [...doc.tracks].reverse().find((x) => x.layer === layer && near(x)) ??
      [...doc.tracks].reverse().find(near);
    return t && { id: t.id, at: t.from };
  };
  /** The topmost part under a point: top-side parts first, then the latest placed. */
  const partAt = (px: Vec2) => {
    const p = screenToBoard(v, size, px);
    const hits = courtyards.filter((k) => pointInLoop(p, k.edges)).reverse();
    return (hits.find((k) => k.c.side === 'top') ?? hits[0])?.c;
  };

  const finishOutline = (pts: Vec2[]) => {
    if (pts.length < 3) {
      controller.report({ code: 'loop-vertices', ids: [] });
      return;
    }
    const loop = pts.map((p): Vec2 => [p[0], p[1]]);
    if (tool === 'zone') {
      if (!zoneNet) controller.report({ code: 'zone-no-net', ids: [] });
      else if (!controller.addZone(zoneNet, layer, loop)) onToolDone();
    } else if (!controller.setOutline(loop)) onToolDone();
    setPoints([]);
  };
  /** The zone under a point: the active layer's first, then the latest. */
  const zoneAt = (px: Vec2) => {
    const p = screenToBoard(v, size, px);
    const hits = doc.zones.filter((z) => pointInLoop(p, loopEdges(z.outline))).reverse();
    return hits.find((z) => z.layer === layer) ?? hits[0];
  };

  const doc = state.content;
  const netClass = (net: string) =>
    doc.netClasses.find((k) => k.id === doc.nets.find((n) => n.id === net)?.class) ??
    doc.netClasses[0];
  /** The next corner: the cursor on the grid, turned to 45° steps when asked. */
  const nextCorner = (r: PcbRouteRun, px: Vec2): Vec2 => {
    const p = toBoard(px);
    const last = r.points[r.points.length - 1];
    return angle45 ? constrain45(last, p) : p;
  };
  const routeClick = (px: Vec2) => {
    const raw = screenToBoard(v, size, px);
    const slack = pickPx / v.pxPerMm / 2;
    const target = pcbRouteTarget(doc, raw, route ? route.layer : layer, slack);
    if (!route) {
      if (!target?.net) {
        controller.report({ code: 'route-no-net', ids: [] });
        return;
      }
      controller.dismissNotice();
      setRoute({ net: target.net, points: [target.at], segLayers: [], layer, vias: [] });
      return;
    }
    if (target?.net && target.net !== route.net) {
      controller.report({ code: 'route-other-net', ids: [] });
      return;
    }
    const last = route.points[route.points.length - 1];
    const end = target ? target.at : nextCorner(route, px);
    if (end[0] === last[0] && end[1] === last[1]) {
      if (target) finishRoute(route);
      return;
    }
    const next: PcbRouteRun = {
      ...route,
      points: [...route.points, end],
      segLayers: [...route.segLayers, route.layer],
    };
    if (target) finishRoute(next);
    else setRoute(next);
  };
  /** A via at the last corner; the run goes on on `to` (by default the other outer layer). */
  const addVia = (r: PcbRouteRun, to = r.layer === 'F.Cu' ? 'B.Cu' : 'F.Cu') => {
    const at = r.points[r.points.length - 1];
    const vias = r.vias.some((p) => p[0] === at[0] && p[1] === at[1]) ? r.vias : [...r.vias, at];
    if (to !== layer) onLayer(to);
    setRoute({ ...r, vias, layer: to });
  };
  // Picking another layer in the toolbar during a run drops a via there too, so the layer shown
  // is always the layer being routed.
  useEffect(() => {
    if (route && route.layer !== layer) addVia(route, layer);
  }, [layer]);
  const finishRoute = (r: PcbRouteRun) => {
    const k = netClass(r.net);
    const tracks = r.points.slice(1).map((to, i) => ({
      net: r.net,
      layer: r.segLayers[i],
      widthMm: k.trackWidthMm,
      from: r.points[i],
      to,
    }));
    const vias = r.vias.map((at) => ({
      net: r.net,
      at,
      diameterMm: k.viaDiameterMm,
      drillMm: k.viaDrillMm,
    }));
    if (!controller.addCopper(tracks, vias)) setRoute(undefined);
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTextInput(e.target)) return;
      if (e.key === 'Escape') {
        if (route) setRoute(undefined);
        else if (points.length) setPoints([]);
        else onToolDone();
      } else if (e.key === 'Enter' && tool === 'route') {
        e.preventDefault();
        if (route) finishRoute(route);
      } else if ((e.key === 'v' || e.key === 'V') && tool === 'route' && route) {
        e.preventDefault();
        addVia(route);
      } else if (e.key === 'Enter' && (tool === 'outline' || tool === 'zone')) {
        e.preventDefault();
        finishOutline(points);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && tool === 'select') {
        if (state.selection.length && !state.readOnly) {
          e.preventDefault();
          controller.deleteSelection();
        }
      } else if (
        (e.key === 'r' || e.key === 'R' || e.key === 'f' || e.key === 'F') &&
        tool === 'select' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !state.readOnly
      ) {
        if (!state.content.components.some((c) => state.selection.includes(c.id))) return;
        e.preventDefault();
        if (e.key.toLowerCase() === 'r') controller.rotateSelection(e.shiftKey ? -90 : 90);
        else controller.flipSelection();
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
    if (tool === 'hole') {
      controller.addHole(toBoard(px));
      return;
    }
    if (tool === 'route') {
      routeClick(px);
      return;
    }
    if (tool === 'part') {
      const at = toBoard(px);
      // Commit the part's settings first; a refused setting blocks the placement.
      settle(() => {
        const p = latestPlacing();
        controller.placeGenerated(p.kind, p.params, at, p.side);
      });
      return;
    }
    if (tool === 'outline' || tool === 'zone') {
      const p = toBoard(px);
      if (points.length >= 3) {
        const first = boardToScreen(v, size, points[0]);
        if (Math.hypot(first[0] - px[0], first[1] - px[1]) <= pickPx) {
          finishOutline(points);
          return;
        }
      }
      const last = points[points.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) setPoints([...points, p]);
      return;
    }
    const wire = copperAt(px);
    const hole = wire ? undefined : holeAt(px);
    const part = wire || hole ? undefined : partAt(px);
    const zone = wire || hole || part ? undefined : zoneAt(px);
    const hit = wire ?? hole ?? part ?? (zone && { id: zone.id, at: zone.outline[0] as Vec2 });
    const toggle = e.ctrlKey || e.metaKey;
    let ids: string[] = [];
    if (hit) {
      // Holes and parts are selected apart: a drag moves one kind at a time.
      const sameKind = (id: string) =>
        zone
          ? doc.zones.some((z) => z.id === id)
          : wire
            ? doc.tracks.some((t) => t.id === id) || doc.vias.some((t) => t.id === id)
            : hole
              ? state.content.holes.some((h) => h.id === id)
              : state.content.components.some((c) => c.id === id);
      const kept = state.selection.filter(sameKind);
      ids = toggle
        ? kept.includes(hit.id)
          ? kept.filter((id) => id !== hit.id)
          : [...kept, hit.id]
        : kept.includes(hit.id)
          ? kept
          : [hit.id];
    }
    // A refused inspector value stays with its item: the selection does not change under it.
    const same =
      ids.length === state.selection.length && ids.every((id, i) => state.selection[i] === id);
    if (!same && !settle(() => controller.select(ids))) return;
    if (hit) {
      // Copper is moved by routing again (PB4); holes and unlocked parts drag.
      const movable = wire || zone ? false : part ? !part.locked : true;
      if (!state.readOnly && !toggle && movable && ids.includes(hit.id)) {
        drag.current = { kind: 'move', ids, start: px, anchor: hit.at, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    drag.current = { kind: 'pan', start: px, center: v.center };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const px = local(e);
    const p = toBoard(px);
    onCursor(p);
    setHover(p);
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      setView({
        pxPerMm: v.pxPerMm,
        center: [
          d.center[0] - (px[0] - d.start[0]) / v.pxPerMm,
          d.center[1] + (px[1] - d.start[1]) / v.pxPerMm,
        ],
      });
      return;
    }
    if (!d.moved && Math.hypot(px[0] - d.start[0], px[1] - d.start[1]) < 3) return;
    d.moved = true;
    const delta = [(px[0] - d.start[0]) / v.pxPerMm, -(px[1] - d.start[1]) / v.pxPerMm];
    // The grabbed item lands on the grid; the rest of the selection keeps its offsets.
    const raw: Vec2 = [d.anchor[0] + delta[0], d.anchor[1] + delta[1]];
    const to = snap ? snapToGrid(raw, grid) : raw;
    setMoving({ ids: new Set(d.ids), delta: [to[0] - d.anchor[0], to[1] - d.anchor[1]] });
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = undefined;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.kind === 'move' && d.moved && moving) controller.moveSelection(moving.delta);
    setMoving(undefined);
  };
  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    setView(zoomPcbView(v, size, local(e), Math.exp(-e.deltaY * 0.0015)));
  };

  const [vx, vy, vw, vh] = pcbViewBox(v, size);
  const step = drawnGridStep(grid, v.pxPerMm);
  const px1 = 1 / v.pxPerMm;
  const shift = <T extends { id: string; at: Vec2 }>(e: T): T =>
    moving && moving.ids.has(e.id)
      ? { ...e, at: [e.at[0] + moving.delta[0], e.at[1] + moving.delta[1]] }
      : e;
  const holes = state.content.holes.map(shift);
  const parts = state.content.components.map((c) => (c.locked ? c : shift(c)));
  const troubled = new Set(
    problems.flatMap((p) =>
      p.ids.filter((id) => state.content.components.some((c) => c.id === id)),
    ),
  );
  // Bottom-side parts first, so the top side is drawn over them.
  const drawOrder = [
    ...parts.filter((c) => c.side === 'bottom'),
    ...parts.filter((c) => c.side === 'top'),
  ];
  const preview =
    (tool === 'outline' || tool === 'zone') && points.length
      ? [...points, ...(hover ? [hover] : [])]
      : [];
  // Lines follow parts while they are dragged.
  const shown = moving ? { ...state.content, components: parts } : state.content;
  const rats = useMemo(() => pcbRatsnest(shown, fills), [shown, fills]);
  const litNet = state.content.nets.find((n) => state.selection.includes(n.id));
  const litPads = litNet ? new Set(litNet.pins.map(([c, p]) => `${c}\u0000${p}`)) : undefined;
  return (
    <div className="pcb-viewport" ref={host}>
      <svg
        className="pcb-canvas"
        data-testid="pcb-canvas"
        data-tool={tool}
        data-px-per-mm={v.pxPerMm}
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        onPointerDown={onPointerDown}
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
          <pattern
            id="pcb-grid"
            width={step}
            height={step}
            x={0}
            y={0}
            patternUnits="userSpaceOnUse"
          >
            <path d={`M${step} 0L0 0 0 ${step}`} fill="none" stroke="#c9d1d9" strokeWidth={px1} />
          </pattern>
        </defs>
        <rect x={vx} y={vy} width={vw} height={vh} fill="url(#pcb-grid)" />
        <path
          d={`M${-10 * px1} 0H${10 * px1}M0 ${-10 * px1}V${10 * px1}`}
          stroke="#8b949e"
          strokeWidth={px1}
        />
        <path
          className="pcb-board"
          data-testid="pcb-board"
          d={loopsPath([board.outline, ...board.cutouts])}
          fill={maskFill[board.maskColor]}
          fillRule="evenodd"
          stroke="#d4a72c"
          strokeWidth={2 * px1}
        />
        <g className="pcb-zones" pointerEvents="none">
          {[...fills]
            .sort((a, b) => Number(a.layer === layer) - Number(b.layer === layer))
            .map((f) => {
              const z = doc.zones.find((x) => x.id === f.zone)!;
              const sel = state.selection.includes(z.id) || litNet?.id === z.net;
              return (
                <g key={f.zone}>
                  <path
                    data-testid={`pcb-zone-fill-${f.zone}`}
                    data-area={f.areaMm2.toFixed(3)}
                    d={pcbTrapezoidPath(f.trapezoids)}
                    fill={pcbLayerColor(f.layer)}
                    fillOpacity={f.layer === layer ? 0.55 : 0.25}
                    stroke="none"
                  />
                  <path
                    d={loopsPath([z.outline])}
                    fill="none"
                    stroke={sel ? '#ffffff' : pcbLayerColor(f.layer)}
                    strokeWidth={(sel ? 2 : 1) * px1}
                    strokeDasharray={`${4 * px1} ${3 * px1}`}
                  />
                </g>
              );
            })}
        </g>
        {drawOrder.map((c) => {
          const fp = footprints.get(c.footprint);
          return fp ? (
            <PartShape
              key={c.id}
              doc={state.content}
              part={c}
              fp={fp}
              selected={state.selection.includes(c.id)}
              problem={troubled.has(c.id)}
              px1={px1}
            />
          ) : null;
        })}
        {tool === 'part' && hover && ghostFp && (
          <PartShape
            doc={state.content}
            part={{
              id: 'ghost',
              ref: '',
              value: '',
              footprint: ghostFp.id,
              at: hover,
              rotationDeg: 0,
              side: placing.side,
              locked: false,
            }}
            fp={ghostFp}
            selected={false}
            problem={false}
            px1={px1}
            ghost
          />
        )}
        <g className="pcb-copper" pointerEvents="none">
          {[...doc.tracks]
            .sort((a, b) => Number(a.layer === layer) - Number(b.layer === layer))
            .map((t) => {
              const sel = state.selection.includes(t.id) || litNet?.id === t.net;
              return (
                <line
                  key={t.id}
                  data-testid={`pcb-track-${t.id}`}
                  data-layer={t.layer}
                  x1={t.from[0]}
                  y1={-t.from[1]}
                  x2={t.to[0]}
                  y2={-t.to[1]}
                  stroke={sel ? '#ffffff' : pcbLayerColor(t.layer)}
                  strokeOpacity={t.layer === layer || sel ? 0.95 : 0.45}
                  strokeWidth={t.widthMm}
                  strokeLinecap="round"
                />
              );
            })}
          {doc.vias.map((via) => {
            const sel = state.selection.includes(via.id) || litNet?.id === via.net;
            return (
              <g key={via.id} data-testid={`pcb-via-${via.id}`}>
                <circle
                  cx={via.at[0]}
                  cy={-via.at[1]}
                  r={via.diameterMm / 2}
                  fill={sel ? '#ffffff' : '#c8b25a'}
                />
                <circle cx={via.at[0]} cy={-via.at[1]} r={via.drillMm / 2} fill="#1d1f22" />
              </g>
            );
          })}
          {route && (
            <g data-testid="pcb-route-preview">
              {route.points.slice(1).map((to, i) => (
                <line
                  key={i}
                  x1={route.points[i][0]}
                  y1={-route.points[i][1]}
                  x2={to[0]}
                  y2={-to[1]}
                  stroke={pcbLayerColor(route.segLayers[i])}
                  strokeWidth={netClass(route.net).trackWidthMm}
                  strokeLinecap="round"
                />
              ))}
              {hover &&
                (() => {
                  const last = route.points[route.points.length - 1];
                  const to = angle45 ? constrain45(last, hover) : hover;
                  return (
                    <line
                      x1={last[0]}
                      y1={-last[1]}
                      x2={to[0]}
                      y2={-to[1]}
                      stroke={pcbLayerColor(route.layer)}
                      strokeOpacity={0.6}
                      strokeWidth={netClass(route.net).trackWidthMm}
                      strokeLinecap="round"
                    />
                  );
                })()}
              {route.vias.map((at, i) => (
                <circle
                  key={`v${i}`}
                  cx={at[0]}
                  cy={-at[1]}
                  r={netClass(route.net).viaDiameterMm / 2}
                  fill="#c8b25a"
                />
              ))}
            </g>
          )}
        </g>
        <g className="pcb-drc" pointerEvents="none">
          {drc.map((d, i) => (
            <g
              key={i}
              data-testid="pcb-drc-marker"
              data-rule={d.rule}
              transform={`translate(${d.at[0]} ${-d.at[1]})`}
            >
              <circle
                r={7 * px1}
                fill="none"
                stroke={d.severity === 'error' ? '#ff4d4f' : '#f0b429'}
                strokeWidth={2 * px1}
              />
              <path
                d={`M${-4 * px1} ${-4 * px1}L${4 * px1} ${4 * px1}M${4 * px1} ${-4 * px1}L${-4 * px1} ${4 * px1}`}
                stroke={d.severity === 'error' ? '#ff4d4f' : '#f0b429'}
                strokeWidth={2 * px1}
              />
            </g>
          ))}
        </g>
        {litNet &&
          parts.flatMap((c) => {
            const fp = footprints.get(c.footprint);
            if (!fp) return [];
            return componentPads(shown, c, fp)
              .filter((p) => litPads!.has(`${c.id}\u0000${p.pad.number}`))
              .map((p) => (
                <path
                  key={`lit-${c.id}-${p.pad.number}`}
                  className="pcb-net-pad"
                  d={loopsPath([p.loop])}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={2 * px1}
                  pointerEvents="none"
                />
              ));
          })}
        <g className="pcb-ratsnest" data-testid="pcb-ratsnest" pointerEvents="none">
          {rats.map((l, i) => {
            const lit = litNet?.id === l.net;
            return (
              <line
                key={i}
                data-net={l.net}
                x1={l.a.at[0]}
                y1={-l.a.at[1]}
                x2={l.b.at[0]}
                y2={-l.b.at[1]}
                stroke={lit ? '#ffffff' : 'rgb(230 237 243 / 70%)'}
                strokeWidth={(lit ? 2 : 1) * px1}
              />
            );
          })}
        </g>
        {holes.map((h) => {
          const sel = state.selection.includes(h.id);
          return (
            <g key={h.id} data-testid={`pcb-hole-${h.id}`} className="pcb-hole">
              {h.keepoutMm > 0 && (
                <circle
                  cx={h.at[0]}
                  cy={-h.at[1]}
                  r={h.keepoutMm / 2}
                  fill={h.plated ? '#d4a72c' : '#c8ccd0'}
                  stroke={sel ? '#2f81f7' : 'none'}
                  strokeWidth={2 * px1}
                />
              )}
              <circle
                cx={h.at[0]}
                cy={-h.at[1]}
                r={h.drillMm / 2}
                fill="#f4f6f8"
                stroke={sel ? '#2f81f7' : '#444c56'}
                strokeWidth={(sel ? 2 : 1) * px1}
              />
            </g>
          );
        })}
        {preview.length > 0 && (
          <polyline
            data-testid="pcb-outline-preview"
            points={preview.map((p) => `${p[0]},${-p[1]}`).join(' ')}
            fill="none"
            stroke="#2f81f7"
            strokeWidth={2 * px1}
            strokeDasharray={`${4 * px1} ${3 * px1}`}
          />
        )}
        {tool !== 'select' && hover && (
          <circle cx={hover[0]} cy={-hover[1]} r={3 * px1} fill="#2f81f7" />
        )}
      </svg>
      {(tool !== 'select' || state.notice) && (
        <p className="pcb-viewport-note" role="status">
          {state.notice ? pcbNoticeText(state.notice) : toolInfo[tool].hint}
        </p>
      )}
    </div>
  );
}
