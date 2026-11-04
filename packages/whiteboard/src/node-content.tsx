import { useId, type ReactNode } from 'react';
import { whiteboardNodeFrame, type WhiteboardNode } from './model';

export type WhiteboardInteractionMode = 'layout' | 'content';
export interface WhiteboardNodeRenderContext {
  /** Owned snapshot with the current gesture preview; never edit through this value. */
  node: Readonly<WhiteboardNode>;
  /** Render in local coordinates (0,0)..(width,height). Surface owns transform and clip. */
  size: Readonly<{ width: number; height: number }>;
  mode: WhiteboardInteractionMode;
  selected: boolean;
  /** Board permission/mode only, not the permissions of a Host's referenced owners. */
  readOnly: boolean;
}
/** Trusted Host code only; undefined keeps the ordinary native drawing. */
export type WhiteboardNodeRenderer = (
  context: WhiteboardNodeRenderContext,
) => ReactNode | undefined;

export function BoardNodeContent({
  node,
  mode,
  children,
}: {
  node: WhiteboardNode;
  mode: WhiteboardInteractionMode;
  children: ReactNode;
}) {
  const clip = `board-node-${useId().replaceAll(':', '')}`;
  const { x, y, width, height } = node.bounds;
  const frame = whiteboardNodeFrame(node),
    origin = frame.world({ x, y });
  const ux = frame.world({ x: x + 1, y }),
    uy = frame.world({ x, y: y + 1 });
  const matrix = [
    ux.x - origin.x,
    ux.y - origin.y,
    uy.x - origin.x,
    uy.y - origin.y,
    origin.x,
    origin.y,
  ];
  return (
    <g
      transform={`matrix(${matrix.join(' ')})`}
      pointerEvents={mode === 'content' ? 'auto' : 'none'}
      onPointerDown={mode === 'content' ? (event) => event.stopPropagation() : undefined}
      onKeyDownCapture={
        mode === 'layout'
          ? (event) => {
              if (event.key === 'Tab') return;
              // A previously focused panel control must not keep handling keys after a mode switch.
              event.preventDefault();
              event.stopPropagation();
            }
          : undefined
      }
    >
      <defs>
        <clipPath id={clip}>
          <rect width={width} height={height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>{children}</g>
    </g>
  );
}
