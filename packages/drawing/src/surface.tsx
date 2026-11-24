import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Box,
  Building2,
  CircleDot,
  ListOrdered,
  Download,
  Files,
  FileInput,
  FilePlus2,
  FileText,
  FileCode2,
  Maximize,
  MessageSquareShare,
  Redo2,
  RefreshCw,
  Ruler,
  Scissors,
  Search,
  Shapes,
  StickyNote,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  EditorHistoryContext,
  EditorLayout,
  IconButton,
  isTextInput,
  useEditorInput,
  Section,
  Toolbar,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  drawingDimensionTypes,
  drawingIsAssembly,
  drawingDimensionValue,
  drawingRefOn,
  drawingPmiText,
  drawingPmiChanges,
  type DrawingPmiNote,
  type DrawingAnchorIssue,
  drawingDirections,
  drawingFitPattern,
  drawingGdtCharacteristics,
  drawingGdtNeedsDatum,
  drawingWeldTypes,
  drawingOrientations,
  drawingPlaceholderSize,
  drawingBimScales,
  drawingElevationSides,
  drawingIsBuildingView,
  drawingScales,
  drawingSheetSizeNames,
  drawingTextHeights,
  drawingTitleFields,
  type DrawingAnnotation,
  type DrawingDimension,
  type DrawingDimensionType,
  type DrawingDirection,
  type DrawingLeader,
  type DrawingSnap,
  type DrawingSymbol,
  type DrawingSymbolSpec,
  type DrawingSymbolType,
  type DrawingNote,
  type DrawingOrientation,
  type DrawingBimScale,
  type DrawingElevationSide,
  type DrawingScale,
  type DrawingSheetSize,
  type DrawingTextHeight,
  type DrawingTitleBlock,
  type DrawingView,
  type DrawingViewState,
  type Vec2,
} from '@editor-platform/drawing-core';
import type {
  DrawingController,
  DrawingNotice,
  DrawingSectionLook,
  DrawingSurfaceState,
  DrawingBuildingViewWhat,
  DrawingViewSet,
} from './controller';
import { Choice, Field, useSettle } from './fields';

const messages: Record<string, string> = {
  'permission-denied': 'You can only view this drawing.',
  'pdf-font-unavailable': 'The fixed PDF font (Noto Sans CJK JP) is not available here.',
  'issue-unavailable': 'Issuing is not offered here.',
  'issue-none': 'Choose the sheets to issue.',
  'issue-pmi-expired':
    'An imported PMI item is out of date (失効・要確認); confirm or detach it first:',
  'issue-pmi-updated': 'An imported PMI item changed; confirm it first:',
  'issue-refs': 'A dimension or symbol no longer finds its edge or datum; fix it first:',
  'issue-view-failed': 'A view on the sheet is not drawn:',
  'issue-pending': 'An annotation on the sheet is not resolved yet:',
  'issue-unprintable': 'An angle dimension measures edges that are parallel now; fix it first:',
  'issue-busy': 'A version is being saved; issue again when it is done.',
  'issue-not-saved': 'The issued version could not be saved.',
  'issue-too-large': 'The issued PDF is larger than a drawing keeps.',
  'issue-limit': 'This drawing has as many issues as it keeps.',
  'pdf-font-missing': 'The PDF font has no letter for:',
  'selection-empty': 'Select a view or a note first.',
  'sheet-last': 'A drawing keeps at least one sheet.',
  'drawing-base-mismatch': 'The drawing changed; try again.',
  'revision-duplicate': 'That revision mark is already on the sheet.',
  date: 'Dates are YYYY-MM-DD.',
  point: 'That is too far off the sheet.',
  shape: 'That value is not allowed here.',
  'source-missing': 'A part this version places is not saved here.',
  'source-assets': 'The imported geometry (STEP) of that version is not saved here.',
  'source-unavailable': 'No saved CAD versions are offered here.',
  'kernel-build-unavailable': 'The CAD kernel is not part of this build.',
  'limit-triangles': 'The shape is too large to project.',
  'limit-samples': 'The shape is too large to project.',
  'limit-lines': 'The view has more than 200,000 lines; use a detail view or a smaller scale.',
  'limit-time': 'The view took longer than 5 minutes to project.',
  'limit-marks': 'Every section and detail mark is used.',
  'view-pending': 'Wait until the view is drawn.',
  'view-parent': 'The view it belongs to is gone.',
  'view-parent-kind': 'Sections are made from square projections; details from those or sections.',
  'mark-duplicate': 'That mark is already used by another section or detail.',
  'source-same': 'The view already shows that version.',
  'source-other': 'That version is of another Artifact.',
  'section-line': 'The cutting line needs two different points.',
  'view-missing': 'The view it measures is gone.',
  'view-sheet': 'A dimension stays on the sheet of its view.',
  'dimension-refs': 'That dimension needs other picks.',
  'ref-point': 'That dimension needs other picks.',
  'pick-none': 'Nothing to snap to there; click on a drawn edge.',
  'pick-view': 'Pick the points in one view.',
  'gdt-datum-needed': 'This tolerance needs a datum (parallelism, run-out and the like).',
  'gdt-datum-form':
    'A form tolerance (straightness, flatness, roundness, cylindricity) takes no datum.',
  'datum-letter': 'Datum letters are A–Z (no I, O or Q), up to three.',
  'datum-duplicate': 'That datum letter is already used.',
  'ref-missing': 'That dimension has no such reference.',
  'pick-kind': 'Pick the same kind of point or edge as before.',
  'pmi-none': 'This view has no PMI left to import.',
  'pmi-not-updated': 'That PMI item has no change to confirm.',
  'annotation-missing': 'That annotation is gone.',
  'part-none': 'No part of the assembly there (or every part already has its balloon).',
  'part-drawn': 'Every part of the assembly already has its part drawing.',
  'part-drawing-none':
    'No part drawing could be made: those parts have no saved version here, or their views could not be drawn',
  'part-drawing-skipped':
    'Part drawings made; these parts have none (no saved version here, or views that could not be drawn)',
};
const dimensionLabels: Record<DrawingDimensionType, string> = {
  horizontal: '水平 Horizontal',
  vertical: '垂直 Vertical',
  aligned: '平行 Aligned',
  diameter: '直径 Diameter',
  radius: '半径 Radius',
  angle: '角度 Angle',
};
/** What a dimension type picks, and how many. */
const pickOf = (t: DrawingDimensionType) =>
  t === 'diameter' || t === 'radius'
    ? { kind: 'circle' as const, count: 1 }
    : t === 'angle'
      ? { kind: 'line' as const, count: 2 }
      : { kind: 'point' as const, count: 2 };
/** `repick`: choosing again the edge under one ref of a dimension, leader or symbol (DW3c). */
type DrawingTool = 'none' | 'note' | 'dimension' | 'leader' | 'symbol' | 'repick' | 'balloon';
const symbolLabels: Record<DrawingSymbolType, string> = {
  gdt: '幾何公差 Geometric tolerance',
  datum: 'データム Datum',
  surface: '表面性状 Surface texture',
  weld: '溶接 Weld',
};
const gdtLabels: Record<(typeof drawingGdtCharacteristics)[number], string> = {
  straightness: '真直度 Straightness',
  flatness: '平面度 Flatness',
  circularity: '真円度 Circularity',
  cylindricity: '円筒度 Cylindricity',
  'profile-line': '線の輪郭度 Line profile',
  'profile-surface': '面の輪郭度 Surface profile',
  parallelism: '平行度 Parallelism',
  perpendicularity: '直角度 Perpendicularity',
  angularity: '傾斜度 Angularity',
  position: '位置度 Position',
  concentricity: '同軸度 Concentricity',
  symmetry: '対称度 Symmetry',
  'circular-runout': '円周振れ Circular run-out',
  'total-runout': '全振れ Total run-out',
};
const weldLabels: Record<(typeof drawingWeldTypes)[number], string> = {
  fillet: 'すみ肉 Fillet',
  square: 'I形 Square',
  v: 'V形 V groove',
  bevel: 'レ形 Bevel',
  spot: 'スポット Spot',
  plug: 'プラグ Plug',
};
/** A new symbol of a type, before it is edited (a datum takes the next free letter). */
const symbolStarter = (t: DrawingSymbolType): DrawingSymbolSpec =>
  t === 'gdt'
    ? {
        type: 'gdt',
        characteristic: 'flatness',
        tolerance: '0.05',
        diameter: false,
        modifier: '',
        datums: [],
      }
    : t === 'datum'
      ? { type: 'datum', letter: '' }
      : t === 'surface'
        ? { type: 'surface', process: 'removal', text: 'Ra 1.6' }
        : {
            type: 'weld',
            weld: 'fillet',
            side: 'arrow',
            size: '6',
            length: '',
            allAround: false,
            field: false,
          };
const symbolName = (sym: DrawingSymbolSpec) =>
  sym.type === 'gdt'
    ? gdtLabels[sym.characteristic].split(' ')[0]!
    : sym.type === 'datum'
      ? sym.letter
      : sym.type === 'surface'
        ? sym.text || '表面性状'
        : weldLabels[sym.weld].split(' ')[0]!;
/** Annotations: notes, dimensions, leaders and symbols (no view state of their own). */
const isAnnotation = (it: DrawingView | DrawingAnnotation): it is DrawingAnnotation =>
  it.kind === 'note' ||
  it.kind === 'leader' ||
  it.kind === 'dimension' ||
  it.kind === 'symbol' ||
  it.kind === 'pmi' ||
  it.kind === 'balloon' ||
  it.kind === 'parts-list';
