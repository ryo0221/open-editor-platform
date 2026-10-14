import { useEffect, useId, useRef, useState } from 'react';
import { descendantIds, type ElementAddress, type Annotation } from '@editor-platform/editor-core';
import { isTextInput } from '@editor-platform/editor-ui';
import { DrawingView } from '@editor-platform/canvas-ui';
import { designDrawingProjector, designPaintOrder, type DesignContent } from './model';
import {
  activateDesignPrototype,
  applyDesignPrototypeAction,
  designPrototypeAddress,
  designPrototypeFrameId,
  designPrototypeTargets,
  diagnoseDesignPrototype,
  nextDesignPrototypeTargets,
  startDesignPrototype,
  type DesignFlowCompletion,
  type DesignPrototypeState,
} from './prototype';

export interface DesignPrototypeSurfaceProps {
  content: DesignContent;
  startFrameId?: string;
  flowId?: string;
  artifactId?: string;
  annotations?: Annotation[];
  onFlowComplete?: (event: DesignFlowCompletion) => void;
  /** Host owns creation/persistence; coordinates use Design world pixels. */
  onAnnotationAnchor?: (address: ElementAddress) => void;
  onCreateAnnotation?: (address: ElementAddress, body: string) => void | Promise<void>;
  onClose?: () => void;
}
export function DesignPrototypeSurface({
  content,
  startFrameId,
  flowId,
  artifactId,
  annotations = [],
  onFlowComplete,
  onAnnotationAnchor,
  onClose,
  onCreateAnnotation,
}: DesignPrototypeSurfaceProps) {
  const initialize = () => {
    try {
      return startDesignPrototype(content, { frameId: startFrameId, flowId });
    } catch {
      return undefined;
    }
  };
  const [state, setState] = useState<DesignPrototypeState | undefined>(initialize);
  const [startingFrame, setStartingFrame] = useState(() => initialize()?.frameId);
  const surfaceId = useId().replace(/:/g, '');
  const [hotspots, setHotspots] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [position, setPosition] = useState(false);
  const [anchor, setAnchor] = useState<ElementAddress>();
  const [comment, setComment] = useState('');
  const [commentPending, setCommentPending] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState(0);
  const completedRun = useRef<number | undefined>(undefined);
  const focusFrame = useRef<HTMLHeadingElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<'click' | 'tap'>('click');
  const frames = content.elements.filter((e) => e.type === 'frame' && !e.hidden);
  const diagnostics = diagnoseDesignPrototype(content);
  const activeId = state ? designPrototypeFrameId(state) : undefined;
  const current = frames.find((f) => f.id === activeId);
  const flow = content.prototyping?.flows.find((f) => f.id === state?.flowId);
  useEffect(() => {
    const active = stage.current?.querySelector<SVGElement>(
      '[data-prototype-active] [role="button"]',
    );
    if (active) active.focus();
    else focusFrame.current?.focus();
  }, [activeId]);
  useEffect(() => {
    if (state?.completed && flow && completedRun.current !== run) {
      completedRun.current = run;
      onFlowComplete?.({ flowId: flow.id, frameIds: [...flow.frameIds] });
    }
  }, [state?.completed, flow, run, onFlowComplete]);
  const restart = (options: { frameId?: string; flowId?: string }) => {
    try {
      const next = startDesignPrototype(content, options);
      setState(next);
      setStartingFrame(next.frameId);
      setRun((v) => v + 1);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const perform = (action: () => { state: DesignPrototypeState }) => {
    try {
      setState(action().state);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const next = state ? nextDesignPrototypeTargets(content, state) : [];
  const canAnnotate = !!artifactId && (!!onAnnotationAnchor || !!onCreateAnnotation);
  const chooseAnchor = (address: ElementAddress) => {
    if (commentPending) return;
    setAnchor(address);
    onAnnotationAnchor?.(address);
  };
  function renderFrame(id: string, interactive: boolean, instance = 0) {
    const f = frames.find((f) => f.id === id);
    if (!f) return <p role="alert">Frame is missing or hidden: {id}</p>;
    const included = descendantIds(content.elements, [id]);
    const targets = designPrototypeTargets(content, id);
    const visible = new Set(targets.map((t) => [t.elementId, ...t.partIds].join('-')));
    const drawings = designPaintOrder(content)
      .filter((e) => included.has(e.id) && visible.has(e.id))
      .flatMap(designDrawingProjector(content))
      .filter((d) => visible.has(d.id));
    const b = f.bounds;
    return (
      <svg
        key={id}
        aria-label={`Prototype frame ${f.name}`}
        role="group"
        aria-hidden={!interactive}
        data-prototype-active={interactive || undefined}
        viewBox={`${b.x} ${b.y} ${b.width} ${b.height}`}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          maxHeight: '100%',
          touchAction: 'manipulation',
        }}
        onPointerDown={(e) => {
          pointer.current = e.pointerType === 'touch' ? 'tap' : 'click';
        }}
        onClick={(e) => {
          if (!interactive || !annotating || !canAnnotate) return;
          const matrix = e.currentTarget.getScreenCTM();
          if (!matrix) return;
          const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
          if (point.x < b.x || point.y < b.y || point.x > b.x + b.width || point.y > b.y + b.height)
            return;
          chooseAnchor({
            artifactId: artifactId!,
            elementId: id,
            region: { type: 'canvas', x: point.x, y: point.y, width: 1, height: 1 },
          });
        }}
      >
        {drawings.map((drawing, i) => (
          <DrawingView key={`${drawing.id}-${i}`} drawing={drawing} />
        ))}
        {interactive &&
          targets
            .filter((t) =>
              annotating
                ? !position && (t.elementId !== id || t.partIds.length)
                : t.interactions.length,
            )
            .map((t, i) => {
              const hint = !annotating && next.includes(t.key);
              const visible = annotating || hotspots || hint;
              const activate = () => {
                if (annotating && canAnnotate) chooseAnchor(designPrototypeAddress(artifactId!, t));
                else if (state)
                  perform(() => activateDesignPrototype(content, state, t.key, pointer.current));
              };
              const prefix = `prototype-${surfaceId}-${instance}-${i}`;
              let hit = (
                <g
                  transform={`rotate(${t.rotation} ${t.bounds.x + t.bounds.width / 2} ${t.bounds.y + t.bounds.height / 2})`}
                >
                  <rect
                    {...t.bounds}
                    fill={visible ? '#2563eb22' : 'transparent'}
                    stroke={hint ? '#e85d04' : visible ? '#2563eb' : 'transparent'}
                    strokeWidth={hint ? 4 : 2}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
              for (const [index, clip] of t.clips.entries()) {
                const clipId = `${prefix}-${index}`;
                hit = (
                  <g clipPath={`url(#${clipId})`}>
                    <defs>
                      <clipPath id={clipId}>
                        <rect
                          {...clip}
                          transform={`rotate(${clip.rotation ?? 0} ${clip.x + clip.width / 2} ${clip.y + clip.height / 2})`}
                        />
                      </clipPath>
                    </defs>
                    {hit}
                  </g>
                );
              }
              return (
                <g
                  key={t.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`${annotating ? 'Annotate' : 'Activate'} ${t.name}`}
                  aria-description={hint ? 'Next step in selected flow' : undefined}
                  data-prototype-next={hint || undefined}
                  style={{ cursor: annotating ? 'crosshair' : 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    activate();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      pointer.current = 'click';
                      activate();
                    }
                  }}
                >
                  {hit}
                  <title>
                    {t.name}
                    {hint ? ' — next step' : ''}
                  </title>
                </g>
              );
            })}
        {annotations
          .filter((a) => !a.resolved)
          .flatMap((a) =>
            a.anchor.addresses
              .filter(
                (address) => address.artifactId === artifactId && included.has(address.elementId),
              )
              .map((address, index) => {
                const e = content.elements.find((e) => e.id === address.elementId);
                const region = address.region?.type === 'canvas' ? address.region : e?.bounds;
                if (!region) return null;
                return (
                  <circle
                    key={`${a.id}-${index}`}
                    cx={region.x + region.width / 2}
                    cy={region.y + region.height / 2}
                    r={8}
                    fill="#f59e0b"
                    pointerEvents="none"
                  >
                    <title>{a.comments[0]?.body}</title>
                  </circle>
                );
              }),
          )}
      </svg>
    );
  }
  return (
    <section
      aria-label="Design prototype"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
          if (!isTextInput(e.target)) e.preventDefault();
          e.stopPropagation();
        }
        if (e.key === 'Escape' && state?.overlays.length) {
          e.preventDefault();
          e.stopPropagation();
          perform(() => applyDesignPrototypeAction(content, state, { type: 'close-overlay' }));
        }
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: '#172334',
        background: '#f3f5f8',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <style>{`.design-prototype-stage [role=button]:focus-visible rect { stroke: #172334; stroke-width: 3; } .design-prototype-stage [role=button]:hover rect { fill: #2563eb22; }`}</style>
      <div
        role="toolbar"
        aria-label="Prototype controls"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}
      >
        <label>
          Start frame{' '}
          <select
            aria-label="Prototype start frame"
            value={startingFrame ?? ''}
            onChange={(e) => restart({ frameId: e.target.value })}
          >
            <option value="" disabled>
              Choose frame
            </option>
            {frames.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Flow{' '}
          <select
            aria-label="Prototype flow"
            value={state?.flowId ?? ''}
            onChange={(e) =>
              restart(e.target.value ? { flowId: e.target.value } : { frameId: state?.frameId })
            }
          >
            <option value="">Explore freely</option>
            {content.prototyping?.flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!state?.history.length}
          onClick={() =>
            state && perform(() => applyDesignPrototypeAction(content, state, { type: 'back' }))
          }
        >
          Prototype back
        </button>
        <button
          disabled={!state}
          onClick={() =>
            restart(state?.flowId ? { flowId: state.flowId } : { frameId: startingFrame })
          }
        >
          Restart prototype
        </button>
        <button aria-pressed={hotspots} onClick={() => setHotspots(!hotspots)}>
          Show hotspots
        </button>
        {canAnnotate && (
          <button aria-pressed={annotating} onClick={() => setAnnotating(!annotating)}>
            Annotate prototype
          </button>
        )}
        {annotating && (
          <label>
            <input
              type="checkbox"
              checked={position}
              onChange={(e) => setPosition(e.target.checked)}
            />
            Annotate any position
          </label>
        )}
        {onClose && <button onClick={onClose}>Exit prototype</button>}
      </div>
      <h2 ref={focusFrame} tabIndex={-1} style={{ margin: '4px 12px', fontSize: 18 }}>
        {current?.name ?? 'No prototype frame'}
      </h2>
      {flow && (
        <p role="status" style={{ margin: '4px 12px' }}>
          {flow.name}:{' '}
          {state?.completed
            ? 'Completed'
            : `Step ${(state?.flowIndex ?? 0) + 1} / ${flow.frameIds.length}`}
          {!state?.completed && flow.frameIds[(state?.flowIndex ?? 0) + 1]
            ? ` · Next: ${frames.find((f) => f.id === flow.frameIds[state!.flowIndex + 1])?.name ?? flow.frameIds[state!.flowIndex + 1]}`
            : ''}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {annotating && (onCreateAnnotation || comment) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (commentPending || !onCreateAnnotation || !anchor || !comment.trim()) return;
            setCommentPending(true);
            setError('');
            Promise.resolve()
              .then(() => onCreateAnnotation(anchor, comment.trim()))
              .then(() => {
                setComment('');
                setAnchor(undefined);
              })
              .catch((e: Error) => setError(e.message))
              .finally(() => setCommentPending(false));
          }}
          style={{ padding: 8 }}
        >
          {!onCreateAnnotation && <p>Comment submission unavailable. Your draft is retained.</p>}
          <label>
            Prototype comment{' '}
            <input
              aria-label="Prototype comment"
              value={comment}
              disabled={commentPending}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          <button disabled={commentPending || !onCreateAnnotation || !anchor || !comment.trim()}>
            Add prototype comment
          </button>
        </form>
      )}
      {diagnostics.length > 0 && (
        <details style={{ margin: '4px 12px' }}>
          <summary>Prototype diagnostics ({diagnostics.length})</summary>
          <ul>
            {diagnostics.map((d, i) => (
              <li key={i}>
                {d.code}: {d.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div
        ref={stage}
        className="design-prototype-stage"
        style={{ position: 'relative', flex: 1, minHeight: 180, overflow: 'hidden', padding: 8 }}
      >
        {state && renderFrame(state.frameId, !state.overlays.length)}
        {state?.overlays.map((id, index) => (
          <div
            key={`${id}-${index}`}
            style={{
              position: 'absolute',
              inset: 0,
              background: '#0008',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
            }}
          >
            <div
              role="dialog"
              aria-hidden={index !== state.overlays.length - 1}
              aria-label={`Overlay ${frames.find((f) => f.id === id)?.name ?? id}`}
              style={{
                width: frames.find((f) => f.id === id)?.bounds.width ?? 400,
                maxWidth: '100%',
                height: frames.find((f) => f.id === id)?.bounds.height ?? 300,
                maxHeight: '85%',
              }}
            >
              {renderFrame(id, index === state.overlays.length - 1, index + 1)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
