import {
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { DesignContent } from './model';
import { insertDesignStroke } from './stroke-path';

export function useDesignStrokeInput(options: {
  enabled: boolean;
  readOnly: boolean;
  blocked: boolean;
  content: DesignContent;
  zoom: number;
  parentId?: string;
  apply(c: EditorCommand<DesignContent>): boolean;
  created(id: string): void;
  error(message: string): void;
}) {
  const [active, setActive] = useState(false),
    [preview, setPreview] = useState<{ x: number; y: number }[]>();
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<
    | {
        base: DesignContent;
        parentId?: string;
        pointerId: number;
        target: SVGRectElement;
        points: { x: number; y: number }[];
      }
    | undefined
  >(undefined);
  const inputs = useContext(EditorInputsContext);
  function cancel() {
    const g = gesture.current;
    gesture.current = undefined;
    if (g?.target.hasPointerCapture(g.pointerId)) g.target.releasePointerCapture(g.pointerId);
    setPreview(undefined);
    inputs?.changed();
  }
  useEffect(() => {
    cancel();
    if (options.readOnly || !options.enabled || options.blocked) setActive(false);
  }, [options.content, options.readOnly, options.enabled, options.blocked, options.zoom]);
  useEffect(
    () => () => {
      gesture.current = undefined;
    },
    [],
  );
  useEffect(
    () =>
      inputs?.register({
        label: 'Ink stroke gesture',
        read: () => ({ dirty: !!gesture.current }),
        prepare: () => {
          throw Error('Finish or cancel the ink stroke before saving or applying changes');
        },
        focus: () => gesture.current?.target.focus({ preventScroll: true }),
        history: () => {
          if (!gesture.current) return false;
          cancel();
          return true;
        },
      }),
    [inputs],
  );
  function point(event: PointerEvent<SVGRectElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (
      !matrix ||
      !Number.isFinite(matrix.a * matrix.d - matrix.b * matrix.c) ||
      matrix.a * matrix.d - matrix.b * matrix.c === 0
    )
      return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.abs(p.x) > 1_000_000 ||
      Math.abs(p.y) > 1_000_000
    )
      return;
    return { x: p.x, y: p.y };
  }
  function keyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (gesture.current) cancel();
      else setActive(false);
    }
  }
  const drawing = active && !options.readOnly && options.enabled && !options.blocked;
  const overlay = drawing ? (
    <g data-ink-overlay="true">
      <rect
        data-ink-input="true"
        x={-1_000_000}
        y={-1_000_000}
        width={2_000_000}
        height={2_000_000}
        fill="transparent"
        role="button"
        aria-label="Ink stroke input"
        tabIndex={0}
        style={{ cursor: 'crosshair' }}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            !e.isPrimary ||
            gesture.current ||
            latest.current.readOnly ||
            latest.current.blocked
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          try {
            inputs?.flush();
            const p = point(e);
            if (!p) return;
            e.currentTarget.focus({ preventScroll: true });
            e.currentTarget.setPointerCapture(e.pointerId);
            gesture.current = {
              base: latest.current.content,
              parentId: latest.current.parentId,
              pointerId: e.pointerId,
              target: e.currentTarget,
              points: [p],
            };
            setPreview([p]);
            inputs?.changed();
          } catch (error) {
            options.error(String(error));
          }
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || g.pointerId !== e.pointerId) return;
          e.preventDefault();
          e.stopPropagation();
          const p = point(e);
          if (!p) return;
          const last = g.points.at(-1)!;
          if (Math.hypot(last.x - p.x, last.y - p.y) < 0.4) return;
          if (g.points.length >= 2048) {
            cancel();
            options.error('Ink stroke exceeds 2048 samples; draw a shorter stroke');
            return;
          }
          g.points.push(p);
          setPreview([...g.points]);
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          if (!g || g.pointerId !== e.pointerId) return;
          e.preventDefault();
          e.stopPropagation();
          const p = point(e);
          if (p) {
            const last = g.points.at(-1)!;
            if (p.x !== last.x || p.y !== last.y) g.points.push(p);
          }
          cancel();
          if (latest.current.readOnly || g.base !== latest.current.content) return;
          if (g.points.length < 2) return;
          try {
            const command = insertDesignStroke(
              g.points,
              g.parentId,
              () => !latest.current.readOnly,
            );
            if (latest.current.apply(command)) latest.current.created(command.elementId);
          } catch (error) {
            options.error(String(error));
          }
        }}
        onPointerCancel={(e) => {
          if (gesture.current?.pointerId === e.pointerId) cancel();
        }}
        onLostPointerCapture={(e) => {
          if (gesture.current?.pointerId === e.pointerId) cancel();
        }}
      />
      {preview && preview.length > 1 && (
        <path
          d={preview.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')}
          fill="none"
          stroke="#151515"
          strokeWidth={2.5}
          pointerEvents="none"
        />
      )}
    </g>
  ) : undefined;
  const controls = options.enabled ? (
    <button
      type="button"
      aria-pressed={active}
      disabled={options.readOnly || options.blocked}
      onClick={() => {
        try {
          inputs?.flush();
          cancel();
          setActive(!active);
        } catch (error) {
          options.error(String(error));
        }
      }}
    >
      {active ? 'Finish drawing strokes' : 'Draw ink stroke'}
    </button>
  ) : undefined;
  return { active: drawing, busy: () => !!gesture.current, keyDown, overlay, controls };
}