type DrawingDimensionMode = 'single' | 'chain' | 'baseline';
/** Snap radius on the screen, px. */
const snapPx = 12;
const itemName = (
  it: DrawingView | DrawingAnnotation,
  short = false,
  views: readonly DrawingView[] = [],
) => {
  if (it.kind === 'note')
    return short ? `注記 ${it.text.split('\n')[0]}` : `Note ${it.text.split('\n')[0]}`;
  if (it.kind === 'leader')
    return short ? `引出線 ${it.text.split('\n')[0]}` : `Leader ${it.text.split('\n')[0]}`;
  if (it.kind === 'dimension')
    return short ? `寸法 ${dimensionLabels[it.type].split(' ')[0]}` : `Dimension ${it.type}`;
  if (it.kind === 'symbol')
    return short
      ? `${symbolLabels[it.symbol.type].split(' ')[0]} ${symbolName(it.symbol)}`
      : `Symbol ${it.symbol.type} ${symbolName(it.symbol)}`;
  if (it.kind === 'pmi') return `PMI ${drawingPmiText(it.item)}`;
  if (it.kind === 'balloon') return short ? '風船' : 'Balloon';
  if (it.kind === 'parts-list') {
    // DW5c: a building view's list is its member list.
    const v = views.find((x) => x.id === it.viewId);
    if (v && drawingIsBuildingView(v)) return short ? '部材リスト' : 'Member list';
    return short ? '部品欄' : 'Parts list';
  }
  return short ? it.name : `View ${it.name}`;
};
export const drawingNoticeText = (n: DrawingNotice) =>
  `${messages[n.code] ?? n.code}${n.path ? ` (${n.path})` : ''}`;

export function useDrawingState(controller: DrawingController): DrawingSurfaceState {
  return useSyncExternalStore(
    (l) => controller.subscribe(l),
    () => controller.state,
  );
}

const titleLabels: Record<keyof DrawingTitleBlock, string> = {
  title: '図名 Title',
  drawingNumber: '図番 Drawing number',
  organization: '会社 Organization',
  project: '工事・製品 Project',
  material: '材料 Material',
  quantity: '数量 Quantity',
  drawnBy: '作成 Drawn by',
  checkedBy: '検図 Checked by',
  approvedBy: '承認 Approved by',
  date: '日付 Date',
};
const directionLabels: Record<DrawingDirection, string> = {
  front: '正面 Front',
  top: '平面 Top',
  right: '右側面 Right',
  left: '左側面 Left',
  bottom: '下面 Bottom',
  rear: '背面 Rear',
  iso: '等角 Isometric',
};

/** A box on the paper (mm, y up) a view or a note covers, for picking and dragging. */
function itemBox(
  item: DrawingView | DrawingAnnotation,
  state: DrawingViewState | undefined,
  controller: DrawingController,
): [Vec2, Vec2] {
  if (
    item.kind === 'dimension' ||
    item.kind === 'leader' ||
    item.kind === 'symbol' ||
    item.kind === 'pmi' ||
    item.kind === 'balloon' ||
    item.kind === 'parts-list'
  )
    return (
      controller.annotationGraphics(item).bounds ?? [
        [0, 0],
        [0, 0],
      ]
    );
  if (item.kind === 'note') {
    const lines = item.text.split('\n');
    const width = Math.max(...lines.map((l) => [...l].length)) * item.heightMm * 0.95;
    const top = item.at[1] + item.heightMm;
    const bottom = item.at[1] - (lines.length - 1) * item.heightMm * 1.6 - item.heightMm * 0.3;
    return [
      [item.at[0], bottom],
      [item.at[0] + width, top],
    ];
  }
  if (state?.status === 'ready') return state.graphics.bounds;
  const { width: w, height: h } = drawingPlaceholderSize;
  return [
    [item.at[0] - w / 2, item.at[1] - h / 2],
    [item.at[0] + w / 2, item.at[1] + h / 2],
  ];
}

