import { useContext } from 'react';
import { EditorExportGuardContext } from '@editor-platform/editor-ui';
import { useRef, useState, useMemo, useEffect } from 'react';
import { StickyNote, Frame, Pen, ArrowUpRight, Scan, Download, Layers } from 'lucide-react';
import {
  command,
  unionBounds,
  descendantIds,
  type Bounds,
  type EditorCommand,
  type Point,
  type Region,
  type ShapeKind,
} from '@editor-platform/editor-core';
import {
  EditorLayout,
  IconButton,
  Menu,
  Section,
  CommitInput,
  type EditorLayoutProps,
} from '@editor-platform/editor-ui';
import {
  CanvasStage,
  CanvasControls,
  initialCanvasView,
  InsertTools,
  ArrangeMenu,
  EditMenu,
  VisualInspector,
  LayerNavigator,
  exportPages,
  readImage,
  type CanvasView,
  type CanvasTarget,
} from '@editor-platform/canvas-ui';
import {
  alignNodes,
  arrangeBoard,
  connectNodes,
  connectorProjector,
  connectorPath,
  copyBoard,
  makeWhiteboardNode,
  patchNodes,
  pasteBoard,
  updateConnector,
  whiteboardDrawing,
  whiteboardPaintOrder,
  type WhiteboardContent,
  type WhiteboardConnector,
  type WhiteboardNode,
  type WhiteboardNodeKind,
} from './model';
import {
  migrateWhiteboard,
  createSection,
  encloseInSection,
  updateSection,
  dissolveSection,
  assignSection,
  boardPreview,
  transformBoardCommand,
  boardBounds,
  sectionMembers,
  sectionAt,
  nodeSection,
} from './sections';
import { exportBoardSvg } from './export';
import { WhiteboardPortsEditor } from './ports';
import { boardNodeTarget, boardSectionTarget, renderBoardTarget } from './canvas-targets';
export interface WhiteboardSurfaceProps {
  content: WhiteboardContent;
  execute: (command: EditorCommand<WhiteboardContent>) => void | boolean;
  select: (ids: string[], region?: Region) => void;
  readOnly?: boolean;
  layout?: Partial<EditorLayoutProps>;
}
export function WhiteboardSurface({
  content: source,
  execute,
  select,
  readOnly = false,
  layout,
}: WhiteboardSurfaceProps) {
  const guardExport = useContext(EditorExportGuardContext);
  const content = useMemo(() => migrateWhiteboard(source), [source]);
  const nodes = useMemo(
    () => new Map(content.nodes.map((node, index) => [node.id, { node, index }])),
    [content],
  );
  const contentBounds = useMemo(() => boardBounds(content), [content]);
  const paintOrder = useMemo(() => whiteboardPaintOrder(content), [content]);
  const [sectionTool, setSectionTool] = useState(false);
  const [selected, setSelected] = useState<string[]>([]),
    [connectorId, setConnectorId] = useState(''),
    [view, setView] = useState<CanvasView>(() => {
      try {
        const saved = JSON.parse(
          localStorage.getItem(`ep-camera:${layout?.viewKey ?? 'whiteboard'}`) ?? 'null',
        );
        if (
          saved &&
          Number.isFinite(saved.pan?.x) &&
          Number.isFinite(saved.pan?.y) &&
          saved.zoom >= 0.001 &&
          saved.zoom <= 8
        )
          return { ...initialCanvasView, ...saved };
      } catch {
        /* view preference only */
      }
      return { ...initialCanvasView, fit: false };
    }),
    [pen, setPen] = useState(false),
    [error, setError] = useState(''),
    [reference, setReference] = useState('selection'),
    [endpoint, setEndpoint] = useState<{ side: 'from' | 'to'; point: Point }>();
  const endpointPointer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        endpointPointer.current = undefined;
        setEndpoint(undefined);
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`ep-camera:${layout?.viewKey ?? 'whiteboard'}`, JSON.stringify(view));
    } catch {
      /* view preference only */
    }
  }, [view, layout?.viewKey]);
  const clipboard = useRef<WhiteboardContent | undefined>(undefined),
    viewport = useRef<HTMLDivElement>(null);
  const ids = selected.filter(
      (id) =>
        content.nodes.some((n) => n.id === id) || (content.sections ?? []).some((s) => s.id === id),
    ),
    chosen = content.nodes.filter((n) => ids.includes(n.id)),
    connector = content.connectors.find((c) => c.id === connectorId),
    selectedSection = ids.length === 1 ? content.sections?.find((s) => s.id === ids[0]) : undefined;
  const exportState = useRef({ content, ids, selectedSection });
  exportState.current = { content, ids, selectedSection };
  const apply = (cmd: EditorCommand<WhiteboardContent>) => {
    if (readOnly) return false;
    try {
      if (!cmd.readonlyInput) cmd.apply(content);
      if (execute({ ...cmd, apply: (current) => cmd.apply(migrateWhiteboard(current)) }) === false)
        return false;
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const choose = (ids: string[]) => {
    setSelected(ids);
    setConnectorId('');
    select(ids);
  };
  function add(kind: WhiteboardNodeKind, patch: Partial<WhiteboardNode> = {}) {
    const rect = viewport.current?.getBoundingClientRect(),
      node = { ...makeWhiteboardNode(kind, content.nodes.length), ...patch };
    if (!patch.bounds) {
      const x = rect ? (rect.width / 2 - view.pan.x) / view.zoom : 500,
        y = rect ? (rect.height / 2 - view.pan.y) / view.zoom : 310;
      node.bounds = { ...node.bounds, x: x - node.bounds.width / 2, y: y - node.bounds.height / 2 };
    }
    node.sectionId = sectionAt(content, node.bounds)?.id;
    apply(
      command('whiteboard.insert', `Insert ${kind}`, (d) => ({ ...d, nodes: [...d.nodes, node] })),
    );
    choose([node.id]);
  }
  async function image(file: File, position?: Point) {
    try {
      const src = await readImage(file),
        image = new Image();
      image.src = src;
      await image.decode();
      const width = Math.min(400, image.width),
        height = (width * image.height) / image.width;
      add('image', {
        src,
        alt: file.name,
        text: '',
        ...(position
          ? { bounds: { x: position.x - width / 2, y: position.y - height / 2, width, height } }
          : {}),
      });
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
    if (selectedSection) {
      if (a === 'delete') apply(dissolveSection(selectedSection.id));
      else if (a === 'lock' || a === 'unlock')
        apply(updateSection(selectedSection.id, { locked: a === 'lock' }));
      else setError('Use Section actions for this region; grouping and scaling apply to objects.');
      return;
    }
    if (a === 'frame') {
      try {
        const cmd = encloseInSection(content, ids);
        const next = cmd.apply(content);
        apply(cmd);
        choose([next.sections!.at(-1)!.id]);
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    if (a === 'duplicate') {
      apply(pasteBoard(copyBoard(content, ids)));
      return;
    }
    if (a === 'delete' && connector) {
      apply(
        command('whiteboard.delete-connector', 'Delete connector', (d) => ({
          ...d,
          connectors: d.connectors.filter((c) => c.id !== connector.id),
        })),
      );
      setConnectorId('');
      return;
    }
    if (a === 'copy' || a === 'cut') {
      clipboard.current = copyBoard(content, ids);
      if (a === 'cut') apply(arrangeBoard(ids, 'delete'));
      return;
    }
    if (a === 'paste') {
      if (clipboard.current) apply(pasteBoard(clipboard.current));
      else setError('Copy board content first');
      return;
    }
    apply(arrangeBoard(ids, a, value));
  }
  function geometry(patch: Partial<Bounds>) {
    const box = unionBounds(chosen.map((n) => n.bounds));
    apply(
      transformBoardCommand(ids, {
        dx: patch.x === undefined ? 0 : patch.x - box.x,
        dy: patch.y === undefined ? 0 : patch.y - box.y,
        dw: patch.width === undefined ? 0 : patch.width - box.width,
        dh: patch.height === undefined ? 0 : patch.height - box.height,
      }),
    );
  }
  function fit(nextIds?: string[]) {
    const box = boardBounds(content, nextIds),
      rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(
      0.001,
      Math.min(3, (rect.width - 80) / box.width, (rect.height - 80) / box.height),
    );
    setView({
      ...view,
      fit: !nextIds?.length,
      zoom,
      pan: {
        x: (rect.width - box.width * zoom) / 2 - box.x * zoom,
        y: (rect.height - box.height * zoom) / 2 - box.y * zoom,
      },
    });
  }
  async function output(format: 'svg' | 'png', scope: string) {
    try {
      guardExport?.();
      const { content, ids, selectedSection } = exportState.current;
      const exportIds =
        scope === 'all'
          ? undefined
          : scope === 'section'
            ? ids.filter((id) => content.sections?.some((s) => s.id === id))
            : ids;
      if (exportIds && !exportIds.length) throw new Error('Select objects or a Section first');
      const box = boardBounds(content, exportIds);
      if (format === 'png' && (box.width + 60) * (box.height + 60) > 32_000_000)
        throw new Error('This board is too large for a full-size PNG. Export a Section or SVG.');
      await exportPages(
        [
          {
            name: scope === 'section' ? (selectedSection?.title ?? 'section') : 'whiteboard',
            svg: exportBoardSvg(content, exportIds),
            width: box.width + 60,
            height: box.height + 60,
          },
        ],
        format,
        1,
        'whiteboard',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const reparent = (id: string, parentId?: string) => {
    const all = descendantIds(
      content.nodes.map((n) => ({ ...n, parentId: n.groupId })),
      [id],
    );
    if (
      parentId &&
      (all.has(parentId) || !content.nodes.some((n) => n.id === parentId && n.kind === 'group'))
    ) {
      setError('Choose a Group outside this subtree');
      return;
    }
    apply(patchNodes([id], { groupId: parentId }));
  };
  const left = (
    <>
      <LayerNavigator
        entries={content.nodes.map((n, i) => ({
          id: n.id,
          parentId: n.groupId,
          name:
            n.name ||
            (!['group', 'frame', 'image', 'freehand'].includes(n.kind) &&
              n.text?.replace(/\s+/g, ' ').trim().slice(0, 64)) ||
            `${n.kind} ${i + 1}`,
          text: ['group', 'frame', 'image', 'freehand'].includes(n.kind) ? undefined : n.text,
          type: n.kind,
          hidden: n.hidden,
          locked: n.locked,
        }))}
        selected={ids}
        onSelect={choose}
        onReveal={(id) => fit([id])}
        onRename={(id, name) => apply(patchNodes([id], { name }))}
        onState={(id, patch) => apply(patchNodes([id], patch))}
        onReparent={reparent}
        onReorder={(id, delta) => apply(arrangeBoard([id], delta < 0 ? 'backward' : 'forward'))}
        readOnly={readOnly}
      />
      <Section title="Sections">
        {(content.sections ?? []).map((section) => (
          <button
            key={section.id}
            aria-label={`Go to Section ${section.title}`}
            onClick={() => {
              choose([section.id]);
              fit([section.id]);
            }}
          >
            {section.title} · {sectionMembers(content, section.id).length}
          </button>
        ))}
        <p className="hint">Sections organize objects. Resize changes the region only.</p>
      </Section>
      <Section title="Overview">
        <svg
          role="img"
          aria-label="Board overview"
          viewBox={`${contentBounds.x - 40} ${contentBounds.y - 40} ${contentBounds.width + 80} ${contentBounds.height + 80}`}
          style={{ width: '100%', height: 120, background: '#f5f7fc', cursor: 'crosshair' }}
          onClick={(e) => {
            const rect = viewport.current?.getBoundingClientRect(),
              matrix = e.currentTarget.getScreenCTM();
            if (!rect || !matrix) return;
            const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
            setView({
              ...view,
              fit: false,
              pan: {
                x: rect.width / 2 - point.x * view.zoom,
                y: rect.height / 2 - point.y * view.zoom,
              },
            });
          }}
        >
          {(content.sections ?? []).map((section) => (
            <rect
              key={section.id}
              {...section.bounds}
              fill={section.background}
              stroke="#8c9dc2"
              strokeWidth={Math.max(1, contentBounds.width / 350)}
            />
          ))}
          {paintOrder
            .filter((n) => n.kind !== 'group' && !n.hidden)
            .map((n) => (
              <rect key={n.id} {...n.bounds} fill={n.color} />
            ))}
          <rect
            x={-view.pan.x / view.zoom}
            y={-view.pan.y / view.zoom}
            width={(viewport.current?.clientWidth ?? 900) / view.zoom}
            height={(viewport.current?.clientHeight ?? 600) / view.zoom}
            fill="none"
            stroke="#5269c8"
            strokeWidth={Math.max(1, contentBounds.width / 250)}
          />
        </svg>
      </Section>
      <Section title="Connections">
        {content.connectors.map((c, i) => (
          <button
            key={c.id}
            aria-pressed={c.id === connectorId}
            onClick={() => {
              setConnectorId(c.id);
              setSelected([]);
              select([c.id]);
            }}
          >
            {c.label || `Connection ${i + 1}`}
          </button>
        ))}
      </Section>
    </>
  );
  const inspector = (
    <fieldset disabled={readOnly} className="inspector-fields">
      {selectedSection ? (
        <Section title="Section">
          <CommitInput
            label="Section title"
            value={selectedSection.title}
            onCommit={(title) => apply(updateSection(selectedSection.id, { title }))}
          />
          <label className="ep-field">
            Section background
            <input
              type="color"
              aria-label="Section background"
              value={selectedSection.background}
              onChange={(e) =>
                apply(updateSection(selectedSection.id, { background: e.target.value }))
              }
            />
          </label>
          {(['x', 'y', 'width', 'height'] as const).map((key) => (
            <CommitInput
              key={key}
              label={`Section ${key}`}
              value={selectedSection.bounds[key]}
              type="number"
              min={key === 'width' || key === 'height' ? 40 : undefined}
              onCommit={(v) =>
                apply(
                  transformBoardCommand([selectedSection.id], {
                    dx: key === 'x' ? Number(v) - selectedSection.bounds.x : 0,
                    dy: key === 'y' ? Number(v) - selectedSection.bounds.y : 0,
                    dw: key === 'width' ? Number(v) - selectedSection.bounds.width : 0,
                    dh: key === 'height' ? Number(v) - selectedSection.bounds.height : 0,
                  }),
                )
              }
            />
          ))}
          <p>{sectionMembers(content, selectedSection.id).length} members · no clipping</p>
          <button onClick={() => apply(dissolveSection(selectedSection.id))}>
            Dissolve Section
          </button>
          <button onClick={() => apply(dissolveSection(selectedSection.id, true))}>
            Delete Section and contents
          </button>
          <button onClick={() => void output('svg', 'section')}>Export Section SVG</button>
        </Section>
      ) : connector ? (
        <>
          <Section title="Connector">
            <CommitInput
              label="Connector label"
              value={connector.label}
              onCommit={(label) => apply(updateConnector(connector.id, { label }))}
            />
            <label className="ep-field">
              Routing
              <select
                aria-label="Connector routing"
                value={connector.routing ?? 'straight'}
                onChange={(e) =>
                  apply(
                    updateConnector(connector.id, {
                      routing: e.target.value as WhiteboardConnector['routing'],
                    }),
                  )
                }
              >
                {['straight', 'elbow', 'curve'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <CommitInput
              label="Connector stroke"
              value={connector.stroke ?? '#637187'}
              onCommit={(stroke) => apply(updateConnector(connector.id, { stroke }))}
            />
            <CommitInput
              label="Connector width (px)"
              type="number"
              min={1}
              value={connector.strokeWidth ?? 2}
              onCommit={(v) => apply(updateConnector(connector.id, { strokeWidth: Number(v) }))}
            />
            <label className="ep-field">
              Arrowheads
              <select
                aria-label="Connector arrowheads"
                value={connector.arrowhead ?? 'end'}
                onChange={(e) =>
                  apply(
                    updateConnector(connector.id, {
                      arrowhead: e.target.value as WhiteboardConnector['arrowhead'],
                    }),
                  )
                }
              >
                {['none', 'end', 'both'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            {(['from', 'to'] as const).map((side) => (
              <div key={side}>
                <label className="ep-field">
                  {side} node
                  <select
                    aria-label={`${side} node`}
                    value={connector[side]}
                    onChange={(e) =>
                      apply(
                        updateConnector(connector.id, {
                          [side]: e.target.value,
                          [`${side}Port`]: 'auto',
                          [`${side}Point`]: { x: 0, y: 0 },
                        }),
                      )
                    }
                  >
                    <option value="">Free endpoint</option>
                    {content.nodes
                      .filter((n) => n.kind !== 'freehand')
                      .map((n, i) => (
                        <option key={n.id} value={n.id}>
                          {n.name || `${n.kind} ${i + 1}`}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="ep-field">
                  {side} port
                  <select
                    aria-label={`${side} port`}
                    value={connector[`${side}Port`] ?? 'auto'}
                    onChange={(e) =>
                      apply(updateConnector(connector.id, { [`${side}Port`]: e.target.value }))
                    }
                  >
                    {['auto', 'top', 'right', 'bottom', 'left'].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                    {nodes.get(connector[side])?.node.ports?.map((port) => (
                      <option key={port.key} value={port.key}>
                        {port.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
            <button onClick={() => action('delete')}>Delete connector</button>
            <p className="hint">
              Drag an endpoint onto a node edge to attach it. Dropping on empty space makes it a
              free endpoint. Deleting a connected node removes incident connectors; Undo restores
              them.
            </p>
          </Section>
        </>
      ) : (
        <VisualInspector
          items={chosen.map(whiteboardDrawing)}
          onGeometry={geometry}
          onPatch={({ fill, ...patch }) =>
            apply(patchNodes(ids, { ...patch, ...(fill ? { color: fill } : {}) }))
          }
          onReplace={(file) => {
            void readImage(file)
              .then((src) => apply(patchNodes(ids, { src })))
              .catch((e) => setError(String(e)));
          }}
        />
      )}
      {!connector && chosen.length > 0 && (
        <Section title="Membership">
          <label className="ep-field">
            Section
            <select
              aria-label="Object Section"
              value={nodeSection(content, chosen[0]) ?? ''}
              onChange={(e) => apply(assignSection(ids, e.target.value || undefined))}
            >
              <option value="">Outside Sections</option>
              {content.sections?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}
      {chosen.length === 1 && !connector && (
        <WhiteboardPortsEditor
          ports={chosen[0].ports}
          used={content.connectors.flatMap((c) =>
            [
              c.from === chosen[0].id ? c.fromPort : undefined,
              c.to === chosen[0].id ? c.toPort : undefined,
            ].filter((p): p is string => !!p),
          )}
          onChange={(ports) => apply(patchNodes([chosen[0].id], { ports }))}
        />
      )}
      {!connector && !chosen.length && !selectedSection && (
        <p>
          Insert shapes, connect two selected nodes, or draw with the pen. Space pans temporarily;
          Ctrl/⌘ + wheel zooms at the pointer.
        </p>
      )}
    </fieldset>
  );
  function edgeRender(projected: CanvasTarget[], handlesOnly = false) {
    const targetAt = (point: { x: number; y: number }) =>
      [...paintOrder]
        .reverse()
        .find(
          (n) =>
            !n.hidden &&
            n.kind !== 'group' &&
            n.kind !== 'freehand' &&
            point.x >= n.bounds.x - 12 &&
            point.x <= n.bounds.x + n.bounds.width + 12 &&
            point.y >= n.bounds.y - 12 &&
            point.y <= n.bounds.y + n.bounds.height + 12,
        );
    const candidate = endpoint && targetAt(endpoint.point);
    const byId = new Map(projected.map((target) => [target.id, target]));
    const draft = {
      ...content,
      nodes: content.nodes.map((n) => ({
        ...n,
        bounds: byId.get(n.id)?.bounds ?? n.bounds,
      })),
    };
    const projectConnector = connectorProjector(draft);
    return (
      <>
        {!handlesOnly &&
          content.sections?.map((s) => {
            const b = byId.get(s.id)?.bounds ?? s.bounds;
            const candidate = content.nodes.some((n) => {
              const target = byId.get(n.id);
              return (
                target &&
                !n.groupId &&
                (target.bounds.x !== n.bounds.x || target.bounds.y !== n.bounds.y) &&
                sectionAt(content, target.bounds)?.id === s.id
              );
            });
            return (
              <rect
                key={s.id}
                {...b}
                fill={s.background}
                rx={8}
                pointerEvents="none"
                stroke={candidate ? '#5269c8' : 'none'}
                strokeWidth={3 / view.zoom}
              />
            );
          })}
        {handlesOnly && candidate && (
          <rect
            {...candidate.bounds}
            fill="none"
            stroke="#3267c8"
            strokeWidth={3 / view.zoom}
            pointerEvents="none"
            data-testid="connector-candidate"
            data-target-id={candidate.id}
          />
        )}
        <defs>
          <marker
            id="board-end"
            markerWidth="8"
            markerHeight="8"
            refX="8"
            refY="4"
            orient="auto-start-reverse"
          >
            <path d="M0 0L8 4L0 8Z" fill="#637187" />
          </marker>
        </defs>
        {draft.connectors.map((c) => {
          const temp =
              endpoint && c.id === connectorId
                ? { ...c, [endpoint.side]: '', [`${endpoint.side}Point`]: endpoint.point }
                : c,
            p = projectConnector(temp);
          if (!p) return null;
          const arrow = c.arrowhead ?? 'end';
          if (handlesOnly && connectorId !== c.id) return null;
          return (
            <g
              key={c.id}
              data-testid="board-connector"
              onPointerDown={(e) => {
                e.stopPropagation();
                setConnectorId(c.id);
                setSelected([]);
                select([c.id]);
              }}
            >
              {!handlesOnly && (
                <>
                  <path
                    d={connectorPath(c, p)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14 / view.zoom}
                  />
                  <path
                    d={connectorPath(c, p)}
                    fill="none"
                    stroke={c.stroke ?? '#637187'}
                    strokeWidth={c.strokeWidth ?? 2}
                    markerEnd={arrow !== 'none' ? 'url(#board-end)' : undefined}
                    markerStart={arrow === 'both' ? 'url(#board-end)' : undefined}
                  />
                  <text
                    x={(p.x1 + p.x2) / 2}
                    y={(p.y1 + p.y2) / 2 - 8}
                    textAnchor="middle"
                    fontSize={14}
                    fill="#253044"
                    stroke="white"
                    strokeWidth={4}
                    paintOrder="stroke"
                  >
                    {c.label}
                  </text>
                </>
              )}
              {handlesOnly &&
                connectorId === c.id &&
                !readOnly &&
                (['from', 'to'] as const).map((side) => (
                  <circle
                    key={side}
                    role="button"
                    aria-label={`Move connector ${side}`}
                    cx={side === 'from' ? p.x1 : p.x2}
                    cy={side === 'from' ? p.y1 : p.y2}
                    r={10 / view.zoom}
                    fill="white"
                    stroke="#3267c8"
                    strokeWidth={2 / view.zoom}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      endpointPointer.current = e.pointerId;
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      if (
                        endpointPointer.current !== e.pointerId ||
                        !e.currentTarget.hasPointerCapture(e.pointerId)
                      )
                        return;
                      const matrix = e.currentTarget.getScreenCTM();
                      if (matrix) {
                        const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
                          matrix.inverse(),
                        );
                        setEndpoint({ side, point: { x: point.x, y: point.y } });
                      }
                    }}
                    onPointerCancel={() => {
                      endpointPointer.current = undefined;
                      setEndpoint(undefined);
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      if (!endpoint || endpointPointer.current !== e.pointerId) return;
                      endpointPointer.current = undefined;
                      const point = endpoint.point,
                        target = targetAt(point);
                      let port = 'auto';
                      if (target) {
                        const b = target.bounds,
                          distances = [
                            ['left', Math.abs(point.x - b.x)],
                            ['right', Math.abs(point.x - b.x - b.width)],
                            ['top', Math.abs(point.y - b.y)],
                            ['bottom', Math.abs(point.y - b.y - b.height)],
                          ] as [string, number][];
                        port = distances.sort((a, b) => a[1] - b[1])[0][0];
                      }
                      apply(
                        updateConnector(c.id, {
                          [side]: target?.id ?? '',
                          [`${side}Point`]: point,
                          [`${side}Port`]: port,
                        }),
                      );
                      setEndpoint(undefined);
                    }}
                  />
                ))}
            </g>
          );
        })}
      </>
    );
  }
  const toolbar = (
    <>
      <InsertTools
        readOnly={readOnly}
        onShape={(shape: ShapeKind) => add('shape', { shape, text: '' })}
        onText={() => add('text')}
        onImage={(file) => void image(file)}
      />
      <IconButton
        icon={StickyNote}
        label="Add sticky"
        disabled={readOnly}
        onClick={() => add('sticky')}
      />
      <IconButton
        icon={Frame}
        label="Draw Section"
        aria-pressed={sectionTool}
        disabled={readOnly}
        onClick={() => {
          setSectionTool(!sectionTool);
          setPen(false);
        }}
      />
      <IconButton
        icon={Pen}
        label="Freehand pen"
        aria-pressed={pen}
        disabled={readOnly}
        onClick={() => setPen(!pen)}
      />
      <IconButton
        icon={ArrowUpRight}
        label="Connect selected"
        disabled={ids.length !== 2 || readOnly}
        reason="Select two nodes"
        onClick={() => apply(connectNodes(ids[0], ids[1]))}
      />
      <ArrangeMenu
        count={ids.length}
        readOnly={readOnly}
        onAction={action}
        reference={reference}
        onReference={setReference}
        onAlign={(mode) => {
          const parent = content.sections?.find(
            (s) => s.id === (chosen[0] ? nodeSection(content, chosen[0]) : undefined),
          );
          if (reference === 'page' && !parent) {
            setError('Select nodes within a Section for region-relative alignment');
            return;
          }
          apply(alignNodes(ids, mode, reference === 'page' ? parent?.bounds : undefined));
        }}
      />
      <EditMenu onAction={action} readOnly={readOnly} />
      <Menu label="Board actions" icon={Layers}>
        <button disabled={!chosen.length || readOnly} onClick={() => action('frame')}>
          Section around selected objects
        </button>
        <button onClick={() => fit()}>Fit all content</button>
        {(['x', 'y'] as const).map((axis) => (
          <CommitInput
            key={axis}
            label={`Camera center ${axis}`}
            type="number"
            value={Math.round(
              ((axis === 'x'
                ? (viewport.current?.clientWidth ?? 900)
                : (viewport.current?.clientHeight ?? 600)) /
                2 -
                view.pan[axis]) /
                view.zoom,
            )}
            onCommit={(value) => {
              const size =
                axis === 'x'
                  ? (viewport.current?.clientWidth ?? 900)
                  : (viewport.current?.clientHeight ?? 600);
              setView({
                ...view,
                fit: false,
                pan: { ...view.pan, [axis]: size / 2 - Number(value) * view.zoom },
              });
            }}
          />
        ))}
        <button disabled={!ids.length} onClick={() => fit(ids)}>
          Fit selection
        </button>
      </Menu>
      <Menu label="Export whiteboard" icon={Download}>
        {(['svg', 'png'] as const).map((format) =>
          ['all', 'selection', 'section'].map((scope) => (
            <button key={format + scope} onClick={() => void output(format, scope)}>
              Export {scope} {format.toUpperCase()}
            </button>
          )),
        )}
      </Menu>
    </>
  );
  return (
    <EditorLayout
      viewKey="whiteboard"
      leftLabel="Board navigator"
      inspectorLabel="Board inspector"
      toolbar={toolbar}
      left={left}
      inspector={inspector}
      status={
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
      }
      {...layout}
    >
      <div ref={viewport} style={{ height: '100%' }}>
        {error && (
          <div className="surface-error" role="alert">
            {error}
            <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        <CanvasStage
          label="Whiteboard canvas"
          hideControls
          space="infinite"
          fitBounds={contentBounds}
          background="#fafbfe"
          view={view}
          onViewChange={setView}
          selected={ids}
          readOnly={readOnly}
          targets={[
            ...(content.sections ?? []).map((s) => boardSectionTarget(s, view.zoom)),
            ...paintOrder.map((n) => boardNodeTarget(n, nodes.get(n.id)!.index)),
          ]}
          onSelect={choose}
          previewTransform={(ids, delta) => boardPreview(content, ids, delta)}
          onTransform={(ids, delta) => apply(transformBoardCommand(ids, delta))}
          onDelete={() => action('delete')}
          onAction={action}
          onEditText={(id, text, runs) => apply(patchNodes([id], { text, runs }))}
          onImage={(f, position) => void image(f, position)}
          insertion={sectionTool}
          onInsert={(bounds) => {
            const cmd = createSection(bounds, `Section ${(content.sections?.length ?? 0) + 1}`),
              next = cmd.apply(content);
            apply(cmd);
            choose([next.sections!.at(-1)!.id]);
            setSectionTool(false);
          }}
          freehand={pen}
          onFreehand={(points) => {
            const box = unionBounds(points.map((p) => ({ ...p, width: 1, height: 1 })));
            add('freehand', {
              bounds: box,
              text: '',
              color: '#253044',
              points: points.map((p) => ({
                x: (p.x - box.x) / box.width,
                y: (p.y - box.y) / box.height,
              })),
            });
            setPen(false);
          }}
          underlay={(targets) => edgeRender(targets)}
          overlay={(targets) => edgeRender(targets, true)}
          render={renderBoardTarget}
        />
      </div>
    </EditorLayout>
  );
}
