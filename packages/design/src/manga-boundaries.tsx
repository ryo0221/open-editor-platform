import { useContext, useEffect, useRef, useState, type PointerEvent } from 'react';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import type { EditorCommand, Point } from '@editor-platform/editor-core';
import type { DesignContent } from './model';
import {
  clampDividerOffset,
  insetDivisionPolygon,
  rectanglePolygon,
  designDivisionCommand,
  materializeDivision,
  type DesignDivisionOperation,
  type MaterializedDivider,
} from './division';
import { mangaEditingContext } from './manga-context';

function endpoints(divider: MaterializedDivider): Point[] {
  const { line, polygon } = divider,
    points: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      da = line.nx * a.x + line.ny * a.y - line.offset,
      db = line.nx * b.x + line.ny * b.y - line.offset;
    if (Math.abs(da) < 1e-7) points.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return points;
}
export function MangaBoundaryOverlay({
  content,
  displayContent,
  selected,
  currentPageId,
  zoom,
  disabled,
  preview,
  apply,
}: {
  content: DesignContent;
  displayContent: DesignContent;
  selected: string[];
  currentPageId?: string;
  zoom: number;
  disabled: boolean;
  preview: (d?: DesignContent) => void;
  apply: (cmd: EditorCommand<DesignContent>) => boolean;
}) {
  const { page, frame } = mangaEditingContext(displayContent, selected, currentPageId);
  const registry = useContext(EditorInputsContext);
  const gesture = useRef<
    | {
        base: DesignContent;
        pageId: string;
        divider: MaterializedDivider;
        start: number;
        pointerId: number;
        target: SVGGElement;
        operation?: DesignDivisionOperation;
      }
    | undefined
  >(undefined);
  const [message, setMessage] = useState('');
  const latest = useRef({ content, disabled, preview, apply });
  latest.current = { content, disabled, preview, apply };
  function cancel() {
    gesture.current = undefined;
    latest.current.preview(undefined);
    registry?.changed();
    setMessage('');
  }
  useEffect(() => {
    if (gesture.current) cancel();
  }, [content, disabled]);
  useEffect(
    () =>
      registry?.register({
        label: 'Manga boundary gesture',
        read: () => ({ dirty: !!gesture.current }),
        prepare: () => {
          throw Error('Finish or cancel the panel boundary gesture');
        },
        focus: () => gesture.current?.target.focus(),
        history: () => {
          if (!gesture.current) return false;
          cancel();
          return true;
        },
      }),
    [registry],
  );
  function point(event: PointerEvent<SVGGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  }
  if (!page || !frame) return null;
  const geometry = page.division ? materializeDivision(page.division, frame.bounds) : undefined;
  return (
    <g aria-label="Manga reading order and boundaries">
      {page.panelIds.map((id, i) => {
        const panel = displayContent.elements.find((e) => e.id === id)!;
        const outline =
          panel.panelGeometry?.polygon.map((p) => ({
            x: panel.bounds.x + p.x * panel.bounds.width,
            y: panel.bounds.y + p.y * panel.bounds.height,
          })) ?? rectanglePolygon(panel.bounds);
        const inset = insetDivisionPolygon(outline, 14 / zoom);
        if (!inset.length) return null;
        const anchor = inset.reduce((a, b) => (a.x + a.y < b.x + b.y ? a : b));
        return (
          <g key={id} pointerEvents="none">
            <circle cx={anchor.x} cy={anchor.y} r={11 / zoom} fill="#225b83" />
            <text
              x={anchor.x}
              y={anchor.y + 4 / zoom}
              fontSize={12 / zoom}
              textAnchor="middle"
              fill="white"
            >
              {i + 1}
            </text>
          </g>
        );
      })}
      {!disabled &&
        geometry?.dividers.map((d, i) => {
          const [a, b] = endpoints(d);
          if (!a || !b) return null;
          const coords = {
            x1: frame.bounds.x + a.x,
            y1: frame.bounds.y + a.y,
            x2: frame.bounds.x + b.x,
            y2: frame.bounds.y + b.y,
          };
          return (
            <g
              key={d.dividerId}
              role="slider"
              tabIndex={0}
              aria-label={`コマ境界 ${i + 1}`}
              aria-valuenow={d.line.offset}
              aria-valuetext={`位置 ${d.line.offset.toFixed(1)}、間隔 ${d.gap}`}
              style={{ cursor: 'move' }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancel();
                  return;
                }
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                e.preventDefault();
                e.stopPropagation();
                const delta =
                  (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) *
                  (e.shiftKey ? 10 : 1);
                latest.current.apply(
                  designDivisionCommand({
                    type: 'setDivider',
                    pageId: page.frameId,
                    dividerId: d.dividerId,
                    line: { ...d.line, offset: d.line.offset + delta },
                    gap: d.gap,
                  }),
                );
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || latest.current.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                const p = point(e);
                if (!p) return;
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                gesture.current = {
                  base: content,
                  pageId: page.frameId,
                  divider: d,
                  start: d.line.nx * p.x + d.line.ny * p.y,
                  pointerId: e.pointerId,
                  target: e.currentTarget,
                };
                registry?.changed();
              }}
              onPointerMove={(e) => {
                const g = gesture.current;
                if (!g || g.pointerId !== e.pointerId) return;
                e.preventDefault();
                e.stopPropagation();
                if (g.base !== latest.current.content || latest.current.disabled) {
                  cancel();
                  return;
                }
                const p = point(e);
                if (!p) return;
                try {
                  const result = clampDividerOffset(
                    g.base,
                    g.pageId,
                    g.divider.dividerId,
                    g.divider.line.offset +
                      g.divider.line.nx * p.x +
                      g.divider.line.ny * p.y -
                      g.start,
                  );
                  g.operation = result.operation;
                  latest.current.preview(result.content);
                  setMessage(result.limited ? result.reason : '');
                } catch (error) {
                  setMessage(String(error));
                }
              }}
              onPointerUp={(e) => {
                const g = gesture.current;
                if (!g || g.pointerId !== e.pointerId) return;
                e.preventDefault();
                e.stopPropagation();
                gesture.current = undefined;
                registry?.changed();
                latest.current.preview(undefined);
                if (g.operation && g.base === latest.current.content && !latest.current.disabled)
                  latest.current.apply(designDivisionCommand(g.operation));
                setMessage('');
              }}
              onPointerCancel={cancel}
              onLostPointerCapture={() => {
                if (gesture.current) cancel();
              }}
            >
              <line {...coords} stroke="transparent" strokeWidth={18 / zoom} />
              <line
                {...coords}
                stroke="#277da8"
                strokeDasharray={`${5 / zoom} ${4 / zoom}`}
                strokeWidth={1.5 / zoom}
                pointerEvents="none"
              />
            </g>
          );
        })}
      {message && (
        <text
          x={frame.bounds.x}
          y={frame.bounds.y - 12 / zoom}
          fontSize={12 / zoom}
          fill="#9e350e"
          pointerEvents="none"
          role="status"
        >
          {message}
        </text>
      )}
    </g>
  );
}