export function DrawingSurface({
  controller,
  name,
  hostHistory,
  onUndo,
  onRedo,
  layout,
}: {
  controller: DrawingController;
  name: string;
  /** The Host owns Undo/Redo (its toolbar and keys): the Surface shows none. */
  hostHistory?: boolean;
  onUndo?(): void;
  onRedo?(): void;
  layout?: Partial<EditorLayoutProps>;
}) {
  const state = useDrawingState(controller);
  const settle = useSettle();
  const guardExport = useContext(EditorExportGuardContext);
  const [exportError, setExportError] = useState('');
  const permitExport = () => {
    try {
      guardExport?.();
      setExportError('');
      return true;
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const history = useContext(EditorHistoryContext);
  const locked = state.readOnly;
  const why = 'Read only';
  const sheet = state.content.sheets.find((s) => s.id === state.sheetId)!;
  const [tool, setToolState] = useState<DrawingTool>('none');
  const [dimType, setDimType] = useState<DrawingDimensionType>('horizontal');
  const [dimMode, setDimMode] = useState<DrawingDimensionMode>('single');
  /** Snaps picked so far for the dimension or leader being added. */
  const [picks, setPicks] = useState<DrawingSnap[]>([]);
  /** In chain or baseline mode, the last dimension added: the next one continues from it. */
  const [run, setRun] = useState<{
    first: DrawingSnap;
    last: DrawingSnap;
    at: Vec2;
    count: number;
    /** Which way a baseline steps out, fixed by the first dimension (Codex on #1211). */
    sign: number;
  }>();
  const [hover, setHover] = useState<DrawingSnap>();
  const [symType, setSymType] = useState<DrawingSymbolType>('gdt');
  /** The ref being chosen again with the `repick` tool (DW3c). */
  const [repick, setRepick] = useState<{ annotationId: string; index: number }>();
  const [pickNotice, setPickNotice] = useState<string>();
  // Picks belong to the sheet they were made on: another sheet starts over (Codex on #1211).
  const [pickSheet, setPickSheet] = useState(state.sheetId);
  if (pickSheet !== state.sheetId) {
    setPickSheet(state.sheetId);
    setPicks([]);
    setRun(undefined);
    setHover(undefined);
    setPickNotice(undefined);
  }
  const setTool = (t: DrawingTool) => {
    setToolState(t);
    setPicks([]);
    setRun(undefined);
    setHover(undefined);
    setPickNotice(undefined);
  };
  const [zoom, setZoom] = useState<number | undefined>(undefined);
  const [drag, setDrag] = useState<{ start: Vec2; delta: Vec2 } | undefined>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<Vec2>([800, 600]);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setStageSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    setStageSize([el.clientWidth, el.clientHeight]);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => controller.dispose(), [controller]);

  const paper = controller.paper;
  const fit = Math.max(
    0.2,
    Math.min((stageSize[0] - 32) / paper[0], (stageSize[1] - 32) / paper[1]),
  );
  const scale = zoom ?? fit;

  const svg = useMemo(
    () => controller.sheetSvg(),
    // The SVG depends on the content, the sheet and the views' states only.
    [controller, state.content, state.sheetId, state.views],
  );
  const url = useMemo(() => {
    if (typeof URL === 'undefined' || !URL.createObjectURL) return '';
    return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  }, [svg]);
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTextInput(e.target)) return;
      if (e.key === 'Escape' && tool !== 'none') {
        e.preventDefault();
        setTool('none');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length && !locked) {
        e.preventDefault();
        // As the toolbar's Delete: pending input is committed first, or keeps the selection.
        settle(() => controller.deleteSelection());
        return;
      }
      if (!history || locked) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      settle(() => (e.shiftKey ? history.redo() : history.undo()));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history, locked, controller, state.selection, settle, tool]);

  const items = [
    ...state.content.views.filter((v) => v.sheetId === sheet.id),
    ...state.content.annotations.filter((a) => a.sheetId === sheet.id),
  ];
  /** Paper mm (y up) of a pointer event on the sheet. */
  const paperAt = (e: { clientX: number; clientY: number }, el: HTMLElement): Vec2 => {
    const r = el.getBoundingClientRect();
    return [(e.clientX - r.left) / scale, paper[1] - (e.clientY - r.top) / scale];
  };
  const round = (n: number) => Math.round(n * 2) / 2;

  const tolerance = snapPx / scale;
  /** The snap a click of the current tool would take at `p`, if any. */
  const repicked = repick
    ? state.content.annotations.find((a) => a.id === repick.annotationId)
    : undefined;
  const snapAt = (p: Vec2): DrawingSnap | undefined => {
    if (tool === 'dimension') return controller.snap(p, pickOf(dimType).kind, tolerance);
    if (tool === 'repick' && repicked?.kind === 'dimension') {
      // In the dimension's own view, the kind of pick its type takes.
      const s = controller.snap(p, pickOf(repicked.type).kind, tolerance);
      return s;
    }
    if (tool === 'leader' || tool === 'symbol' || tool === 'repick' || tool === 'balloon') {
      // A point first, then an edge or a circle: the nearest of them.
      const all = [
        controller.snap(p, 'point', tolerance),
        controller.snap(p, 'line', tolerance),
        controller.snap(p, 'circle', tolerance),
      ].filter((x): x is DrawingSnap => !!x);
      return all.sort((a, b) => a.distance - b.distance)[0];
    }
    return undefined;
  };
  const placing = tool !== 'none' && !locked;
  const needed = pickOf(dimType).count;
  const onDimensionClick = (at: Vec2) => {
    setPickNotice(undefined);
    const chained =
      dimMode !== 'single' && pickOf(dimType).kind === 'point' && dimType !== 'aligned';
    if (run && chained) {
      const s = snapAt(at);
      if (!s) return setPickNotice('pick-none');
      if (s.viewId !== run.last.viewId) return setPickNotice('pick-view');
      const from = dimMode === 'chain' ? run.last : run.first;
      const view = state.content.views.find((v) => v.id === s.viewId)!;
      // Chain: on the same line; baseline: each one 7 mm further out.
      const step = dimMode === 'baseline' ? 7 : 0;
      const offset: Vec2 = dimType === 'horizontal' ? [0, step] : [step, 0];
      const { sign } = run;
      const next: Vec2 = [run.at[0] + offset[0] * sign, run.at[1] + offset[1] * sign];
      settle(() => {
        const err = controller.addDimension(view.id, dimType, [from.ref, s.ref], next);
        if (!err) setRun({ ...run, last: s, at: next, count: run.count + 1 });
      });
      return;
    }
    if (picks.length < needed) {
      const s = snapAt(at);
      if (!s) return setPickNotice('pick-none');
      if (picks.length && s.viewId !== picks[0]!.viewId) {
        setPicks([s]);
        return setPickNotice('pick-view');
      }
      setPicks([...picks, s]);
      return;
    }
    const first = picks[0]!;
    const last = picks[picks.length - 1]!;
    const placed: Vec2 = [round(at[0]), round(at[1])];
    // Away from the picked points: the side the first line was placed on.
    const sign =
      dimType === 'horizontal'
        ? Math.sign(placed[1] - (first.paper[1] + last.paper[1]) / 2) || 1
        : Math.sign(placed[0] - (first.paper[0] + last.paper[0]) / 2) || 1;
    settle(() => {
      const err = controller.addDimension(
        first.viewId,
        dimType,
        picks.map((p) => p.ref),
        [round(at[0]), round(at[1])],
      );
      setPicks([]);
      if (!err && chained) setRun({ first, last, at: placed, count: 1, sign });
    });
  };
  const onLeaderClick = (at: Vec2) => {
    setPickNotice(undefined);
    if (!picks.length && !run) {
      const s = snapAt(at);
      // A balloon is on a part: an edge of a view, never the bare paper.
      if (tool === 'balloon' && !s) return setPickNotice('pick-none');
      // Off any edge: the leader points at that place on the sheet.
      setPicks([s ?? { viewId: '', ref: null as never, paper: at, distance: 0 }]);
      return;
    }
    const target = picks[0]!;
    const to = target.viewId ? { viewId: target.viewId, ref: target.ref } : target.paper;
    const place: Vec2 = [round(at[0]), round(at[1])];
    if (tool === 'balloon')
      return settle(() => {
        controller.addBalloon(target.viewId, target.ref, place);
        setTool('none');
      });
    settle(() => {
      if (tool === 'symbol') controller.addSymbol(to, place, symbolStarter(symType));
      else controller.addLeader(to, place);
      setTool('none');
    });
  };
  const onRepickClick = (at: Vec2) => {
    setPickNotice(undefined);
    if (!repick || !repicked || repicked.kind === 'note') return setTool('none');
    const s = snapAt(at);
    if (!s) return setPickNotice('pick-none');
    if (s.viewId !== repicked.viewId) return setPickNotice('pick-view');
    settle(() => {
      const err = controller.rebindRef(repick.annotationId, repick.index, s.ref);
      if (!err) setTool('none');
    });
  };
  const onSheetPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!placing || tool === 'note') return;
    setHover(snapAt(paperAt(e, e.currentTarget)));
  };
  const onSheetPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (placing) {
      const at = paperAt(e, e.currentTarget);
      if (tool === 'note')
        settle(() => {
          controller.addNote([round(at[0]), round(at[1])], '注記');
          setTool('none');
        });
      else if (tool === 'dimension') onDimensionClick(at);
      else if (tool === 'repick') onRepickClick(at);
      else onLeaderClick(at);
      return;
    }
    // Pending input (a note being typed in) is committed first; a refused one keeps the
    // selection, so its text stays to be corrected.
    settle(() => controller.select([]));
  };
  const onItemPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    const selected = state.selection.includes(id)
      ? state.selection
      : e.shiftKey
        ? [...state.selection, id]
        : [id];
    const target = e.currentTarget;
    const { pointerId } = e;
    const start = paperAt(e, target.parentElement!);
    settle(() => {
      controller.select(selected);
      if (locked) return;
      target.setPointerCapture?.(pointerId);
      setDrag({ start, delta: [0, 0] });
    });
  };
  const onItemPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const at = paperAt(e, e.currentTarget.parentElement!);
    setDrag({ ...drag, delta: [round(at[0] - drag.start[0]), round(at[1] - drag.start[1])] });
  };
  const onItemPointerUp = () => {
    if (!drag) return;
    const { delta } = drag;
    setDrag(undefined);
    if (delta[0] || delta[1]) settle(() => controller.moveSelection(delta));
  };

  const download = (data: string | Uint8Array, filename: string, type: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  const fileName = `${(state.content.name || name).replace(/[\\/:*?"<>|]+/g, '_')}-${sheet.name.replace(/[\\/:*?"<>|]+/g, '_')}.svg`;
  // DW6: every sheet, once its views are derived.
  const [exporting, setExporting] = useState(false);
  const drawingFile = (ext: string) =>
    `${(state.content.name || name).replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;
  const exportAll = (kind: 'pdf' | 'dxf') =>
    settle(() => {
      if (!permitExport()) return;
      setExporting(true);
      void (async () => {
        if (kind === 'dxf')
          download(await controller.exportDxf(), drawingFile('dxf'), 'image/vnd.dxf');
        else {
          const pdf = await controller.exportPdf();
          if (typeof pdf !== 'string') download(pdf, drawingFile('pdf'), 'application/pdf');
        }
      })().finally(() => setExporting(false));
    });

  const issues = useMemo(
    () => controller.anchorIssues(),
    // Issues depend on the content and the views' states only.
    [controller, state.content, state.views],
  );
  const selectedView =
    state.selection.length === 1
      ? state.content.views.find((v) => v.id === state.selection[0])
      : undefined;
  const selectedAnnotation =
    state.selection.length === 1
      ? state.content.annotations.find((a) => a.id === state.selection[0])
      : undefined;
  const selectedNote =
    selectedAnnotation?.kind === 'note' || selectedAnnotation?.kind === 'leader'
      ? selectedAnnotation
      : undefined;
  const selectedSymbol = selectedAnnotation?.kind === 'symbol' ? selectedAnnotation : undefined;
  const selectedPmi = selectedAnnotation?.kind === 'pmi' ? selectedAnnotation : undefined;
  // DW3c-2b: imported PMI whose item changed or expired, every sheet, to review.
  const pmiReview = state.content.annotations.flatMap((a) => {
    if (a.kind !== 'pmi') return [];
    const r = controller.pmiState(a);
    return r.state === 'updated' || r.state === 'expired' ? [{ a, state: r.state }] : [];
  });
  const selectedDimension =
    selectedAnnotation?.kind === 'dimension' ? selectedAnnotation : undefined;
  const prompt =
    tool === 'note'
      ? 'Click the sheet to place the note.'
      : tool === 'balloon'
        ? picks.length
          ? 'Click where the balloon goes.'
          : 'Click an edge of the part.'
        : tool === 'leader' || tool === 'symbol'
          ? picks.length
            ? 'Click where the note text goes.'
            : 'Click the point, edge or place the leader points at.'
          : tool === 'repick'
            ? 'Click the edge or point it should measure; Esc cancels.'
            : tool === 'dimension'
              ? run
                ? `Pick the next point (${dimMode === 'chain' ? '連続 chain' : '累進 baseline'}); Esc ends.`
                : picks.length < needed
                  ? `Pick ${pickOf(dimType).kind === 'circle' ? 'a circle' : pickOf(dimType).kind === 'line' ? 'a straight edge' : 'a point'} (${picks.length + 1} of ${needed}).`
                  : 'Click where the dimension line goes.'
              : '';

  return (
    <div className="drawing-surface" data-testid="drawing-surface">
      {exportError && <p role="alert">{exportError}</p>}
      <EditorLayout
        viewKey="drawing"
        leftLabel="Sheets"
        inspectorLabel="Properties"
        toolbar={
          <Toolbar label="Drawing tools">
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
            <IconButton
              icon={StickyNote}
              label={tool === 'note' ? 'Click the sheet to place the note' : 'Add note'}
              aria-pressed={tool === 'note'}
              disabled={locked}
              reason={why}
              onClick={() => setTool(tool === 'note' ? 'none' : 'note')}
            />
            <IconButton
              icon={Ruler}
              label="Add dimension"
              aria-pressed={tool === 'dimension'}
              disabled={locked}
              reason={why}
              onClick={() => settle(() => setTool(tool === 'dimension' ? 'none' : 'dimension'))}
            />
            <IconButton
              icon={MessageSquareShare}
              label="Add leader"
              aria-pressed={tool === 'leader'}
              disabled={locked}
              reason={why}
              onClick={() => settle(() => setTool(tool === 'leader' ? 'none' : 'leader'))}
            />
            <IconButton
              icon={CircleDot}
              label="Add balloon"
              aria-pressed={tool === 'balloon'}
              disabled={locked}
              reason={why}
              onClick={() => settle(() => setTool(tool === 'balloon' ? 'none' : 'balloon'))}
            />
            <IconButton
              icon={Shapes}
              label="Add symbol"
              aria-pressed={tool === 'symbol'}
              disabled={locked}
              reason={why}
              onClick={() => settle(() => setTool(tool === 'symbol' ? 'none' : 'symbol'))}
            />
            <IconButton
              icon={Trash2}
              label="Delete selection"
              disabled={locked || !state.selection.length}
              reason={locked ? why : 'Select a view or a note'}
              onClick={() => settle(() => controller.deleteSelection())}
            />
            <IconButton
              icon={ZoomIn}
              label="Zoom in"
              onClick={() => setZoom(Math.min(20, scale * 1.25))}
            />
            <IconButton
              icon={ZoomOut}
              label="Zoom out"
              onClick={() => setZoom(Math.max(0.1, scale / 1.25))}
            />
            <IconButton icon={Maximize} label="Fit sheet" onClick={() => setZoom(undefined)} />
            <IconButton
              icon={Download}
              label="Export SVG"
              // Pending input (a field being typed in) is committed first, or blocks the export.
              onClick={() =>
                settle(() => {
                  if (permitExport()) download(controller.sheetSvg(), fileName, 'image/svg+xml');
                })
              }
            />
            <IconButton
              icon={FileText}
              label="Export PDF (all sheets)"
              disabled={exporting}
              reason="Exporting"
              onClick={() => exportAll('pdf')}
            />
            <IconButton
              icon={FileCode2}
              label="Export DXF (all sheets)"
              disabled={exporting}
              reason="Exporting"
              onClick={() => exportAll('dxf')}
            />
          </Toolbar>
        }
        left={
          <div className="drawing-panel">
            <Section title="Drawing">
              <Field
                readOnly={locked}
                label="Drawing name"
                value={state.content.name}
                onCommit={(text) => !controller.setName(text)}
              />
              <Choice
                label="Projection"
                value={state.content.projection}
                disabled={locked}
                options={[
                  { value: 'third-angle', label: '第三角法 Third angle' },
                  { value: 'first-angle', label: '第一角法 First angle' },
                ]}
                onChange={(v) =>
                  settle(() => controller.setProjection(v as 'third-angle' | 'first-angle'))
                }
              />
            </Section>
            <Section title="Sheets">
              <ul className="drawing-list" aria-label="Sheets">
                {state.content.sheets.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-current={s.id === sheet.id}
                      onClick={() => settle(() => controller.showSheet(s.id))}
                    >
                      {i + 1}. {s.name} <small>{s.size}</small>
                    </button>
                  </li>
                ))}
              </ul>
              <AddSheet
                disabled={locked}
                onAdd={(size, o) => settle(() => controller.addSheet(size, o))}
              />
            </Section>
            {controller.sources && (
              <Section title="Add views">
                <AddViews controller={controller} disabled={locked} />
              </Section>
            )}
            {issues.length > 0 && (
              <Section title="曖昧・未解決 To choose again">
                <ul className="drawing-list" aria-label="Unresolved dimensions">
                  {issues.map((i) => {
                    const a = state.content.annotations.find((x) => x.id === i.annotationId)!;
                    const where = state.content.sheets.find((x) => x.id === i.sheetId);
                    return (
                      <li key={`${i.annotationId}/${i.index}`}>
                        <button
                          type="button"
                          aria-current={state.selection.includes(a.id)}
                          data-anchor-state={i.state}
                          onClick={() =>
                            settle(() => {
                              if (i.sheetId !== sheet.id) controller.showSheet(i.sheetId);
                              controller.select([a.id]);
                            })
                          }
                        >
                          {itemName(a, true, state.content.views)} <small>{refStateText(i)}</small>
                          {where && where.id !== sheet.id && <small> · {where.name}</small>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}
            {pmiReview.length > 0 && (
              <Section title="PMIの確認 To review">
                <ul className="drawing-list" aria-label="PMI to review">
                  {pmiReview.map(({ a, state: st }) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        aria-current={state.selection.includes(a.id)}
                        data-pmi-state={st}
                        onClick={() =>
                          settle(() => {
                            if (a.sheetId !== sheet.id) controller.showSheet(a.sheetId);
                            controller.select([a.id]);
                          })
                        }
                      >
                        {itemName(a, true, state.content.views)} <small>{pmiStateText[st]}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {tool === 'repick' && (
              <Section title="Choose again">
                <p className="drawing-hint" data-testid="drawing-pick-prompt">
                  {prompt}
                </p>
              </Section>
            )}
            {tool === 'dimension' && (
              <Section title="Dimension">
                <Choice
                  label="Dimension type"
                  value={dimType}
                  options={drawingDimensionTypes.map((t) => ({
                    value: t,
                    label: dimensionLabels[t],
                  }))}
                  onChange={(v) => {
                    setDimType(v as DrawingDimensionType);
                    setPicks([]);
                    setRun(undefined);
                  }}
                />
                {(dimType === 'horizontal' || dimType === 'vertical') && (
                  <Choice
                    label="Dimension mode"
                    value={dimMode}
                    options={[
                      { value: 'single', label: '単独 Single' },
                      { value: 'chain', label: '連続 Chain' },
                      { value: 'baseline', label: '累進 Baseline' },
                    ]}
                    onChange={(v) => {
                      setDimMode(v as DrawingDimensionMode);
                      setPicks([]);
                      setRun(undefined);
                    }}
                  />
                )}
                <p className="drawing-hint" data-testid="drawing-pick-prompt">
                  {prompt}
                </p>
              </Section>
            )}
            {tool === 'symbol' && (
              <Section title="Symbol">
                <Choice
                  label="Symbol type"
                  value={symType}
                  options={(Object.keys(symbolLabels) as DrawingSymbolType[]).map((t) => ({
                    value: t,
                    label: symbolLabels[t],
                  }))}
                  onChange={(v) => setSymType(v as DrawingSymbolType)}
                />
                <p className="drawing-hint" data-testid="drawing-pick-prompt">
                  {prompt}
                </p>
              </Section>
            )}
            {tool === 'leader' && (
              <Section title="Leader">
                <p className="drawing-hint" data-testid="drawing-pick-prompt">
                  {prompt}
                </p>
              </Section>
            )}
            <Section title="On this sheet">
              <ul className="drawing-list" aria-label="Views and notes">
                {items.map((it) => (
                  <li key={it.id}>
                    <button
                      type="button"
                      aria-current={state.selection.includes(it.id)}
                      data-view-state={
                        isAnnotation(it) ? undefined : (state.views.get(it.id)?.status ?? 'pending')
                      }
                      onClick={() => settle(() => controller.select([it.id]))}
                    >
                      {itemName(it, true, state.content.views)}
                      {it.kind === 'dimension' && (
                        <DimensionValue controller={controller} dim={it} />
                      )}
                      {it.kind === 'symbol' && <SymbolStatus controller={controller} sym={it} />}
                      {it.kind === 'pmi' && (
                        <small> {pmiStateText[controller.pmiState(it).state] ?? ''}</small>
                      )}
                      {!isAnnotation(it) && state.views.get(it.id)?.status === 'failed' && (
                        <small> 表示できません</small>
                      )}
                    </button>
                  </li>
                ))}
                {!items.length && <li className="drawing-empty">No views or notes yet.</li>}
              </ul>
            </Section>
          </div>
        }
        inspector={
          <div className="drawing-panel">
            {selectedView && (
              <ViewPanel
                key={selectedView.id}
                view={selectedView}
                controller={controller}
                locked={locked}
                state={state.views.get(selectedView.id)}
              />
            )}
            {selectedAnnotation && selectedAnnotation.kind !== 'note' && (
              <RefsPanel
                key={`refs-${selectedAnnotation.id}`}
                issues={issues.filter((i) => i.annotationId === selectedAnnotation.id)}
                controller={controller}
                locked={locked}
                repicking={tool === 'repick' ? repick : undefined}
                onRepick={(index) =>
                  settle(() => {
                    setTool('repick');
                    setRepick({ annotationId: selectedAnnotation.id, index });
                  })
                }
              />
            )}
            {selectedPmi && (
              <PmiPanel
                key={selectedPmi.id}
                note={selectedPmi}
                controller={controller}
                locked={locked}
              />
            )}
            {selectedDimension && (
              <DimensionPanel
                key={selectedDimension.id}
                dim={selectedDimension}
                controller={controller}
                locked={locked}
              />
            )}
            {selectedSymbol && (
              <SymbolPanel
                key={selectedSymbol.id}
                sym={selectedSymbol}
                controller={controller}
                locked={locked}
              />
            )}
            {selectedNote && (
              <NotePanel
                key={selectedNote.id}
                note={selectedNote}
                controller={controller}
                locked={locked}
              />
            )}
            <SheetPanel controller={controller} state={state} locked={locked} />
          </div>
        }
        status={
          <span className="drawing-status" data-testid="drawing-status">
            {sheet.name} · {sheet.size} {sheet.orientation === 'landscape' ? '横' : '縦'} ·{' '}
            {Math.round(scale * 100) / 100} px/mm
            {pickNotice && placing && (
              <span className="drawing-notice" role="status" data-testid="drawing-pick-notice">
                {' '}
                · {messages[pickNotice]}
              </span>
            )}
            {state.notice && (
              <span className="drawing-notice" role="alert" data-testid="drawing-notice">
                {' '}
                · {drawingNoticeText(state.notice)}
              </span>
            )}
          </span>
        }
        {...layout}
      >
        <div className="drawing-stage" ref={stage} data-testid="drawing-stage">
          <div
            className={`drawing-sheet${placing ? ' placing' : ''}`}
            data-testid="drawing-sheet"
            data-tool={tool}
            aria-label={`${sheet.name} sheet`}
            style={{ width: paper[0] * scale, height: paper[1] * scale }}
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerLeave={() => setHover(undefined)}
          >
            {url && <img src={url} alt={`${sheet.name}`} draggable={false} />}
            {items.map((it) => {
              const [[x0, y0], [x1, y1]] = itemBox(
                it,
                isAnnotation(it) ? undefined : state.views.get(it.id),
                controller,
              );
              const selected = state.selection.includes(it.id);
              const d = selected && drag ? drag.delta : [0, 0];
              return (
                <button
                  key={it.id}
                  type="button"
                  className={`drawing-hit${selected ? ' selected' : ''}`}
                  data-testid={`drawing-item-${it.id}`}
                  aria-label={itemName(it, false, state.content.views)}
                  aria-pressed={selected}
                  style={{
                    left: (x0 + d[0]!) * scale - 2,
                    top: (paper[1] - y1 - d[1]!) * scale - 2,
                    width: (x1 - x0) * scale + 4,
                    height: (y1 - y0) * scale + 4,
                  }}
                  onPointerDown={(e) => onItemPointerDown(e, it.id)}
                  onPointerMove={onItemPointerMove}
                  onPointerUp={onItemPointerUp}
                />
              );
            })}
            {state.placing
              ?.filter((p) => p.sheetId === sheet.id)
              .map((p, i) => (
                <div
                  key={i}
                  className="drawing-placing"
                  role="status"
                  data-testid="drawing-placing"
                  style={{
                    left: p.at[0] * scale,
                    top: (paper[1] - p.at[1]) * scale + i * 44,
                  }}
                >
                  <span className="drawing-placing-spin" aria-hidden />
                  作図中 Drawing {p.name}
                  {p.scale === 'fit' ? '' : ` · ${p.scale}`}…
                </div>
              ))}
            {placing &&
              [...picks, ...(run ? [run.last] : []), ...(hover ? [hover] : [])].map((p, i, all) => (
                <span
                  key={i}
                  className={`drawing-pick${hover && i === all.length - 1 ? ' hover' : ''}`}
                  data-testid={hover && i === all.length - 1 ? 'drawing-snap' : 'drawing-pick'}
                  style={{ left: p.paper[0] * scale - 5, top: (paper[1] - p.paper[1]) * scale - 5 }}
                />
              ))}
          </div>
        </div>
      </EditorLayout>
    </div>
  );
}

const elevationLabels: Record<DrawingElevationSide, string> = {
  front: '立面図 正面 Front elevation',
  rear: '立面図 背面 Rear elevation',
  left: '立面図 左側 Left elevation',
  right: '立面図 右側 Right elevation',
};

const viewSets = [
  { value: 'three', label: '三面図 Three views' },
  ...drawingDirections.map((d) => ({ value: d, label: directionLabels[d] })),
];

function AddViews({ controller, disabled }: { controller: DrawingController; disabled: boolean }) {
  const choices = controller.sources!.choices();
  const [key, setKey] = useState('');
  const [set, setSet] = useState<DrawingViewSet>('three');
  const [scale, setScale] = useState<DrawingScale | 'fit'>('fit');
  const [bimViewId, setBimViewId] = useState('');
  const [bimScale, setBimScale] = useState<DrawingBimScale | 'own' | 'fit'>('own');
  const [band, setBand] = useState('1000');
  const [busy, setBusy] = useState(false);
  const settle = useSettle();
  const choice = choices.find((c) => c.key === key) ?? choices[0];
  if (!choice)
    return (
      <p className="drawing-hint">
        Save a version of a 3D CAD part or assembly, or of a building, first.
      </p>
    );
  // DW5a, DW5b: a building version's own plans and sections, its elevations, a framing plan of
  // a level and a framing elevation along a grid axis.
  if (choice.kind === 'bim') {
    const options = [
      ...(choice.views ?? []).map((v) => ({
        value: `view:${v.id}`,
        label: `${v.kind === 'plan' ? '平面図' : '断面図'} ${v.name}`,
        own: v.scale as DrawingBimScale | undefined,
      })),
      ...drawingElevationSides.map((side) => ({
        value: `elevation:${side}`,
        label: elevationLabels[side],
        own: undefined,
      })),
      ...(choice.levels ?? []).map((l) => ({
        value: `framing:${l.id}`,
        label: `伏図 ${l.name}`,
        own: undefined,
      })),
      ...(choice.grids ?? []).map((g) => ({
        value: `frame:${g.id}`,
        label: `軸組図 ${g.label}通り`,
        own: undefined,
      })),
    ];
    const shown = options.find((o) => o.value === bimViewId) ?? options[0]!;
    const [type, ref] = [
      shown.value.slice(0, shown.value.indexOf(':')),
      shown.value.slice(shown.value.indexOf(':') + 1),
    ];
    const what: DrawingBuildingViewWhat =
      type === 'view'
        ? { kind: 'bim-view', bimViewId: ref }
        : type === 'elevation'
          ? { kind: 'bim-elevation', side: ref as DrawingElevationSide }
          : type === 'framing'
            ? { kind: 'bim-framing', levelId: ref }
            : { kind: 'bim-frame', gridId: ref, bandMm: Number(band) };
    const scaleValue = bimScale === 'own' && !shown.own ? 'fit' : bimScale;
    return (
      <div className="drawing-column">
        <Choice
          label="Source version"
          value={choice.key}
          options={choices.map((c) => ({ value: c.key, label: c.label }))}
          disabled={disabled || busy}
          onChange={setKey}
        />
        <Choice
          label="Building view"
          value={shown.value}
          options={options}
          disabled={disabled || busy}
          onChange={setBimViewId}
        />
        {type === 'frame' && (
          <Choice
            label="Members within (mm)"
            value={band}
            options={[
              { value: '500', label: '500' },
              { value: '1000', label: '1000' },
              { value: '2000', label: '2000' },
              { value: '5000', label: '5000' },
              { value: '0', label: '全部 All' },
            ]}
            disabled={disabled || busy}
            onChange={setBand}
          />
        )}
        <Choice
          label="View scale"
          value={scaleValue}
          options={[
            ...(shown.own ? [{ value: 'own', label: `View's own (${shown.own})` }] : []),
            { value: 'fit', label: 'Fit sheet' },
            ...drawingBimScales.map((v) => ({ value: v, label: v })),
          ]}
          disabled={disabled || busy}
          onChange={(v) => setBimScale(v as DrawingBimScale | 'own' | 'fit')}
        />
        <IconButton
          icon={Building2}
          label="Place building view"
          disabled={disabled || busy}
          reason={busy ? 'Placing views' : 'Read only'}
          onClick={() =>
            settle(() => {
              setBusy(true);
              void controller
                .addBuildingView(choice, what, scaleValue === 'own' ? undefined : scaleValue)
                .finally(() => setBusy(false));
            })
          }
        />
      </div>
    );
  }
  return (
    <div className="drawing-column">
      <Choice
        label="Source version"
        value={choice.key}
        options={choices.map((c) => ({ value: c.key, label: c.label }))}
        disabled={disabled || busy}
        onChange={setKey}
      />
      <Choice
        label="Views"
        value={set}
        options={viewSets}
        disabled={disabled || busy}
        onChange={(v) => setSet(v as DrawingViewSet)}
      />
      <Choice
        label="View scale"
        value={scale}
        options={[
          { value: 'fit', label: 'Fit sheet' },
          ...drawingScales.map((v) => ({ value: v, label: v })),
        ]}
        disabled={disabled || busy}
        onChange={(v) => setScale(v as DrawingScale | 'fit')}
      />
      <IconButton
        icon={Box}
        label="Place views"
        disabled={disabled || busy}
        reason={busy ? 'Placing views' : 'Read only'}
        onClick={() =>
          settle(() => {
            setBusy(true);
            void controller.addCadViews(choice, set, scale).finally(() => setBusy(false));
          })
        }
      />
    </div>
  );
}

