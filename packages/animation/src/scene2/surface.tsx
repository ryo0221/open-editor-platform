import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import type { EditorInputs } from '@editor-platform/editor-core';
import { CanvasTextContext, type CanvasTextBridge } from '@editor-platform/canvas-ui';
import {
  animationCommand2,
  animationLayerLocked2,
  animationLayerPaintOrder2,
  createAnimationLayer2,
  duplicateAnimationSelection2,
  frameStep2,
  groupAnimationLayers2,
  inspectAnimationSelection2,
  nestAnimationLayers2,
  prepareAnimation2,
  unnestAnimationLayer2,
  type AnimationAction2,
  type AnimationCommand2,
  type AnimationContent2,
  type AnimationInputValues2,
  type Property2,
} from '@editor-platform/animation-core/v2';
import {
  planAnimationFrame2,
  type AnimationFramePlan2,
} from '@editor-platform/animation-player/v2';
import { useAnimationPlayer2 } from './use-player';
import {
  animationStageDragActions2,
  animationStageDragLayers2,
  selectedAnimationStageAncestor2,
} from './stage-drag';
import { AnimationFrameExport2 } from './frame-export';
import {
  addAnimationKeys2,
  deleteAnimationKeys2,
  copyAnimationKeys2,
  pasteAnimationKeys2,
  type KeySelection2,
  type CopiedAnimationKeys2,
} from './keyframe-commands';
import { AnimationInspector2 } from './inspector';
import { AnimationSourceControls2 } from './source-controls';
import { AnimationSurfaceHeader2, AnimationTimingControls2 } from './surface-toolbar';
import {
  AnimationTextOverlay2,
  useAnimationDragPreview2,
  type AnimationStageDrag2,
  type AnimationTextEditing2,
} from './surface-stage';
import {
  AnimationLayerActions2,
  AnimationLayerList2,
  AnimationRemovalConfirmation2,
  type AnimationRemovalPlan2,
} from './surface-layers';
import {
  AnimationKeyActions2,
  AnimationPlayhead2,
  AnimationTrackRails2,
  AnimationTrackTimeline2,
  type AnimationKeyGesture2,
} from './surface-timeline';
import '../controlled.css';
import './style.css';
export interface AnimationSurfaceProps2 {
  beforeCapture?(): void;
  canExport?(): boolean;
  select?(ids: readonly string[], compositionId: string): void;
  focusId?: string;
  sources?: readonly import('@editor-platform/animation-core/v2').AnimationEmbed2[];
  library?: import('react').ReactNode;
  content: AnimationContent2;
  inputs: EditorInputs;
  readOnly: boolean;
  read?(): AnimationContent2;
  execute(command: AnimationCommand2): boolean | void;
  history?(direction: 'undo' | 'redo'): void;
  textBridge?(id: string): CanvasTextBridge;
  onError?(error: unknown): void;
}
type Drag = AnimationStageDrag2;
export function AnimationSurface2(props: AnimationSurfaceProps2) {
  const previewPrefix = 'animation-drag-' + useId().replace(/[^A-Za-z0-9-]/g, '-');
  const latest = useRef(props);
  latest.current = props;
  const read = () => latest.current.read?.() ?? latest.current.content;
  const [compositionId, setCompositionId] = useState(props.content.rootCompositionId),
    [selection, setSelection] = useState<string[]>([]),
    [tick, setTick] = useState(0),
    [playing, setPlaying] = useState(false),
    [ready, setReady] = useState(false),
    [message, setMessage] = useState(''),
    [trackProperty, setTrackProperty] = useState<Property2>('x'),
    [keySelection, setKeySelection] = useState<KeySelection2[]>([]),
    [loop, setLoop] = useState(false),
    [rate, setRate] = useState(1),
    [snap, setSnap] = useState(true),
    [workArea, setWorkArea] = useState<{ start: number; end: number } | undefined>(undefined),
    [moveFrames, setMoveFrames] = useState('1'),
    [clipboard, setClipboard] = useState<CopiedAnimationKeys2 | null>(null),
    [removal, setRemoval] = useState<AnimationRemovalPlan2 | null>(null),
    [editing, setEditing] = useState<AnimationTextEditing2 | null>(null),
    [drag, setDrag] = useState<Drag | null>(null),
    [values, setValues] = useState<AnimationInputValues2>([]),
    [exportPlan, setExportPlan] = useState<AnimationFramePlan2 | null>(null);
  const c =
    props.content.compositions.find((c) => c.id === compositionId) ??
    props.content.compositions.find((c) => c.id === props.content.rootCompositionId)!;
  const layer = c.layers.find((l) => l.id === selection[0]),
    step = frameStep2(c),
    activeWorkArea = workArea && workArea.end <= c.duration ? workArea : undefined,
    source = useMemo(() => prepareAnimation2(props.content), [props.content]);
  useEffect(() => {
    setWorkArea((old) => (old && old.end > c.duration ? undefined : old));
  }, [c.duration]);
  const stage = useRef<HTMLDivElement>(null),
    tickRef = useRef(tick),
    rateRef = useRef(rate),
    dragRef = useRef<Drag | null>(null),
    focusWanted = useRef<string | null>(null),
    addButton = useRef<HTMLButtonElement>(null),
    keyGesture = useRef<AnimationKeyGesture2 | null>(null),
    root = useRef<HTMLElement>(null);
  tickRef.current = tick;
  rateRef.current = rate;
  dragRef.current = drag;
  const state = useSyncExternalStore(
      props.inputs.subscribe,
      props.inputs.getSnapshot,
      props.inputs.getSnapshot,
    ),
    pending = !!(state.dirty || state.composing),
    disabled = props.readOnly || pending;
  const scope = { canEdit: () => !!root.current?.isConnected && !latest.current.readOnly };
  const currentKey = keySelection.length === 1 ? keySelection[0] : undefined;
  const activeTrack = c.tracks.find((track) => track.id === keySelection[0]?.trackId);
  const report = (text: string) => setMessage(text);
  useEffect(
    () =>
      props.inputs.register({
        label: 'Animation move',
        read: () => ({ dirty: false, composing: !!dragRef.current || !!keyGesture.current }),
        prepare: () => {
          throw Error('Finish or cancel the move');
        },
        focus: () => stage.current?.focus(),
      }),
    [props.inputs],
  );
  const playbackInputs = useMemo(
    () =>
      values.filter((value) =>
        props.content.publicInputs.some((input) => input.id === value.inputId),
      ),
    [values, props.content.publicInputs],
  );
  const player = useAnimationPlayer2(stage, {
    source,
    compositionId: c.id,
    label: 'Animation 2D stage',
    inputs: playbackInputs,
    loop,
    workArea: activeWorkArea,
    initialTick: () => Math.min(tickRef.current, c.duration),
    onPreparing: () => setReady(false),
    onTick: (t, p) => {
      tickRef.current = t;
      setTick(t);
      setPlaying(p);
    },
    onError: (error) => {
      setMessage(String(error));
      setReady(false);
      setPlaying(false);
    },
    onInputError: (error) => setMessage(String(error)),
    onInputsApplied: () => setMessage(''),
    onReady: (p) => {
      tickRef.current = p.tick;
      setTick(p.tick);
      p.setRate(rateRef.current);
      setReady(true);
      setMessage('');
    },
  });
  useEffect(() => {
    setValues((old) => {
      const retained = old.filter((value) =>
        props.content.publicInputs.some((input) => input.id === value.inputId),
      );
      return retained.length === old.length ? old : retained;
    });
  }, [props.content.publicInputs]);
  useEffect(() => {
    try {
      player.current?.setRate(rate);
    } catch (error) {
      report(String(error));
    }
  }, [rate]);
  useEffect(() => {
    if (props.readOnly && dragRef.current) {
      dragRef.current = null;
      setDrag(null);
      props.inputs.changed();
    }
  }, [props.readOnly, props.inputs]);
  useEffect(() => {
    const current = dragRef.current;
    if (
      keyGesture.current &&
      canonicalJson(keyGesture.current.base) !== canonicalJson(props.content)
    ) {
      keyGesture.current = null;
      props.inputs.changed();
    }
    if (current && canonicalJson(current.base) !== canonicalJson(props.content)) {
      dragRef.current = null;
      setDrag(null);
      props.inputs.changed();
      report('Animation changed; move cancelled');
    }
  }, [props.content]);
  useAnimationDragPreview2(stage, drag, {
    compositionId: c.id,
    tick,
    values,
    scope,
    prefix: previewPrefix,
    report,
  });
  useEffect(() => {
    const id = focusWanted.current;
    if (id === null) return;
    focusWanted.current = null;
    if (id)
      root.current?.querySelector<HTMLButtonElement>(`[data-layer-id="${id}"] button`)?.focus();
    else addButton.current?.focus();
  }, [selection]);
  function run(make: (current: AnimationContent2) => AnimationCommand2): boolean {
    try {
      if (latest.current.readOnly) throw Error('Read only');
      latest.current.inputs.flush();
      player.current?.pause();
      const command = make(read());
      if (latest.current.execute(command) === false)
        throw Error('Animation edit refused; inputs are retained');
      setMessage('Applied');
      return true;
    } catch (error) {
      setMessage(String(error));
      return false;
    }
  }
  function actions(values: AnimationAction2[], label = 'Edit Animation') {
    return run((content) => animationCommand2(content, values, scope, label));
  }
  function choose(ids: string[], focus = false) {
    if (pending) {
      report('Apply or cancel pending inputs first');
      return;
    }
    if (focus) focusWanted.current = ids[0] ?? '';
    setSelection(ids);
    latest.current.select?.(ids, c.id);
    setKeySelection([]);
    setRemoval(null);
  }
  const lastFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.focusId || lastFocus.current === props.focusId || pending) return;
    const target = props.content.compositions.find(
      (comp) =>
        comp.id === props.focusId || comp.layers.some((layer) => layer.id === props.focusId),
    );
    if (!target) return;
    lastFocus.current = props.focusId;
    setCompositionId(target.id);
    setSelection(target.id === props.focusId ? [] : [props.focusId]);
    setKeySelection([]);
    setWorkArea(undefined);
    setTick(0);
    tickRef.current = 0;
    focusWanted.current = target.id === props.focusId ? '' : props.focusId;
  }, [props.focusId, props.content, pending]);
  function add(type: 'rect' | 'path' | 'text' | 'group') {
    const id = crypto.randomUUID();
    if (
      run((content) =>
        animationCommand2(
          content,
          [
            {
              type: 'layer.insert',
              compositionId: c.id,
              layer: createAnimationLayer2(type, id, c.duration),
            },
          ],
          scope,
          'Add ' + type,
        ),
      )
    )
      choose([id], true);
  }
  function duplicate() {
    let selected: string[] = [];
    const ok = run((content) => {
      const plan = inspectAnimationSelection2(content, c.id, selection),
        mapping = [...plan.layers, ...plan.tracks, ...plan.keys, ...plan.inputs].map(
          (sourceId) => ({ sourceId, id: crypto.randomUUID() }),
        );
      const command = duplicateAnimationSelection2(content, c.id, selection, mapping, scope);
      selected = plan.roots.map((id) => mapping.find((m) => m.sourceId === id)!.id);
      return command;
    });
    if (ok) choose(selected, true);
  }
  function reviewDelete() {
    if (disabled || !selection.length) return;
    try {
      const content = structuredClone(read()),
        plan = inspectAnimationSelection2(content, c.id, selection);
      animationCommand2(
        content,
        plan.roots.map((id) => ({ type: 'layer.remove', compositionId: c.id, id })),
        scope,
      );
      setRemoval({
        tracks: plan.tracks.length,
        keys: plan.keys.length,
        inputs: plan.inputs.length,
        base: content,
        ids: plan.roots,
        names: content.compositions
          .find((n) => n.id === c.id)!
          .layers.filter((l) => plan.layers.includes(l.id))
          .map((l) => l.name),
      });
    } catch (error) {
      report(String(error));
    }
  }
  function seek(value: number) {
    if (pending || !ready) return;
    try {
      player.current?.pause();
      player.current?.seek(Math.max(0, Math.min(c.duration, value)));
    } catch (error) {
      report(String(error));
    }
  }
  function addKey() {
    if (!layer) return;
    const time = Math.min(c.duration, snap ? Math.round(tick / step) * step : tick);
    let next: KeySelection2[] = [];
    if (
      run((content) => {
        const result = addAnimationKeys2(
          content,
          c.id,
          selection,
          trackProperty,
          time,
          values,
          scope,
        );
        next = result.selection;
        return result.command;
      })
    )
      setKeySelection(next);
  }
  function deleteKeys() {
    if (run((content) => deleteAnimationKeys2(content, c.id, keySelection, scope)))
      setKeySelection([]);
  }
  function copyKeys() {
    setClipboard(copyAnimationKeys2(c.tracks, keySelection));
    report('Keys copied. Paste at the playhead.');
  }
  function pasteKeys() {
    run((content) => pasteAnimationKeys2(content, c.id, clipboard, tick, scope));
  }
  function reorder(direction: -1 | 1) {
    if (selection.length !== 1) return;
    const order = animationLayerPaintOrder2(c, selection[0], direction);
    if (!order) return;
    actions([{ type: 'layer.reorder', compositionId: c.id, ids: order }], 'Reorder layers');
  }
  function toggle(property: 'visible' | 'locked' | 'maskOnly') {
    if (!layer) return;
    actions([
      {
        type: 'layer.patch',
        compositionId: c.id,
        id: layer.id,
        patch: { [property]: !layer[property] },
      },
    ]);
  }
  function textEdit() {
    if (!layer || layer.type !== 'text' || props.readOnly || animationLayerLocked2(c, layer.id))
      return;
    if (
      c.tracks.some((t) => t.layerId === layer.id && t.property === 'text') ||
      props.content.publicInputs.some(
        (i) => i.target.layerId === layer.id && i.target.property === 'text',
      )
    ) {
      report('Edit the text key or public input that controls this layer.');
      return;
    }
    try {
      props.inputs.flush();
      const current = read()
        .compositions.find((n) => n.id === c.id)!
        .layers.find((l) => l.id === layer.id);
      if (current?.type === 'text')
        setEditing({
          compositionId: c.id,
          id: current.id,
          text: current.text,
          runs: structuredClone(current.runs),
        });
    } catch (error) {
      report(String(error));
    }
  }
  function point(event: { clientX: number; clientY: number }) {
    const svg = stage.current?.querySelector('svg'),
      matrix = svg?.getScreenCTM();
    if (!matrix) throw Error('Stage unavailable');
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }
  function beginDrag(event: React.PointerEvent) {
    if (event.button !== 0 || editing) return;
    const item = (event.target as Element).closest('[data-instance]');
    if (!item) return;
    const address = JSON.parse(item.getAttribute('data-instance')!) as string[],
      id = selectedAnimationStageAncestor2(c, selection, address[1]) ?? address[1];
    const selected = event.shiftKey
      ? [...new Set([...selection, id])]
      : selection.includes(id)
        ? selection
        : [id];
    choose(selected);
    if (disabled) return;
    try {
      player.current?.pause();
      const base = structuredClone(read()),
        layers = animationStageDragLayers2(base, c.id, selected, tick, values);
      const next = {
        base,
        pointer: event.pointerId,
        start: point(event),
        delta: { x: 0, y: 0 },
        layers,
      };
      dragRef.current = next;
      setDrag(next);
      props.inputs.changed();
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      report(String(error));
    }
  }
  function cancelDrag() {
    dragRef.current = null;
    setDrag(null);
    props.inputs.changed();
  }
  function togglePlay() {
    const p = player.current!;
    if (p.playing) p.pause();
    else {
      p.play();
      setPlaying(true);
    }
  }
  function openComposition(id: string) {
    setCompositionId(id);
    setWorkArea(undefined);
    setSelection([]);
    latest.current.select?.([], id);
    setKeySelection([]);
    setTick(0);
    tickRef.current = 0;
    setRemoval(null);
  }
  function exportFrame() {
    try {
      latest.current.inputs.flush();
      latest.current.beforeCapture?.();
      if (latest.current.canExport?.() === false)
        throw Error('Resolve pending changes before export');
      const content = read();
      setExportPlan(
        planAnimationFrame2(
          prepareAnimation2(content),
          c.id,
          Math.min(
            tickRef.current,
            content.compositions.find((comp) => comp.id === c.id)!.duration,
          ),
          values,
        ),
      );
    } catch (error) {
      report(String(error));
    }
  }
  function keyDown(event: React.KeyboardEvent) {
    const target = event.target as Element;
    if (target.closest('input,textarea,select,[contenteditable="true"],button')) return;
    if (event.key === 'Escape') {
      cancelDrag();
      setRemoval(null);
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      if (!pending && ready) togglePlay();
    }
    if (event.key === 'Delete') {
      event.preventDefault();
      reviewDelete();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      if (!disabled && selection.length) duplicate();
    }
  }
  function group() {
    const id = crypto.randomUUID();
    if (run((content) => groupAnimationLayers2(content, c.id, selection, id, scope)))
      choose([id], true);
  }
  function nest() {
    const ids = { compositionId: crypto.randomUUID(), layerId: crypto.randomUUID() };
    if (run((content) => nestAnimationLayers2(content, c.id, selection, ids, scope)))
      choose([ids.layerId], true);
  }
  function unnest() {
    if (layer?.type !== 'composition' || layer.source.type !== 'local') return;
    const childId = layer.source.compositionId;
    const roots = props.content.compositions
      .find((comp) => comp.id === childId)!
      .layers.filter((layer) => !layer.parentId)
      .map((layer) => layer.id);
    if (run((content) => unnestAnimationLayer2(content, c.id, layer.id, scope)))
      choose(roots, true);
  }
  function confirmRemoval(plan: AnimationRemovalPlan2) {
    if (
      run(() =>
        animationCommand2(
          plan.base,
          plan.ids.map((id) => ({ type: 'layer.remove', compositionId: c.id, id })),
          scope,
          'Delete Animation layers',
        ),
      )
    ) {
      setRemoval(null);
      choose([], true);
    }
  }
  const textLayer =
    editing?.compositionId === c.id ? c.layers.find((l) => l.id === editing.id) : undefined;
  useEffect(() => {
    // Content/focus changes can unmount the native editor without its onCancel.
    // Only a lost owner closes it; live text conflicts keep the existing guard/buffer.
    if (editing && textLayer?.type !== 'text') setEditing(null);
  }, [editing, textLayer]);
  const textStale =
    !!editing &&
    (!textLayer ||
      textLayer.type !== 'text' ||
      textLayer.text !== editing.text ||
      canonicalJson(textLayer.runs) !== canonicalJson(editing.runs));
  const planStale = removal && canonicalJson(props.content) !== canonicalJson(removal.base);
  return (
    <EditorInputsContext.Provider value={props.inputs}>
      <CanvasTextContext.Provider value={props.textBridge}>
        <section
          ref={root}
          className="animation2"
          aria-label="Animation 2D editor"
          onKeyDown={keyDown}
        >
          <AnimationSurfaceHeader2
            content={props.content}
            compositionId={c.id}
            disabled={disabled}
            pending={pending}
            ready={ready}
            playing={playing}
            loop={loop}
            rate={rate}
            exportDisabled={pending || props.canExport?.() === false}
            addButton={addButton}
            onAdd={add}
            onComposition={openComposition}
            onTogglePlay={togglePlay}
            onLoop={setLoop}
            onRate={setRate}
            onExport={exportFrame}
          />
          <AnimationTimingControls2
            content={props.content}
            compositionId={c.id}
            duration={c.duration}
            step={step}
            workArea={activeWorkArea}
            inputs={props.inputs}
            readOnly={props.readOnly}
            canEdit={scope.canEdit}
            execute={(command) => latest.current.execute(command)}
            onWorkArea={setWorkArea}
          />
          <div className="a2-workspace">
            <AnimationLayerList2
              composition={c}
              selection={selection}
              pending={pending}
              onSelect={choose}
            />
            <div className="a2-center">
              <div
                ref={stage}
                className="a2-stage"
                tabIndex={0}
                aria-label="Animation stage"
                onPointerDown={beginDrag}
                onDoubleClick={() => textEdit()}
                onPointerMove={(event) => {
                  const d = dragRef.current;
                  if (!d || d.pointer !== event.pointerId) return;
                  const p = point(event),
                    next = { ...d, delta: { x: p.x - d.start.x, y: p.y - d.start.y } };
                  dragRef.current = next;
                  setDrag(next);
                }}
                onPointerUp={(event) => {
                  const d = dragRef.current;
                  if (!d || d.pointer !== event.pointerId) return;
                  cancelDrag();
                  if (!d.delta.x && !d.delta.y) return;
                  run(() =>
                    animationCommand2(
                      d.base,
                      animationStageDragActions2(c.id, d.layers, d.delta),
                      scope,
                      'Move Animation layers',
                    ),
                  );
                }}
                onPointerCancel={cancelDrag}
              >
                {!ready && <p role="status">Preparing animation resources…</p>}
                {drag && (
                  <div className="a2-drag-preview" role="status">
                    Move preview: {drag.delta.x.toFixed(1)}, {drag.delta.y.toFixed(1)}
                    <button onClick={cancelDrag}>Cancel move</button>
                  </div>
                )}
                {editing && textLayer?.type === 'text' && (
                  <AnimationTextOverlay2
                    content={props.content}
                    composition={c}
                    editing={editing}
                    layer={textLayer}
                    readOnly={props.readOnly}
                    showStale={props.textBridge ? false : textStale}
                    stale={textStale}
                    scope={scope}
                    read={read}
                    beforeCommit={() => player.current?.pause()}
                    execute={(command) => latest.current.execute(command)}
                    report={report}
                    onClose={() => setEditing(null)}
                  />
                )}
              </div>
              <AnimationPlayhead2
                duration={c.duration}
                step={step}
                tick={tick}
                snap={snap}
                pending={pending}
                ready={ready}
                onSeek={seek}
                onSnap={setSnap}
              />
            </div>
            <aside aria-label="Animation inspector">
              <AnimationInspector2
                key={`${c.id}/${selection[0] ?? ''}`}
                content={props.content}
                compositionId={c.id}
                layerId={selection[0] ?? ''}
                trackId={currentKey?.trackId}
                keyId={currentKey?.keyId}
                read={read}
                inputs={props.inputs}
                readOnly={props.readOnly}
                execute={(command) => latest.current.execute(command)}
                report={report}
                editText={textEdit}
              />
            </aside>
          </div>
          <AnimationLayerActions2
            composition={c}
            layer={layer}
            selectionCount={selection.length}
            disabled={disabled}
            onDuplicate={duplicate}
            onReviewDelete={reviewDelete}
            onReorder={reorder}
            onToggle={toggle}
            onGroup={group}
            onNest={nest}
            onUnnest={unnest}
            actions={actions}
          />
          {removal && (
            <AnimationRemovalConfirmation2
              removal={removal}
              stale={!!planStale}
              disabled={disabled}
              onConfirm={() => confirmRemoval(removal)}
              onCancel={() => setRemoval(null)}
            />
          )}
          <section className="a2-timeline" aria-label="Animation timeline">
            <h3>Timeline</h3>
            <AnimationKeyActions2
              compositionId={c.id}
              step={step}
              trackProperty={trackProperty}
              keySelection={keySelection}
              moveFrames={moveFrames}
              disabled={disabled}
              pending={pending}
              hasSelection={!!selection.length}
              hasClipboard={!!clipboard}
              onTrackProperty={setTrackProperty}
              onAddKey={addKey}
              onDeleteKeys={deleteKeys}
              onCopyKeys={copyKeys}
              onPasteKeys={pasteKeys}
              onMoveFrames={setMoveFrames}
              report={report}
              actions={actions}
            />
            {activeTrack && (
              <AnimationTrackTimeline2
                key={activeTrack.id}
                track={activeTrack}
                basis={source.contentHash}
                compositionId={c.id}
                duration={c.duration}
                tick={tick}
                step={step}
                snap={snap}
                keySelection={keySelection}
                readOnly={props.readOnly}
                pending={pending}
                disabled={disabled}
                gesture={keyGesture}
                inputs={props.inputs}
                scope={scope}
                read={read}
                seek={seek}
                report={report}
                run={run}
                selectLayer={(layerId) => {
                  setSelection([layerId]);
                  latest.current.select?.([layerId], c.id);
                }}
                onKeySelection={setKeySelection}
              />
            )}
            <AnimationTrackRails2
              composition={c}
              step={step}
              keySelection={keySelection}
              pending={pending}
              onSelectKey={(layerId, keys) => {
                choose([layerId]);
                setKeySelection(keys);
              }}
            />
          </section>
          <AnimationSourceControls2
            sources={props.sources}
            inputs={props.inputs}
            canEdit={() => !!root.current?.isConnected && !latest.current.readOnly}
            content={props.content}
            compositionId={c.id}
            layer={layer}
            disabled={disabled}
            read={read}
            apply={run}
            select={(id) => choose(id ? [id] : [])}
            report={report}
            previewInputs={values}
            preview={setValues}
          />
          {props.library}
          {exportPlan && (
            <AnimationFrameExport2
              key={exportPlan.planHash}
              plan={exportPlan}
              frameStep={step}
              canRead={() => !!root.current?.isConnected && latest.current.canExport?.() !== false}
              close={() => setExportPlan(null)}
              report={report}
            />
          )}
          {message && <p role="status">{message}</p>}
        </section>
      </CanvasTextContext.Provider>
    </EditorInputsContext.Provider>
  );
}
