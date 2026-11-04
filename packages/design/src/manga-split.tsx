import { useContext, useEffect, useRef, useState, type PointerEvent } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import type { Point } from '@editor-platform/editor-core';
import type { DesignContent } from './model';
import { designDivisionCommand, type DesignDivisionOperation } from './division';
import { mangaEditingContext } from './manga-context';

/** Draw one line on the selected panel, then hand its deterministic operation to review. */
export function MangaSplitOverlay({
  content,
  selected,
  currentPageId,
  zoom,
  preview,
  propose,
  cancel,
}: {
  content: DesignContent;
  selected: string[];
  currentPageId?: string;
  zoom: number;
  preview: (d?: DesignContent) => void;
  propose: (op: DesignDivisionOperation) => void;
  cancel: () => void;
}) {
  const inputs = useContext(EditorInputsContext);
  const { page, frame, panel } = mangaEditingContext(content, selected, currentPageId);
  const gesture = useRef<
    | {
        point: Point;
        pointerId: number;
        newPanelId: string;
        dividerId: string;
        op?: DesignDivisionOperation;
      }
    | undefined
  >(undefined);
  const [line, setLine] = useState<{ a: Point; b: Point }>(),
    [error, setError] = useState('');
  const stop = () => {
    gesture.current = undefined;
    setLine(undefined);
    preview(undefined);
    inputs?.changed();
  };
  useEffect(
    () =>
      inputs?.register({
        label: 'Manga split gesture',
        read: () => ({ dirty: !!gesture.current }),
        prepare: () => {
          throw Error('Finish or cancel drawing the split line');
        },
        focus: () => {},
        history: () => {
          if (!gesture.current) return false;
          stop();
          return true;
        },
      }),
    [inputs],
  );
  useEffect(() => {
    stop();
  }, [content]);
  const point = (e: PointerEvent<SVGRectElement>) => {
    const matrix = e.currentTarget.getScreenCTM();
    return matrix
      ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
      : undefined;
  };
  if (!page?.division || !frame || !panel) return null;
  return (
    <g>
      <rect
        {...panel.bounds}
        fill="transparent"
        pointerEvents="all"
        tabIndex={0}
        role="button"
        aria-label="分割線をドラッグ"
        style={{ cursor: 'crosshair' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            stop();
            cancel();
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          const p = point(e);
          if (!p) return;
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          gesture.current = {
            point: { x: p.x, y: p.y },
            pointerId: e.pointerId,
            newPanelId: newId('panel'),
            dividerId: newId('divider'),
          };
          inputs?.changed();
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || e.pointerId !== g.pointerId) return;
          e.preventDefault();
          e.stopPropagation();
          const p = point(e);
          if (!p) return;
          setLine({ a: g.point, b: p });
          const dx = p.x - g.point.x,
            dy = p.y - g.point.y,
            length = Math.hypot(dx, dy);
          if (length < 8 / zoom) {
            g.op = undefined;
            preview(undefined);
            return;
          }
          let nx = -dy / length,
            ny = dx / length;
          if (ny < 0 || (ny === 0 && nx < 0)) {
            nx = -nx;
            ny = -ny;
          }
          const op: DesignDivisionOperation = {
            type: 'splitPanel',
            pageId: page.frameId,
            panelId: panel.id,
            newPanelId: g.newPanelId,
            dividerId: g.dividerId,
            line: {
              nx,
              ny,
              offset: nx * (g.point.x - frame.bounds.x) + ny * (g.point.y - frame.bounds.y),
            },
            gap: 16,
            retain: 'a',
            insert: 'after',
          };
          try {
            const next = designDivisionCommand(op).apply(content);
            g.op = op;
            preview(next);
            setError('');
          } catch (e) {
            g.op = undefined;
            preview(undefined);
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          if (!g || g.pointerId !== e.pointerId) return;
          e.preventDefault();
          e.stopPropagation();
          stop();
          if (g.op) propose(g.op);
          cancel();
        }}
        onPointerCancel={() => {
          stop();
          cancel();
        }}
        onLostPointerCapture={() => {
          if (gesture.current) {
            stop();
            cancel();
          }
        }}
      />
      {line && (
        <line
          x1={line.a.x}
          y1={line.a.y}
          x2={line.b.x}
          y2={line.b.y}
          stroke="#cb4e20"
          strokeWidth={2 / zoom}
          pointerEvents="none"
        />
      )}
      {error && (
        <text
          x={frame.bounds.x}
          y={frame.bounds.y - 12 / zoom}
          fontSize={12 / zoom}
          fill="#9e350e"
          pointerEvents="none"
        >
          {error}
        </text>
      )}
    </g>
  );
}
