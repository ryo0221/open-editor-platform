import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { descendantIds, type ElementAddress, type Annotation } from '@editor-platform/editor-core';
import { isTextInput } from '@editor-platform/editor-ui';
import { DrawingView } from '@editor-platform/canvas-ui';
import {
  designDrawingProjector,
  designPaintOrder,
  type DesignContent,
  type DesignElement,
} from './model';
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
  type DesignPrototypeDiagnostic,
  type DesignPrototypeState,
  type DesignPrototypeTarget,
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
type Pointer = RefObject<'click' | 'tap'>;
type Flow = NonNullable<DesignContent['prototyping']>['flows'][number];

const rotateAbout = (b: { x: number; y: number; width: number; height: number }, r = 0) =>
  `rotate(${r} ${b.x + b.width / 2} ${b.y + b.height / 2})`;

/** One hotspot: the hit rectangle, clipped by every inherited clipping frame. */
function PrototypeHotspot({
  target: t,
  prefix,
  hint,
  visible,
  annotating,
  pointer,
  activate,
}: {
  target: DesignPrototypeTarget;
  prefix: string;
  hint: boolean;
  visible: boolean;
  annotating: boolean;
  pointer: Pointer;
  activate: () => void;
}) {
  let hit = (
    <g transform={rotateAbout(t.bounds, t.rotation)}>
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
            <rect {...clip} transform={rotateAbout(clip, clip.rotation ?? 0)} />
          </clipPath>
        </defs>
        {hit}
      </g>
    );
  }
  return (
    <g
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
}

/** Unresolved annotation pins anchored inside the shown frame. */
function AnnotationPins({
  content,
  annotations,
  artifactId,
  included,
}: {
  content: DesignContent;
  annotations: Annotation[];
  artifactId?: string;
  included: Set<string>;
}) {
  return annotations
    .filter((a) => !a.resolved)
    .flatMap((a) =>
      a.anchor.addresses
        .filter((address) => address.artifactId === artifactId && included.has(address.elementId))
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
    );
}

interface FrameProps {
  content: DesignContent;
  frames: DesignElement[];
  id: string;
  interactive: boolean;
  instance?: number;
  surfaceId: string;
  annotating: boolean;
  anyPosition: boolean;
  hotspots: boolean;
  next: string[];
  annotations: Annotation[];
  artifactId?: string;
  canAnnotate: boolean;
  pointer: Pointer;
  chooseAnchor: (address: ElementAddress) => void;
  activate: (key: string) => void;
}
/** One visible frame with its hotspots and pins; only the top layer is interactive. */
function PrototypeFrame(props: FrameProps) {
  const { content, id, interactive, instance = 0, annotating, artifactId } = props;
  const f = props.frames.find((f) => f.id === id);
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
        props.pointer.current = e.pointerType === 'touch' ? 'tap' : 'click';
      }}
      onClick={(e) => {
        if (!interactive || !annotating || !props.canAnnotate) return;
        const matrix = e.currentTarget.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
        if (point.x < b.x || point.y < b.y || point.x > b.x + b.width || point.y > b.y + b.height)
          return;
        props.chooseAnchor({
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
              ? !props.anyPosition && (t.elementId !== id || t.partIds.length)
              : t.interactions.length,
          )
          .map((t, i) => {
            const hint = !annotating && props.next.includes(t.key);
            return (
              <PrototypeHotspot
                key={t.key}
                target={t}
                prefix={`prototype-${props.surfaceId}-${instance}-${i}`}
                hint={hint}
                visible={annotating || props.hotspots || hint}
                annotating={annotating}
                pointer={props.pointer}
                activate={() => {
                  if (annotating && props.canAnnotate)
                    props.chooseAnchor(designPrototypeAddress(artifactId!, t));
                  else props.activate(t.key);
                }}
              />
            );
          })}
      <AnnotationPins
        content={content}
        annotations={props.annotations}
        artifactId={artifactId}
        included={included}
      />
    </svg>
  );
}

function PrototypeToolbar({
  content,
  frames,
  state,
  startingFrame,
  hotspots,
  setHotspots,
  canAnnotate,
  annotating,
  setAnnotating,
  anyPosition,
  setAnyPosition,
  restart,
  back,
  onClose,
}: {
  content: DesignContent;
  frames: DesignElement[];
  state?: DesignPrototypeState;
  startingFrame?: string;
  hotspots: boolean;
  setHotspots: (value: boolean) => void;
  canAnnotate: boolean;
  annotating: boolean;
  setAnnotating: (value: boolean) => void;
  anyPosition: boolean;
  setAnyPosition: (value: boolean) => void;
  restart: (options: { frameId?: string; flowId?: string }) => void;
  back: () => void;
  onClose?: () => void;
}) {
  return (
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
      <button disabled={!state?.history.length} onClick={back}>
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
            checked={anyPosition}
            onChange={(e) => setAnyPosition(e.target.checked)}
          />
          Annotate any position
        </label>
      )}
      {onClose && <button onClick={onClose}>Exit prototype</button>}
    </div>
  );
}

function FlowStatus({
  flow,
  state,
  frames,
}: {
  flow: Flow;
  state?: DesignPrototypeState;
  frames: DesignElement[];
}) {
  const index = state?.flowIndex ?? 0;
  const nextId = flow.frameIds[index + 1];
  return (
    <p role="status" style={{ margin: '4px 12px' }}>
      {flow.name}: {state?.completed ? 'Completed' : `Step ${index + 1} / ${flow.frameIds.length}`}
      {!state?.completed && nextId
        ? ` · Next: ${frames.find((f) => f.id === nextId)?.name ?? nextId}`
        : ''}
    </p>
  );
}

