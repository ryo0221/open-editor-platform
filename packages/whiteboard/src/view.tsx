import { assertReferenceItems } from '@editor-platform/artifact-references';
import {
  ReferenceWarnings,
  useReferenceItems,
  type ReferenceSurfaceProps,
} from '@editor-platform/artifact-references/react';
import { useRef, useState, useMemo, useEffect, type RefObject } from 'react';
import { Scan } from 'lucide-react';
import {
  command,
  unionBounds,
  type EditorCommand,
  type Bounds,
  type Point,
  type Region,
  type TransformDelta,
} from '@editor-platform/editor-core';
import { EditorLayout, IconButton, type EditorLayoutProps } from '@editor-platform/editor-ui';
import {
  CanvasStage,
  CanvasControls,
  readImage,
  type CanvasView,
} from '@editor-platform/canvas-ui';
import {
  arrangeBoard,
  copyBoard,
  makeWhiteboardNode,
  patchNodes,
  pasteBoard,
  whiteboardPaintOrder,
  type WhiteboardConnector,
  type WhiteboardContent,
  type WhiteboardNode,
  type WhiteboardNodeKind,
  type WhiteboardSection,
} from './model';
import {
  migrateWhiteboard,
  createSection,
  encloseInSection,
  updateSection,
  dissolveSection,
  boardPreview,
  transformBoardCommand,
  boardBounds,
  sectionAt,
} from './sections';
import { boardNodeTarget, boardSectionTarget, renderBoardTarget } from './canvas-targets';
import { useSavedView } from './board-camera';
import { useBoardOutput } from './board-output';
import { BoardNavigator } from './board-navigator';
import { BoardInspector } from './board-inspector';
import { BoardToolbar } from './board-toolbar';
import { BoardConnectorLayer, useEndpointDrag } from './board-connectors';
import { freeBounds } from './placement';
export interface WhiteboardSurfaceProps extends ReferenceSurfaceProps {
  content: WhiteboardContent;
  execute: (command: EditorCommand<WhiteboardContent>) => void | boolean;
  select: (ids: string[], region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
}
type Apply = (cmd: EditorCommand<WhiteboardContent>) => boolean;

function sectionAction(apply: Apply, section: WhiteboardSection, a: string) {
  if (a === 'delete') return apply(dissolveSection(section.id));
  if (a === 'lock' || a === 'unlock')
    return apply(updateSection(section.id, { locked: a === 'lock' }));
  throw new Error('Use Section actions for this region; grouping and scaling apply to objects.');
}
/** Centers a new node in the viewport, clear of other nodes, unless the caller placed it. */
function placedNode(
  content: WhiteboardContent,
  kind: WhiteboardNodeKind,
  patch: Partial<WhiteboardNode>,
  view: CanvasView,
  rect: DOMRect | undefined,
) {
  const node = { ...makeWhiteboardNode(kind, content.nodes.length), ...patch };
  if (!patch.bounds) {
    const x = rect ? (rect.width / 2 - view.pan.x) / view.zoom : 500,
      y = rect ? (rect.height / 2 - view.pan.y) / view.zoom : 310;
    node.bounds = freeBounds(content, {
      ...node.bounds,
      x: x - node.bounds.width / 2,
      y: y - node.bounds.height / 2,
    });
  }
  node.sectionId = sectionAt(content, node.bounds)?.id;
  return node;
}
function fittedView(
  view: CanvasView,
  box: ReturnType<typeof boardBounds>,
  rect: DOMRect,
  all: boolean,
) {
  const zoom = Math.max(
    0.001,
    Math.min(3, (rect.width - 80) / box.width, (rect.height - 80) / box.height),
  );
  return {
    ...view,
    fit: all,
    zoom,
    pan: {
      x: (rect.width - box.width * zoom) / 2 - box.x * zoom,
      y: (rect.height - box.height * zoom) / 2 - box.y * zoom,
    },
  };
}
function freehandNode(points: Point[]): Partial<WhiteboardNode> {
  const box = unionBounds(points.map((p) => ({ ...p, width: 1, height: 1 })));
  return {
    bounds: box,
    text: '',
    color: '#253044',
    points: points.map((p) => ({
      x: (p.x - box.x) / box.width,
      y: (p.y - box.y) / box.height,
    })),
  };
}

/** Migrates the input and validates reference items on every application. */
function checkedCommand(cmd: EditorCommand<WhiteboardContent>): EditorCommand<WhiteboardContent> {
  return {
    ...cmd,
    apply(current) {
      const next = cmd.apply(migrateWhiteboard(current));
      assertReferenceItems(next.nodes);
      return next;
    },
  };
}
/** Image node patch, at most 400px wide and centered on the drop position when given. */
async function imageNode(file: File, position?: Point): Promise<Partial<WhiteboardNode>> {
  const src = await readImage(file),
    image = new Image();
  image.src = src;
  await image.decode();
  const width = Math.min(400, image.width),
    height = (width * image.height) / image.width;
  return {
    src,
    alt: file.name,
    text: '',
    ...(position
      ? { bounds: { x: position.x - width / 2, y: position.y - height / 2, width, height } }
      : {}),
  };
}
interface BoardActionContext {
  content: WhiteboardContent;
  ids: string[];
  connector?: WhiteboardConnector;
  selectedSection?: WhiteboardSection;
  clipboard: RefObject<WhiteboardContent | undefined>;
  apply: Apply;
  applySection: (cmd: EditorCommand<WhiteboardContent>) => void;
  setConnectorId: (id: string) => void;
}
/** Menu, shortcut and canvas actions; throws a user-facing message when not applicable. */
function boardAction(context: BoardActionContext, a: string, value?: number) {
  const { content, ids, connector, selectedSection, clipboard, apply } = context;
  if (selectedSection) return sectionAction(apply, selectedSection, a);
  if (a === 'delete' && connector) {
    apply(
      command('whiteboard.delete-connector', 'Delete connector', (d) => ({
        ...d,
        connectors: d.connectors.filter((c) => c.id !== connector.id),
      })),
    );
    return context.setConnectorId('');
  }
  if (a === 'frame') return context.applySection(encloseInSection(content, ids));
  if (a === 'duplicate') return apply(pasteBoard(copyBoard(content, ids)));
  if (a === 'copy' || a === 'cut') {
    // Copy pastes offset once; cut pastes back in place.
    clipboard.current = copyBoard(content, ids, a === 'cut' ? 0 : 20);
    if (a === 'cut') apply(arrangeBoard(ids, 'delete'));
    return;
  }
  if (a === 'paste') {
    if (!clipboard.current) throw new Error('Copy board content first');
    return apply(pasteBoard(clipboard.current));
  }
  apply(arrangeBoard(ids, a, value));
}

/** Migrated content with the lookups every board panel and the stage share. */
function useBoardContent(
  source: WhiteboardContent,
  references: ReferenceSurfaceProps['references'],
) {
  const content = useMemo(() => migrateWhiteboard(source), [source]);
  const projectedNodes = useReferenceItems(content.nodes, references);
  const projectedById = new Map(projectedNodes.map((n) => [n.id, n]));
  const nodes = useMemo(
    () => new Map(content.nodes.map((node, index) => [node.id, { node, index }])),
    [content],
  );
  const contentBounds = useMemo(() => boardBounds(content), [content]);
  const paintOrder = useMemo(() => whiteboardPaintOrder(content), [content]);
  return { content, projectedById, nodes, contentBounds, paintOrder };
}
/** Object/Section selection and the separately selected connector. */
function useBoardSelection(
  content: WhiteboardContent,
  select: WhiteboardSurfaceProps['select'],
  focusReferenceId: string | undefined,
) {
  const [selected, setSelected] = useState<string[]>([]),
    [connectorId, setConnectorId] = useState('');
  const ids = selected.filter(
      (id) =>
        content.nodes.some((n) => n.id === id) || (content.sections ?? []).some((s) => s.id === id),
    ),
    chosen = content.nodes.filter((n) => ids.includes(n.id)),
    connector = content.connectors.find((c) => c.id === connectorId),
    selectedSection = ids.length === 1 ? content.sections?.find((s) => s.id === ids[0]) : undefined;
  useEffect(() => {
    if (focusReferenceId) setSelected([focusReferenceId]);
  }, [focusReferenceId]);
  const choose = (ids: string[]) => {
    setSelected(ids);
    setConnectorId('');
    select(ids);
  };
  const chooseConnector = (id: string) => {
    setConnectorId(id);
    setSelected([]);
    select([id]);
  };
  return {
    ids,
    chosen,
    connector,
    selectedSection,
    connectorId,
    setConnectorId,
    choose,
    chooseConnector,
  };
}
export function WhiteboardSurface({
  references,
  focusReferenceId,
  content: source,
  execute,
  select,
  readOnly = false,
  layout,
}: WhiteboardSurfaceProps) {
  const board = useBoardContent(source, references);
  const { content, nodes, contentBounds, paintOrder } = board;
  const selection = useBoardSelection(content, select, focusReferenceId);
  const { ids, chosen, connector, selectedSection, choose, chooseConnector } = selection;
  const [sectionTool, setSectionTool] = useState(false);
  const [view, setView] = useSavedView(layout?.viewKey),
    [pen, setPen] = useState(false),
    [error, setError] = useState(''),
    [reference, setReference] = useState('selection'),
    [editText, setEditText] = useState<{ id: string }>();
  const drag = useEndpointDrag();
  const clipboard = useRef<WhiteboardContent | undefined>(undefined),
    viewport = useRef<HTMLDivElement>(null);
  const output = useBoardOutput({ content, ids, selectedSection, references }, setError);
  const apply: Apply = (cmd) => {
    if (readOnly) return false;
    const checked = checkedCommand(cmd);
    try {
      if (!checked.readonlyInput) checked.apply(content);
      if (execute(checked) === false) return false;
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  /** Applies a Section-creating command and selects the new Section. */
  const applySection = (cmd: EditorCommand<WhiteboardContent>) => {
    const next = cmd.apply(content);
    apply(cmd);
    choose([next.sections!.at(-1)!.id]);
  };
  function add(kind: WhiteboardNodeKind, patch: Partial<WhiteboardNode> = {}) {
    const node = placedNode(content, kind, patch, view, viewport.current?.getBoundingClientRect());
    apply(
      command('whiteboard.insert', `Insert ${kind}`, (d) => ({ ...d, nodes: [...d.nodes, node] })),
    );
    choose([node.id]);
    // A new sticky opens for typing right away; Escape keeps its first text.
    if (kind === 'sticky') setEditText({ id: node.id });
  }
  async function image(file: File, position?: Point) {
    try {
      add('image', await imageNode(file, position));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function action(a: string, value?: number) {
    if (a === 'cancel') {
      setSectionTool(false);
      setPen(false);
      return;
    }
    const context = { content, ids, connector, selectedSection, clipboard, apply, applySection };
    try {
      boardAction({ ...context, setConnectorId: selection.setConnectorId }, a, value);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function fit(nextIds?: string[]) {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    setView(fittedView(view, boardBounds(content, nextIds), rect, !nextIds?.length));
  }
  const shared = { content, ids, readOnly, references, view, setView, viewport, apply, setError };
  const connectorLayer = {
    ...drag,
    content,
    paintOrder,
    zoom: view.zoom,
    connectorId: selection.connectorId,
    readOnly,
    chooseConnector,
    apply,
  };
  return (
    <EditorLayout
      viewKey="whiteboard"
      leftLabel="Board navigator"
      inspectorLabel="Board inspector"
      toolbar={
        <BoardToolbar
          {...shared}
          {...{ chosen, sectionTool, setSectionTool, pen, setPen, reference, setReference }}
          {...{ add, action, fit }}
          image={(file) => void image(file)}
          output={(format, scope) => void output(format, scope)}
        />
      }
      left={
        <BoardNavigator
          {...shared}
          {...{ paintOrder, contentBounds, choose, chooseConnector, fit }}
          connectorId={selection.connectorId}
        />
      }
      inspector={
        <BoardInspector
          {...shared}
          {...{ nodes, chosen, connector, selectedSection }}
          onDeleteConnector={() => action('delete')}
          onExportSection={() => void output('svg', 'section')}
        />
      }
      status={<BoardStatus {...{ content, ids, view, setView, fit }} />}
      {...layout}
    >
      <div ref={viewport} style={{ height: '100%' }}>
        <ReferenceWarnings items={content.nodes} resolver={references} />
        {error && (
          <div className="surface-error" role="alert">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        <CanvasStage
          {...boardStageProps({ ...shared, ...board })}
          onSelect={choose}
          onDelete={() => action('delete')}
          onAction={action}
          onImage={(f, position) => void image(f, position)}
          insertion={sectionTool}
          onInsert={(bounds) => {
            applySection(createSection(bounds, `Section ${(content.sections?.length ?? 0) + 1}`));
            setSectionTool(false);
          }}
          editText={editText}
          freehand={pen}
          onFreehand={(points) => {
            add('freehand', freehandNode(points));
            setPen(false);
          }}
          underlay={(targets) => <BoardConnectorLayer {...connectorLayer} projected={targets} />}
          overlay={(targets) => (
            <BoardConnectorLayer {...connectorLayer} projected={targets} handlesOnly />
          )}
        />
      </div>
    </EditorLayout>
  );
}

function BoardStatus({
  content,
  ids,
  view,
  setView,
  fit,
}: {
  content: WhiteboardContent;
  ids: string[];
  view: CanvasView;
  setView: (view: CanvasView) => void;
  fit: (ids?: string[]) => void;
}) {
  return (
    <>
      <span className="ep-status-summary">
        {content.nodes.length} nodes · {content.sections?.length ?? 0} Sections ·{' '}
        {content.connectors.length} connections
      </span>
      <IconButton
        icon={Scan}
        label="Fit selection"
        disabled={!ids.length}
        onClick={() => fit(ids)}
      />
      <span className="ep-spacer" />
      <CanvasControls
        view={view}
        onChange={setView}
        onFit={() => fit()}
        fitLabel="Fit board"
        minZoom={0.001}
      />
    </>
  );
}
/** Stage configuration derived from the board: camera, targets, transforms and text edits. */
function boardStageProps({
  content,
  ids,
  readOnly,
  view,
  setView,
  apply,
  nodes,
  paintOrder,
  contentBounds,
  projectedById,
}: {
  content: WhiteboardContent;
  ids: string[];
  readOnly: boolean;
  view: CanvasView;
  setView: (view: CanvasView) => void;
  apply: Apply;
  nodes: Map<string, { node: WhiteboardNode; index: number }>;
  paintOrder: WhiteboardNode[];
  contentBounds: Bounds;
  projectedById: Map<string, WhiteboardNode>;
}) {
  return {
    label: 'Whiteboard canvas',
    hideControls: true,
    space: 'infinite' as const,
    fitBounds: contentBounds,
    background: '#fafbfe',
    view,
    onViewChange: setView,
    selected: ids,
    readOnly,
    targets: [
      ...(content.sections ?? []).map((s) => boardSectionTarget(s, view.zoom)),
      ...paintOrder.map((n) => {
        const src = (projectedById.get(n.id) ?? n).src;
        return boardNodeTarget(src === n.src ? n : { ...n, src }, nodes.get(n.id)!.index);
      }),
    ],
    previewTransform: (ids: string[], delta: TransformDelta) => boardPreview(content, ids, delta),
    onTransform: (ids: string[], delta: TransformDelta) => apply(transformBoardCommand(ids, delta)),
    onEditText: (id: string, text: string, runs?: WhiteboardNode['runs']) =>
      apply(patchNodes([id], { text, runs })),
    render: renderBoardTarget,
  };
}
