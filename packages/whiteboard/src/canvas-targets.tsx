import { deepFreeze, isDeepFrozen } from '@editor-platform/artifact-core';
import { DrawingView, type CanvasTarget } from '@editor-platform/canvas-ui';
import { whiteboardDrawing, type WhiteboardNode, type WhiteboardSection } from './model';

type BoardTarget = CanvasTarget &
  (
    | { boardType: 'node'; node: WhiteboardNode }
    | { boardType: 'section'; section: WhiteboardSection; zoom: number }
  );
const nodeTargets = new WeakMap<WhiteboardNode, { index: number; target: BoardTarget }>();
const sectionTargets = new WeakMap<WhiteboardSection, { zoom: number; target: BoardTarget }>();

export function boardNodeTarget(node: WhiteboardNode, index: number): BoardTarget {
  const owned = isDeepFrozen(node),
    previous = owned ? nodeTargets.get(node) : undefined;
  if (previous?.index === index) return previous.target;
  const target: BoardTarget = {
    ...node,
    textDrawing: whiteboardDrawing(node),
    boardType: 'node',
    node,
    parentId: node.groupId,
    label: `${node.kind} ${index + 1}`,
    editableText: !['image', 'freehand', 'group'].includes(node.kind),
    container: node.kind === 'group',
    hitBox: node.kind === 'text',
  };
  if (owned) nodeTargets.set(node, { index, target: deepFreeze(target) });
  return target;
}

export function boardSectionTarget(section: WhiteboardSection, zoom: number): BoardTarget {
  const owned = isDeepFrozen(section),
    previous = owned ? sectionTargets.get(section) : undefined;
  if (previous?.zoom === zoom) return previous.target;
  const target: BoardTarget = {
    ...section,
    boardType: 'section',
    section,
    zoom,
    label: `Section ${section.title}`,
    rotatable: false,
  };
  if (owned) sectionTargets.set(section, { zoom, target: deepFreeze(target) });
  return target;
}

// Native records travel with the target. CanvasStage overlays transient geometry
// without consulting a changing content map or closing over the current camera.
export function renderBoardTarget(value: CanvasTarget) {
  const target = value as BoardTarget;
  if (target.boardType === 'section')
    return (
      <g>
        <rect
          {...target.bounds}
          rx={8}
          fill="none"
          stroke="#8998bb"
          strokeWidth={1 / target.zoom}
        />
        <rect {...target.bounds} fill="none" stroke="transparent" strokeWidth={12 / target.zoom} />
        <text
          x={target.bounds.x + 14}
          y={target.bounds.y + 26}
          fontSize={16}
          fontWeight={600}
          fill="#465879"
        >
          {target.section.title}
        </text>
      </g>
    );
  return (
    <DrawingView
      drawing={whiteboardDrawing({
        ...target.node,
        bounds: target.bounds,
        rotation: target.rotation,
      })}
    />
  );
}