function PrototypeCommentForm({
  comment,
  setComment,
  pending,
  submittable,
  available,
  submit,
}: {
  comment: string;
  setComment: (comment: string) => void;
  pending: boolean;
  submittable: boolean;
  available: boolean;
  submit: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ padding: 8 }}
    >
      {!available && <p>Comment submission unavailable. Your draft is retained.</p>}
      <label>
        Prototype comment{' '}
        <input
          aria-label="Prototype comment"
          value={comment}
          disabled={pending}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <button disabled={!submittable}>Add prototype comment</button>
    </form>
  );
}

function PrototypeDiagnostics({ diagnostics }: { diagnostics: DesignPrototypeDiagnostic[] }) {
  return (
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
  );
}

const overlayBackdrop = {
  position: 'absolute',
  inset: 0,
  background: '#0008',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
} as const;
function PrototypeOverlay({
  frame,
  id,
  top,
  children,
}: {
  frame?: DesignElement;
  id: string;
  top: boolean;
  children: ReactNode;
}) {
  return (
    <div style={overlayBackdrop}>
      <div
        role="dialog"
        aria-hidden={!top}
        aria-label={`Overlay ${frame?.name ?? id}`}
        style={{
          width: frame?.bounds.width ?? 400,
          maxWidth: '100%',
          height: frame?.bounds.height ?? 300,
          maxHeight: '85%',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Undo/redo never reaches the editor behind the prototype; Escape closes the top overlay. */
function prototypeKeyDown(e: KeyboardEvent, closeOverlay: (() => void) | undefined) {
  if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
    if (!isTextInput(e.target)) e.preventDefault();
    e.stopPropagation();
  }
  if (e.key === 'Escape' && closeOverlay) {
    e.preventDefault();
    e.stopPropagation();
    closeOverlay();
  }
}

const surfaceStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  color: '#172334',
  background: '#f3f5f8',
  fontFamily: 'system-ui, sans-serif',
} as const;
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
  const frames = designPaintOrder(content).filter((e) => e.type === 'frame' && !e.hidden);
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
  const submittable = !commentPending && !!onCreateAnnotation && !!anchor && !!comment.trim();
  const submitComment = () => {
    if (!submittable) return;
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
  };
  const frameProps = {
    content,
    frames,
    surfaceId,
    annotating,
    anyPosition: position,
    hotspots,
    next,
    annotations,
    artifactId,
    canAnnotate,
    pointer,
    chooseAnchor,
    activate: (key: string) => {
      if (state) perform(() => activateDesignPrototype(content, state, key, pointer.current));
    },
  };
  return (
    <section
      aria-label="Design prototype"
      onKeyDown={(e) =>
        prototypeKeyDown(
          e,
          state?.overlays.length
            ? () =>
                perform(() => applyDesignPrototypeAction(content, state, { type: 'close-overlay' }))
            : undefined,
        )
      }
      style={surfaceStyle}
    >
      <style>{`.design-prototype-stage [role=button]:focus-visible rect { stroke: #172334; stroke-width: 3; } .design-prototype-stage [role=button]:hover rect { fill: #2563eb22; }`}</style>
      <PrototypeToolbar
        content={content}
        frames={frames}
        state={state}
        startingFrame={startingFrame}
        hotspots={hotspots}
        setHotspots={setHotspots}
        canAnnotate={canAnnotate}
        annotating={annotating}
        setAnnotating={setAnnotating}
        anyPosition={position}
        setAnyPosition={setPosition}
        restart={restart}
        back={() =>
          state && perform(() => applyDesignPrototypeAction(content, state, { type: 'back' }))
        }
        onClose={onClose}
      />
      <h2 ref={focusFrame} tabIndex={-1} style={{ margin: '4px 12px', fontSize: 18 }}>
        {current?.name ?? 'No prototype frame'}
      </h2>
      {flow && <FlowStatus flow={flow} state={state} frames={frames} />}
      {error && <p role="alert">{error}</p>}
      {annotating && (onCreateAnnotation || comment) && (
        <PrototypeCommentForm
          comment={comment}
          setComment={setComment}
          pending={commentPending}
          submittable={submittable}
          available={!!onCreateAnnotation}
          submit={submitComment}
        />
      )}
      {diagnostics.length > 0 && <PrototypeDiagnostics diagnostics={diagnostics} />}
      <div
        ref={stage}
        className="design-prototype-stage"
        style={{ position: 'relative', flex: 1, minHeight: 180, overflow: 'hidden', padding: 8 }}
      >
        {state && (
          <PrototypeFrame
            key={state.frameId}
            {...frameProps}
            id={state.frameId}
            interactive={!state.overlays.length}
          />
        )}
        {state?.overlays.map((id, index) => {
          const top = index === state.overlays.length - 1;
          return (
            <PrototypeOverlay
              key={`${id}-${index}`}
              frame={frames.find((f) => f.id === id)}
              id={id}
              top={top}
            >
              <PrototypeFrame
                key={id}
                {...frameProps}
                id={id}
                interactive={top}
                instance={index + 1}
              />
            </PrototypeOverlay>
          );
        })}
      </div>
    </section>
  );
}
