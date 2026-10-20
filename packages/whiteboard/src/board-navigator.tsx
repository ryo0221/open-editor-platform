import type { RefObject } from 'react';
import { descendantIds, type Bounds, type EditorCommand } from '@editor-platform/editor-core';
import { Section } from '@editor-platform/editor-ui';
import { LayerNavigator, type CanvasView } from '@editor-platform/canvas-ui';
import { arrangeBoard, patchNodes, type WhiteboardContent, type WhiteboardNode } from './model';
import { sectionMembers } from './sections';

export interface BoardNavigatorProps {
  content: WhiteboardContent;
  paintOrder: WhiteboardNode[];
  contentBounds: Bounds;
  ids: string[];
  connectorId: string;
  readOnly: boolean;
  view: CanvasView;
  setView: (view: CanvasView) => void;
  viewport: RefObject<HTMLDivElement | null>;
  apply: (cmd: EditorCommand<WhiteboardContent>) => boolean;
  choose: (ids: string[]) => void;
  chooseConnector: (id: string) => void;
  fit: (ids?: string[]) => void;
  setError: (message: string) => void;
}

export function BoardNavigator(props: BoardNavigatorProps) {
  const { content, ids, readOnly, apply, choose, fit, setError } = props;
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
  return (
    <>
      <LayerNavigator
        entries={layerEntries(content.nodes)}
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
        <BoardOverview {...props} />
      </Section>
      <Section title="Connections">
        {content.connectors.map((c, i) => (
          <button
            key={c.id}
            aria-pressed={c.id === props.connectorId}
            onClick={() => props.chooseConnector(c.id)}
          >
            {c.label || `Connection ${i + 1}`}
          </button>
        ))}
      </Section>
    </>
  );
}

function BoardOverview({
  content,
  paintOrder,
  contentBounds,
  view,
  setView,
  viewport,
}: BoardNavigatorProps) {
  return (
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
  );
}

const textlessKinds = ['group', 'frame', 'image', 'freehand'];
function layerEntries(nodes: WhiteboardNode[]) {
  return nodes.map((n, i) => {
    const textual = !textlessKinds.includes(n.kind);
    return {
      id: n.id,
      parentId: n.groupId,
      name:
        n.name ||
        (textual && n.text?.replace(/\s+/g, ' ').trim().slice(0, 64)) ||
        `${n.kind} ${i + 1}`,
      text: textual ? n.text : undefined,
      type: n.kind,
      hidden: n.hidden,
      locked: n.locked,
    };
  });
}