function AddSheet({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd(size: DrawingSheetSize, o: DrawingOrientation): void;
}) {
  const [size, setSize] = useState<DrawingSheetSize>('A3');
  const [orientation, setOrientation] = useState<DrawingOrientation>('landscape');
  return (
    <div className="drawing-row">
      <Choice
        label="New sheet size"
        value={size}
        options={drawingSheetSizeNames}
        disabled={disabled}
        onChange={(v) => setSize(v as DrawingSheetSize)}
      />
      <Choice
        label="Orientation"
        value={orientation}
        options={drawingOrientations.map((o) => ({
          value: o,
          label: o === 'landscape' ? '横 Landscape' : '縦 Portrait',
        }))}
        disabled={disabled}
        onChange={(v) => setOrientation(v as DrawingOrientation)}
      />
      <IconButton
        icon={FilePlus2}
        label="Add sheet"
        disabled={disabled}
        reason="Read only"
        onClick={() => onAdd(size, orientation)}
      />
    </div>
  );
}

function SheetPanel({
  controller,
  state,
  locked,
}: {
  controller: DrawingController;
  state: DrawingSurfaceState;
  locked: boolean;
}) {
  const settle = useSettle();
  const sheet = state.content.sheets.find((s) => s.id === state.sheetId)!;
  const [revision, setRevision] = useState('');
  return (
    <>
      <Section title="Sheet">
        <Field
          readOnly={locked}
          label="Sheet name"
          value={sheet.name}
          onCommit={(text) => !controller.updateSheet({ name: text })}
        />
        <Choice
          label="Size"
          value={sheet.size}
          options={drawingSheetSizeNames}
          disabled={locked}
          onChange={(v) => settle(() => controller.updateSheet({ size: v as DrawingSheetSize }))}
        />
        <Choice
          label="Sheet orientation"
          value={sheet.orientation}
          options={drawingOrientations.map((o) => ({
            value: o,
            label: o === 'landscape' ? '横 Landscape' : '縦 Portrait',
          }))}
          disabled={locked}
          onChange={(v) =>
            settle(() => controller.updateSheet({ orientation: v as DrawingOrientation }))
          }
        />
        <label className="ep-field drawing-check">
          <input
            type="checkbox"
            checked={sheet.filing}
            disabled={locked}
            onChange={(e) => settle(() => controller.updateSheet({ filing: e.target.checked }))}
          />
          Filing margin (とじしろ)
        </label>
        <IconButton
          icon={Trash2}
          label="Delete sheet"
          disabled={locked || state.content.sheets.length < 2}
          reason={locked ? 'Read only' : 'The last sheet stays'}
          onClick={() => settle(() => controller.deleteSheet())}
        />
      </Section>
      <Section title="Title block">
        {drawingTitleFields.map((k) => (
          <Field
            key={k}
            readOnly={locked}
            label={titleLabels[k]}
            value={sheet.title[k]}
            onCommit={(text) =>
              !controller.updateSheet({ title: { ...sheet.title, [k]: text } }, 'Edit title block')
            }
          />
        ))}
      </Section>
      <Section title="Revisions">
        <ol className="drawing-revisions" aria-label="Revisions">
          {sheet.revisions.map((r) => (
            <li key={r.id}>
              <b>{r.mark}</b> {r.date} {r.description} {r.by && `(${r.by})`}
            </li>
          ))}
        </ol>
        {!locked && (
          <div className="drawing-row">
            <label className="ep-field">
              Revision description
              <input
                type="text"
                aria-label="Revision description"
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!revision.trim()}
              onClick={() =>
                settle(() => {
                  const today = new Date();
                  const p = (n: number) => String(n).padStart(2, '0');
                  const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
                  if (!controller.addRevision(revision.trim(), date, sheet.title.drawnBy))
                    setRevision('');
                })
              }
            >
              Add revision
            </button>
          </div>
        )}
      </Section>
      <IssuePanel controller={controller} state={state} locked={locked} />
    </>
  );
}

/**
 * DW6b: issuing (発行) this sheet or every sheet: each gets its next revision, and the Host keeps
 * the drawing as a version with the PDF as issued. The issues so far, each PDF to download.
 */
function IssuePanel({
  controller,
  state,
  locked,
}: {
  controller: DrawingController;
  state: DrawingSurfaceState;
  locked: boolean;
}) {
  const settle = useSettle();
  const [which, setWhich] = useState<'sheet' | 'all'>('sheet');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const issued = controller.issued();
  const download = (versionId: string, name: string) => {
    const bytes = controller.issuedPdf(versionId);
    if (!bytes) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, '_')}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  if (!controller.issuing) return null;
  return (
    <Section title="発行 Issue">
      {!locked && (
        <>
          <Choice
            label="Sheets to issue"
            value={which}
            options={[
              { value: 'sheet', label: 'この用紙 This sheet' },
              { value: 'all', label: '全部の用紙 All sheets' },
            ]}
            disabled={busy}
            onChange={(v) => setWhich(v as 'sheet' | 'all')}
          />
          <label className="ep-field">
            Issue description
            <input
              type="text"
              aria-label="Issue description"
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() =>
              settle(() => {
                const today = new Date();
                const p = (n: number) => String(n).padStart(2, '0');
                const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
                const sheet = state.content.sheets.find((s) => s.id === state.sheetId)!;
                const ids = which === 'all' ? state.content.sheets.map((s) => s.id) : [sheet.id];
                setBusy(true);
                void controller
                  .issueSheets(ids, { description: text.trim(), date })
                  .then((err) => {
                    if (!err) setText('');
                  })
                  .finally(() => setBusy(false));
              })
            }
          >
            {busy ? 'Issuing…' : '発行する Issue'}
          </button>
        </>
      )}
      <ol className="drawing-revisions" aria-label="Issues">
        {issued.map((i) => {
          const label = i.sheets.map((s) => `${s.name} ${s.mark}`).join(', ');
          return (
            <li key={i.versionId} data-testid="drawing-issue">
              {i.issuedAt.slice(0, 10)} {label}{' '}
              <button
                type="button"
                aria-label={`Download issued PDF ${label}`}
                onClick={() => download(i.versionId, `${state.content.name}-${label}`)}
              >
                PDF
              </button>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

const lookLabels: Record<DrawingSectionLook, string> = {
  right: '右を見る →',
  left: '左を見る ←',
  up: '上を見る ↑',
  down: '下を見る ↓',
};
const num = (text: string) => {
  const t = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
};
/** The way a cutting line is seen (its arrows), from its points. */
function lookOf(line: [Vec2, Vec2]): DrawingSectionLook {
  const dx = line[1][0] - line[0][0];
  const dy = line[1][1] - line[0][1];
  // To the right of a → b: (dy, −dx).
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'right' : 'left';
  return dx > 0 ? 'down' : 'up';
}

function ViewPanel({
  view,
  controller,
  locked,
  state,
}: {
  view: DrawingView;
  controller: DrawingController;
  locked: boolean;
  state: DrawingViewState | undefined;
}) {
  const settle = useSettle();
  const [busy, setBusy] = useState(false);
  const content = controller.state.content;
  const source = content.sources.find((s) => s.id === view.sourceId);
  const newer = source ? controller.newerVersion(source.id) : undefined;
  // DW3c-2b: the view's current PMI items not imported into it yet.
  const imported = new Set(
    content.annotations.flatMap((a) =>
      a.kind === 'pmi' && a.viewId === view.id
        ? [JSON.stringify([a.source.path, a.source.bodyId, a.source.itemId])]
        : [],
    ),
  );
  const pmiLeft =
    state?.status === 'ready'
      ? (state.graphics.pmi ?? []).filter(
          (l) => l.current && !imported.has(JSON.stringify([l.path, l.bodyId, l.itemId])),
        ).length
      : 0;
  // DW4: the parts of an assembly's version (a single part has no list to make).
  const partsInfo = state?.status === 'ready' ? state.graphics.parts : undefined;
  const assembly = drawingIsAssembly(partsInfo);
  const unballooned = assembly
    ? partsInfo.rows.filter(
        (r) =>
          !content.annotations.some(
            (a) =>
              a.kind === 'balloon' &&
              a.viewId === view.id &&
              controller.partRowOf(view.id, a.ref)?.key === r.key,
          ),
      ).length
    : 0;
  const listed = content.annotations.some((a) => a.kind === 'parts-list' && a.viewId === view.id);
  const members = state?.status === 'ready' ? state.graphics.members : undefined;
  const parent =
    view.kind === 'cad-section' || view.kind === 'cad-detail'
      ? content.views.find((v) => v.id === view.parentId)
      : undefined;
  const parentState = parent ? controller.state.views.get(parent.id) : undefined;
  const parentFrame = parentState?.status === 'ready' ? parentState.graphics.frame : undefined;
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  return (
    <>
      <Section title="View">
        <Field
          readOnly={locked}
          label="View name"
          value={view.name}
          onCommit={(text) => !controller.updateView({ ...view, name: text })}
        />
        <p className="drawing-source" data-testid="drawing-view-source">
          {source ? `${source.name} · ${source.versionId}` : 'No source'}
          {state?.status === 'failed' && <span className="drawing-error"> · {state.code}</span>}
        </p>
        {newer && (
          <IconButton
            icon={RefreshCw}
            label={`新しい版を使う Use ${newer.label}`}
            disabled={locked || busy}
            reason={busy ? 'Switching version' : 'Read only'}
            onClick={() =>
              settle(() => {
                setBusy(true);
                void controller.switchSource(source!.id, newer).finally(() => setBusy(false));
              })
            }
          />
        )}
        {unballooned > 0 && (
          <IconButton
            icon={CircleDot}
            label={`風船を付ける Add balloons (${unballooned})`}
            disabled={locked}
            onClick={() => settle(() => controller.addBalloons(view.id))}
          />
        )}
        {assembly && !listed && (
          <IconButton
            icon={ListOrdered}
            label="部品欄を置く Add parts list"
            disabled={locked}
            onClick={() => settle(() => controller.addPartsList(view.id))}
          />
        )}
        {!!members?.length && !listed && (
          <IconButton
            icon={ListOrdered}
            label="部材リストを置く Add member list"
            disabled={locked}
            onClick={() => settle(() => controller.addPartsList(view.id))}
          />
        )}
        {assembly && view.kind === 'cad-projection' && !view.only.length && (
          <IconButton
            icon={Files}
            label="部品図を作る Make part drawings"
            disabled={locked || busy}
            onClick={() =>
              settle(() => {
                setBusy(true);
                void controller.addPartDrawings(view.id).finally(() => setBusy(false));
              })
            }
          />
        )}
        {pmiLeft > 0 && (
          <IconButton
            icon={FileInput}
            label={`PMIを取り込む Import PMI (${pmiLeft})`}
            disabled={locked}
            onClick={() => settle(() => controller.importPmi(view.id))}
          />
        )}
        <Choice
          label="Scale"
          value={view.scale}
          options={drawingIsBuildingView(view) ? drawingBimScales : drawingScales}
          disabled={locked}
          onChange={(v) =>
            settle(() => controller.updateView({ ...view, scale: v as DrawingScale }))
          }
        />
        {view.kind === 'cad-projection' && (
          <Choice
            label="Direction"
            value={view.direction}
            options={drawingDirections.map((d) => ({ value: d, label: directionLabels[d] }))}
            disabled={locked}
            onChange={(v) =>
              settle(() => controller.updateView({ ...view, direction: v as DrawingDirection }))
            }
          />
        )}
        {view.kind === 'cad-section' && (
          <>
            <p className="drawing-source">断面記号 Mark {view.mark}</p>
            <Choice
              label="Seen (矢印)"
              value={lookOf(view.line)}
              options={(['right', 'left', 'up', 'down'] as const)
                .filter((l) =>
                  lookOf(view.line) === 'right' || lookOf(view.line) === 'left'
                    ? l === 'right' || l === 'left'
                    : l === 'up' || l === 'down',
                )
                .map((l) => ({ value: l, label: lookLabels[l] }))}
              disabled={locked}
              onChange={(v) =>
                v !== lookOf(view.line) &&
                settle(() => controller.updateView({ ...view, line: [view.line[1], view.line[0]] }))
              }
            />
            {parentFrame && (
              <Field
                readOnly={locked}
                label="Cut offset from centre (mm)"
                value={fmt(
                  lookOf(view.line) === 'right' || lookOf(view.line) === 'left'
                    ? view.line[0][0] - parentFrame.center[0]
                    : view.line[0][1] - parentFrame.center[1],
                )}
                onCommit={(text) => {
                  const v = num(text);
                  if (v === undefined) return false;
                  const vertical = lookOf(view.line) === 'right' || lookOf(view.line) === 'left';
                  const k = vertical ? 0 : 1;
                  const d = parentFrame.center[k] + v - view.line[0][k];
                  const move = (p: Vec2): Vec2 => (vertical ? [p[0] + d, p[1]] : [p[0], p[1] + d]);
                  return !controller.updateView({
                    ...view,
                    line: [move(view.line[0]), move(view.line[1])],
                  });
                }}
              />
            )}
          </>
        )}
        {view.kind === 'cad-detail' && (
          <>
            <p className="drawing-source">詳細記号 Mark {view.mark}</p>
            <Field
              readOnly={locked}
              label="Detail radius (mm)"
              value={fmt(view.radius)}
              onCommit={(text) => {
                const v = num(text);
                return v !== undefined && v > 0 && !controller.updateView({ ...view, radius: v });
              }}
            />
            {parentFrame &&
              ([0, 1] as const).map((k) => (
                <Field
                  key={k}
                  readOnly={locked}
                  label={`Detail centre ${k ? 'y' : 'x'} from centre (mm)`}
                  value={fmt(view.center[k] - parentFrame.center[k])}
                  onCommit={(text) => {
                    const v = num(text);
                    if (v === undefined) return false;
                    const center: Vec2 = [...view.center];
                    center[k] = parentFrame.center[k] + v;
                    return !controller.updateView({ ...view, center });
                  }}
                />
              ))}
          </>
        )}
        {(view.kind === 'cad-detail' || drawingIsBuildingView(view)
          ? (['label'] as const)
          : (['hiddenLines', 'centerLines', 'label'] as const)
        ).map((k) => (
          <label key={k} className="ep-field drawing-check">
            <input
              type="checkbox"
              checked={(view as Record<typeof k, boolean>)[k]}
              disabled={locked}
              onChange={(e) =>
                settle(() =>
                  controller.updateView({ ...view, [k]: e.target.checked } as DrawingView),
                )
              }
            />
            {checkLabels[k]}
          </label>
        ))}
      </Section>
      {view.kind === 'cad-projection' && view.direction !== 'iso' && (
        <Section title="Section">
          <AddSection controller={controller} view={view} disabled={locked} />
        </Section>
      )}
      {(view.kind === 'cad-section' ||
        (view.kind === 'cad-projection' && view.direction !== 'iso')) && (
        <Section title="Detail">
          <AddDetail controller={controller} view={view} disabled={locked} />
        </Section>
      )}
    </>
  );
}
const checkLabels = {
  hiddenLines: 'Hidden lines (かくれ線)',
  centerLines: 'Centre lines (中心線)',
  label: 'Label',
};

function NumberInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  disabled: boolean;
}) {
  return (
    <label className="ep-field">
      {label}
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function AddSection({
  controller,
  view,
  disabled,
}: {
  controller: DrawingController;
  view: DrawingView;
  disabled: boolean;
}) {
  const settle = useSettle();
  const [look, setLook] = useState<DrawingSectionLook>('right');
  const [offset, setOffset] = useState('0');
  const [origin, setOrigin] = useState(false);
  const ready = controller.state.views.get(view.id)?.status === 'ready';
  return (
    <div className="drawing-column">
      <Choice
        label="Cutting line"
        value={look}
        options={(['right', 'left', 'up', 'down'] as const).map((l) => ({
          value: l,
          label: `${l === 'right' || l === 'left' ? '縦' : '横'} ${lookLabels[l]}`,
        }))}
        disabled={disabled}
        onChange={(v) => setLook(v as DrawingSectionLook)}
      />
      <NumberInput
        label={origin ? 'Section offset from origin (mm)' : 'Section offset from centre (mm)'}
        value={offset}
        disabled={disabled}
        onChange={setOffset}
      />
      <label className="ep-field drawing-check">
        <input
          type="checkbox"
          checked={origin}
          disabled={disabled}
          onChange={(e) => setOrigin(e.target.checked)}
        />
        断面を原点から Section from the model origin
      </label>
      <IconButton
        icon={Scissors}
        label="Add section"
        disabled={disabled || !ready || num(offset) === undefined}
        reason={disabled ? 'Read only' : !ready ? 'The view is not drawn yet' : 'Enter a number'}
        onClick={() =>
          settle(() =>
            controller.addSection(view.id, look, num(offset) ?? 0, origin ? 'origin' : 'centre'),
          )
        }
      />
    </div>
  );
}

function AddDetail({
  controller,
  view,
  disabled,
}: {
  controller: DrawingController;
  view: DrawingView;
  disabled: boolean;
}) {
  const settle = useSettle();
  const [x, setX] = useState('0');
  const [y, setY] = useState('0');
  const [radius, setRadius] = useState('');
  const [origin, setOrigin] = useState(false);
  const [scale, setScale] = useState('');
  const ready = controller.state.views.get(view.id)?.status === 'ready';
  const r = radius.trim() ? num(radius) : undefined;
  const ok =
    num(x) !== undefined && num(y) !== undefined && (!radius.trim() || (r !== undefined && r > 0));
  return (
    <div className="drawing-column">
      <NumberInput
        label={origin ? 'Detail x from origin (mm)' : 'Detail x from centre (mm)'}
        value={x}
        disabled={disabled}
        onChange={setX}
      />
      <NumberInput
        label={origin ? 'Detail y from origin (mm)' : 'Detail y from centre (mm)'}
        value={y}
        disabled={disabled}
        onChange={setY}
      />
      <label className="ep-field drawing-check">
        <input
          type="checkbox"
          checked={origin}
          disabled={disabled}
          onChange={(e) => setOrigin(e.target.checked)}
        />
        詳細を原点から Detail from the model origin
      </label>
      <NumberInput
        label="New detail radius (mm)"
        value={radius}
        disabled={disabled}
        onChange={setRadius}
      />
      <Choice
        label="New detail scale"
        value={scale}
        disabled={disabled}
        options={[
          { value: '', label: '自動 Auto' },
          ...drawingScales.map((v) => ({ value: v, label: v })),
        ]}
        onChange={setScale}
      />
      <IconButton
        icon={Search}
        label="Add detail"
        disabled={disabled || !ready || !ok}
        reason={disabled ? 'Read only' : !ready ? 'The view is not drawn yet' : 'Enter numbers'}
        onClick={() =>
          settle(() =>
            controller.addDetail(
              view.id,
              [num(x)!, num(y)!],
              r,
              (scale || undefined) as DrawingScale | undefined,
              origin ? 'origin' : 'centre',
            ),
          )
        }
      />
    </div>
  );
}

function NotePanel({
  note,
  controller,
  locked,
}: {
  note: DrawingNote | DrawingLeader;
  controller: DrawingController;
  locked: boolean;
}) {
  const settle = useSettle();
  const update = (n: DrawingNote | DrawingLeader) =>
    n.kind === 'note' ? controller.updateNote(n) : controller.updateAnnotation(n, 'Edit leader');
  const [text, setText] = useState(note.text);
  const [composing, setComposing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // Undo/Redo or another edit changed the note: show it, unless it is being typed in.
  const [observed, setObserved] = useState(note.text);
  if (observed !== note.text) {
    setObserved(note.text);
    if (document.activeElement !== area.current && !composing) setText(note.text);
  }
  const dirty = !locked && text !== note.text;
  const valid = () => !!text.trim();
  const commit = () => {
    if (text === note.text) return;
    if (!valid()) throw new Error('A note needs some text.');
    const err = update({ ...note, text });
    if (err) throw new Error(drawingNoticeText({ code: err }));
  };
  // The text being typed is pending at the Host's boundaries (save, export, switch): a save
  // commits it first, or is refused while it is invalid or being composed (IME).
  useEditorInput({
    label: 'Note text',
    read: () => ({ dirty, composing }),
    prepare: () => {
      if (dirty && !valid()) throw new Error('A note needs some text.');
      return commit;
    },
    focus: () => area.current?.focus(),
  });
  return (
    <Section title={note.kind === 'note' ? 'Note' : 'Leader note'}>
      <label className="ep-field">
        Note text
        <textarea
          ref={area}
          aria-label="Note text"
          value={text}
          readOnly={locked}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onBlur={() => {
            // A refused edit keeps the text typed; the notice says why.
            if (!composing && dirty && valid()) update({ ...note, text });
          }}
        />
      </label>
      <Choice
        label="Text height (mm)"
        value={note.heightMm}
        options={drawingTextHeights}
        disabled={locked}
        onChange={(v) =>
          settle(() => update({ ...note, heightMm: Number(v) as DrawingTextHeight }))
        }
      />
    </Section>
  );
}

const statusText: Record<string, string> = {
  pending: '描画待ち',
  unresolved: '未解決',
  ambiguous: '曖昧',
  parallel: '平行な線（角度なし）',
};

function DimensionValue({
  controller,
  dim,
}: {
  controller: DrawingController;
  dim: DrawingDimension;
}) {
  const g = controller.annotationGraphics(dim);
  if (g.status !== 'ok') return <small> {statusText[g.status]}</small>;
  return g.value === undefined ? null : (
    <small>
      {' '}
      {drawingDimensionValue(g.value)}
      {dim.type === 'angle' ? '°' : ''}
    </small>
  );
}

const pmiStateText: Record<string, string> = {
  ok: '',
  pending: '描画待ち',
  updated: '内容を更新',
  expired: '失効・要確認',
};

/**
 * DW3c-2b: an imported PMI item: what it says, where it stands against the version shown, what
 * changed, and the two ways on: confirm an update, or detach it into a hand-made annotation.
 */
function PmiPanel({
  note,
  controller,
  locked,
}: {
  note: DrawingPmiNote;
  controller: DrawingController;
  locked: boolean;
}) {
  const settle = useSettle();
  const r = controller.pmiState(note);
  const changes = r.state === 'updated' && r.live ? drawingPmiChanges(note.item, r.live.item) : [];
  return (
    <Section title="PMI">
      <p className="drawing-hint" data-testid="drawing-pmi-item">
        {drawingPmiText(r.state === 'updated' && r.live ? r.live.item : note.item)}
        {pmiStateText[r.state] ? ` · ${pmiStateText[r.state]}` : ''}
      </p>
      {r.state === 'updated' && (
        <>
          <p className="drawing-notice">元のPMIの内容が変わりました。確認してください。</p>
          <ul className="drawing-changes" aria-label="PMI changes">
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={locked}
            onClick={() => settle(() => controller.confirmPmi(note.id))}
          >
            更新を確認 Confirm
          </button>
        </>
      )}
      {r.state === 'expired' && (
        <p className="drawing-notice">
          元のPMIの項目が無いか、対象の形・データムが変わって有効ではありません（失効・要確認）。
          発行の前に、削除するか手動の注記へ切り離してください。
        </p>
      )}
      <button
        type="button"
        disabled={locked}
        onClick={() => settle(() => controller.detachPmi(note.id))}
      >
        手動の注記へ切り離す Detach
      </button>
    </Section>
  );
}

const refStateText = (i: DrawingAnchorIssue) =>
  i.state === 'ambiguous' ? `曖昧 (${i.candidates.length} 候補)` : '未解決';
const xyz = (p: readonly number[]) => p.map((v) => drawingDimensionValue(v, 1)).join(', ');

/**
 * DW3c: the refs of the selected annotation that do not resolve: an ambiguous one lists the
 * edges of its name to choose from, and either kind can be picked again on the sheet.
 */
function RefsPanel({
  issues,
  controller,
  locked,
  repicking,
  onRepick,
}: {
  issues: DrawingAnchorIssue[];
  controller: DrawingController;
  locked: boolean;
  repicking?: { index: number };
  onRepick(index: number): void;
}) {
  const settle = useSettle();
  if (!issues.length) return null;
  const doc = controller.state.content;
  return (
    <Section title="参照 References">
      {issues.map((i) => {
        const a = doc.annotations.find((x) => x.id === i.annotationId)!;
        const ref = a.kind === 'dimension' ? a.refs[i.index]! : (a as DrawingLeader).ref!;
        return (
          <div key={i.index} className="drawing-refs" data-testid="drawing-ref-issue">
            <p className="drawing-notice">
              参照 {i.index + 1}:{' '}
              {i.state === 'ambiguous'
                ? '同じ名前の辺が複数あります。候補から選ぶか、図で選び直してください。'
                : '参照する形状が見つかりません。図で選び直してください。'}
            </p>
            {i.candidates.map((f, k) => {
              const next = drawingRefOn(ref, f);
              return (
                <button
                  key={f.anchor.edge}
                  type="button"
                  disabled={locked}
                  onClick={() => settle(() => controller.rebindRef(a.id, i.index, next))}
                >
                  候補 {k + 1} Candidate ({xyz(next.model)})
                </button>
              );
            })}
            <button
              type="button"
              disabled={locked}
              aria-pressed={repicking?.index === i.index}
              onClick={() => onRepick(i.index)}
            >
              図で選び直す Pick again
            </button>
          </div>
        );
      })}
    </Section>
  );
}

function DimensionPanel({
  dim,
  controller,
  locked,
}: {
  dim: DrawingDimension;
  controller: DrawingController;
  locked: boolean;
}) {
  const settle = useSettle();
  const g = controller.annotationGraphics(dim);
  const update = (d: DrawingDimension) => {
    const err = controller.updateAnnotation(d);
    return !err;
  };
  return (
    <Section title="Dimension">
      <p className="drawing-hint" data-testid="drawing-dimension-value">
        {dimensionLabels[dim.type]} ·{' '}
        {g.status === 'ok' && g.value !== undefined
          ? `${drawingDimensionValue(g.value)}${dim.type === 'angle' ? '°' : ' mm'}${g.projected ? '（投影）' : ''}`
          : statusText[g.status]}
      </p>
      <Field
        readOnly={locked}
        label="Dimension text (empty: the measured value)"
        value={dim.text}
        onCommit={(text) => update({ ...dim, text })}
      />
      <Field
        readOnly={locked}
        label="Tolerance"
        value={dim.tolerance}
        onCommit={(tolerance) => update({ ...dim, tolerance })}
      />
      <Choice
        label="Fit (はめあい)"
        value={drawingFitPattern.test(dim.tolerance) ? dim.tolerance : ''}
        disabled={locked}
        options={[
          { value: '', label: drawingFitPattern.test(dim.tolerance) ? 'なし None' : '—' },
          ...commonFits.map((f) => ({ value: f, label: f })),
        ]}
        onChange={(v) => settle(() => void update({ ...dim, tolerance: v }))}
      />
      <Choice
        label="Text height (mm)"
        value={dim.heightMm}
        options={drawingTextHeights}
        disabled={locked}
        onChange={(v) =>
          settle(() =>
            controller.updateAnnotation({ ...dim, heightMm: Number(v) as DrawingTextHeight }),
          )
        }
      />
    </Section>
  );
}

const symbolStatusText: Record<string, string> = {
  pending: '描画待ち',
  unresolved: '未解決',
  ambiguous: '曖昧',
  'datum-missing': 'データムがありません',
};

function SymbolStatus({ controller, sym }: { controller: DrawingController; sym: DrawingSymbol }) {
  const g = controller.annotationGraphics(sym);
  return g.status === 'ok' ? null : <small> {symbolStatusText[g.status] ?? g.status}</small>;
}

/** Common fits and tolerance classes (JIS B 0401), offered after a size. */
const commonFits = [
  'H7/g6',
  'H7/h6',
  'H7/js6',
  'H7/k6',
  'H7/m6',
  'H7/n6',
  'H7/p6',
  'H8/f7',
  'H8/e8',
  'H9/d9',
  'H7',
  'h6',
  'g6',
];

function SymbolPanel({
  sym,
  controller,
  locked,
}: {
  sym: DrawingSymbol;
  controller: DrawingController;
  locked: boolean;
}) {
  const settle = useSettle();
  const g = controller.annotationGraphics(sym);
  const spec = sym.symbol;
  const set = (next: DrawingSymbolSpec) =>
    !controller.updateAnnotation({ ...sym, symbol: next }, 'Edit symbol');
  const now = (next: DrawingSymbolSpec) => settle(() => void set(next));
  const check = (label: string, value: boolean, change: (v: boolean) => void) => (
    <label className="ep-field drawing-check">
      <input
        type="checkbox"
        checked={value}
        disabled={locked}
        onChange={(e) => change(e.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <Section title={symbolLabels[spec.type]}>
      {g.status !== 'ok' && (
        <p className="drawing-notice" data-testid="drawing-symbol-status">
          {symbolStatusText[g.status] ?? g.status}
        </p>
      )}
      {spec.type === 'gdt' && (
        <>
          <Choice
            label="Characteristic"
            value={spec.characteristic}
            disabled={locked}
            options={drawingGdtCharacteristics.map((c) => ({ value: c, label: gdtLabels[c] }))}
            onChange={(v) => {
              const characteristic = v as (typeof drawingGdtCharacteristics)[number];
              const form = ['straightness', 'flatness', 'circularity', 'cylindricity'].includes(
                characteristic,
              );
              // A form takes no datum; one that needs a datum and has none takes the drawing's
              // first datum (or A, shown as missing until a datum A is drawn).
              const first = controller.state.content.annotations.find(
                (x) => x.kind === 'symbol' && x.symbol.type === 'datum',
              );
              const letter =
                first?.kind === 'symbol' && first.symbol.type === 'datum'
                  ? first.symbol.letter
                  : 'A';
              const datums = form
                ? []
                : spec.datums.length || !drawingGdtNeedsDatum.includes(characteristic)
                  ? spec.datums
                  : [letter];
              now({ ...spec, characteristic, datums });
            }}
          />
          <Field
            readOnly={locked}
            label="Tolerance value"
            value={spec.tolerance}
            onCommit={(tolerance) => set({ ...spec, tolerance })}
          />
          {check('Ø Cylindrical zone', spec.diameter, (diameter) => now({ ...spec, diameter }))}
          <Choice
            label="Material condition"
            value={spec.modifier}
            disabled={locked}
            options={[
              { value: '', label: 'なし None' },
              { value: 'M', label: 'Ⓜ 最大実体 MMC' },
              { value: 'L', label: 'Ⓛ 最小実体 LMC' },
            ]}
            onChange={(v) => now({ ...spec, modifier: v as '' | 'M' | 'L' })}
          />
          <Field
            readOnly={locked}
            label="Datums (A B C)"
            value={spec.datums.join(' ')}
            onCommit={(text) =>
              set({
                ...spec,
                datums: text
                  .toUpperCase()
                  .split(/[\s,|]+/)
                  .filter(Boolean),
              })
            }
          />
        </>
      )}
      {spec.type === 'datum' && (
        <Field
          readOnly={locked}
          label="Datum letter"
          value={spec.letter}
          onCommit={(letter) => set({ ...spec, letter: letter.trim().toUpperCase() })}
        />
      )}
      {spec.type === 'surface' && (
        <>
          <Choice
            label="Process"
            value={spec.process}
            disabled={locked}
            options={[
              { value: 'removal', label: '除去加工 Material removed' },
              { value: 'no-removal', label: '除去加工しない Not removed' },
              { value: 'any', label: '指定なし Any process' },
            ]}
            onChange={(v) => now({ ...spec, process: v as 'any' | 'removal' | 'no-removal' })}
          />
          <Field
            readOnly={locked}
            label="Surface requirement"
            value={spec.text}
            onCommit={(text) => set({ ...spec, text })}
          />
        </>
      )}
      {spec.type === 'weld' && (
        <>
          <Choice
            label="Weld type"
            value={spec.weld}
            disabled={locked}
            options={drawingWeldTypes.map((w) => ({ value: w, label: weldLabels[w] }))}
            onChange={(v) => now({ ...spec, weld: v as (typeof drawingWeldTypes)[number] })}
          />
          <Choice
            label="Weld side"
            value={spec.side}
            disabled={locked}
            options={[
              { value: 'arrow', label: '矢の側 Arrow side' },
              { value: 'other', label: '反対側 Other side' },
              { value: 'both', label: '両側 Both sides' },
            ]}
            onChange={(v) => now({ ...spec, side: v as 'arrow' | 'other' | 'both' })}
          />
          <Field
            readOnly={locked}
            label="Weld size"
            value={spec.size}
            onCommit={(size) => set({ ...spec, size })}
          />
          <Field
            readOnly={locked}
            label="Weld length"
            value={spec.length}
            onCommit={(length) => set({ ...spec, length })}
          />
          {check('全周 All around', spec.allAround, (allAround) => now({ ...spec, allAround }))}
          {check('現場溶接 Field weld', spec.field, (field) => now({ ...spec, field }))}
        </>
      )}
      <Choice
        label="Text height (mm)"
        value={sym.heightMm}
        options={drawingTextHeights}
        disabled={locked}
        onChange={(v) =>
          settle(() =>
            controller.updateAnnotation({ ...sym, heightMm: Number(v) as DrawingTextHeight }),
          )
        }
      />
    </Section>
  );
}
