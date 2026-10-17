import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  identityTransform,
  frameTickV1,
  readAnimationV1,
  putRectangleLayerV1,
  replaceTrack,
  removeAnimationTrackV1,
  type AnimationContent,
} from '@editor-platform/animation-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import type { AnimationControlledSurfaceProps } from '@editor-platform/animation/controlled-contract';
import type {
  ControlledSurfaceSnapshot,
  SurfaceOperation,
  AtomicSurfaceInputs,
} from '@editor-platform/extension-contract/controlled-surface';
import {
  controlledProperties,
  AnimationInputFieldError,
  hasDraft,
  prepareAnimationInputs,
  type AnimationInputDraft,
  type ControlledProperty,
} from './controlled-buffer';
import { KeyTimeline } from './controlled-timeline';
import { ControlledEasing } from './controlled-easing';
import './controlled.css';
type OpenView = Extract<ControlledSurfaceSnapshot<AnimationContent>, { state: 'open' }>;
export function AnimationControlledSurface({ editor, playback }: AnimationControlledSurfaceProps) {
  const view = useSyncExternalStore(
    useCallback((listener) => editor.subscribe(listener), [editor]),
    useCallback(() => editor.getSnapshot(), [editor]),
    useCallback(() => editor.getSnapshot(), [editor]),
  );
  if (view.state === 'revoked')
    return (
      <section className="animation-controlled" role="status">
        Animation scope revoked
      </section>
    );
  try {
    readAnimationV1(view.snapshot.content);
  } catch (error) {
    return (
      <section className="animation-controlled" role="status">
        Unsupported Animation content: {String(error)}
      </section>
    );
  }
  return (
    <OpenSurface
      key={`${view.snapshot.scope.artifactId}/${view.snapshot.scope.sessionId}/${view.snapshot.scope.generation}`}
      editor={editor}
      playback={playback}
      view={view}
    />
  );
}
function OpenSurface({
  editor,
  playback,
  view,
}: AnimationControlledSurfaceProps & { view: OpenView }) {
  const native = readAnimationV1(view.snapshot.content),
    player = useSyncExternalStore(
      useCallback((listener) => playback.subscribe(listener), [playback]),
      useCallback(() => playback.getSnapshot(), [playback]),
      useCallback(() => playback.getSnapshot(), [playback]),
    );
  const [layerId, setLayerId] = useState(''),
    [property, setProperty] = useState<ControlledProperty>('x'),
    [keyId, setKeyId] = useState<string | null>(null),
    [message, setMessage] = useState('Controlled Animation — Host owns history and save'),
    [inputProblem, setInputProblem] = useState<{ field?: string; message: string } | null>(null);
  const inputErrorId = useId();
  const [, render] = useState(0),
    draft = useRef<AnimationInputDraft | null>(null),
    registration = useRef<ReturnType<typeof editor.bindInputs> | null>(null),
    stage = useRef<HTMLDivElement>(null),
    form = useRef<HTMLDivElement>(null),
    alive = useRef(true);
  const composition =
    native.compositions.find((c) => c.id === player.compositionId) ??
    native.compositions.find((c) => c.id === native.rootCompositionId)!;
  const layer =
      composition.layers.find((l) => l.id === layerId) ??
      (!layerId ? composition.layers[0] : undefined),
    track = composition.tracks.find((t) => t.layerId === layer?.id && t.property === property),
    key = track?.keys.find((k) => k.id === keyId);
  const pending = hasDraft(draft.current),
    moving = !!draft.current?.composing.has('timeline'),
    canEdit = view.canEdit && !view.saving;
  const notify = () => {
    registration.current?.changed();
    render((n) => n + 1);
  };
  const liveEdit = () => {
    const v = editor.getSnapshot();
    return v.state === 'open' && v.canEdit && !v.saving;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => playback.attach(stage.current!), [playback]);
  useEffect(() => {
    if (!view.canEdit) return;
    const group: AtomicSurfaceInputs<AnimationContent> = {
      label: 'Animation inputs',
      read: () => ({
        dirty:
          !!draft.current &&
          (Object.keys(draft.current.transform).length > 0 || !!draft.current.key),
        composing: !!draft.current?.composing.size,
      }),
      prepare: (snapshot) => {
        if (draft.current?.composing.has('timeline'))
          throw new Error('Finish or cancel the key move before applying or saving');
        return prepareAnimationInputs(draft.current, snapshot, () => {
          const v = editor.getSnapshot();
          return v.state === 'open' && v.canEdit;
        });
      },
      committed: () => {
        draft.current = null;
        setInputProblem(null);
        render((n) => n + 1);
      },
      focus: focusInputFailure,
    };
    const binding = editor.bindInputs(group);
    registration.current = binding;
    return () => {
      registration.current = null;
      binding.unregister();
    };
  }, [editor, view.canEdit]);
  function focusInputFailure() {
    const d = draft.current,
      current = editor.getSnapshot();
    if (!d || current.state !== 'open' || !current.canEdit || !form.current) return;
    let problem: { field?: string; message: string } | null = null;
    const composingField = [...d.composing].find((id) => id !== 'timeline');
    if (composingField) {
      const input = [
        ...form.current.querySelectorAll<HTMLInputElement>('input[data-input-field]'),
      ].find((el) => el.dataset.inputField === composingField);
      problem = {
        field: composingField,
        message: `${input?.getAttribute('aria-label') ?? composingField}: finish IME composition before applying or saving`,
      };
    } else if (d.composing.has('timeline')) return;
    else {
      try {
        prepareAnimationInputs(d, current.snapshot, () => current.canEdit);
      } catch (error) {
        problem = {
          field: error instanceof AnimationInputFieldError ? error.field : undefined,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (!problem) return;
    setInputProblem(problem);
    const input = [
      ...form.current.querySelectorAll<HTMLInputElement>('input[data-input-field]'),
    ].find((el) => el.dataset.inputField === problem.field);
    input?.focus();
  }
  function report(result: SurfaceOperation) {
    setMessage(result.state === 'refused' ? `${result.code}: ${result.message}` : result.state);
    if (result.state === 'refused') focusInputFailure();
  }
  function clean() {
    if (hasDraft(draft.current)) {
      setMessage('Apply or Cancel pending inputs first');
      return false;
    }
    if (!liveEdit()) {
      setMessage('Editing unavailable');
      return false;
    }
    return true;
  }
  function select(action: () => void) {
    if (hasDraft(draft.current)) {
      setMessage('Apply or Cancel pending inputs first');
      return;
    }
    action();
  }
  function begin(): AnimationInputDraft | null {
    const v = editor.getSnapshot();
    if (v.state !== 'open' || !v.canEdit || v.saving || !layer) {
      setMessage('Editing unavailable');
      return null;
    }
    if (!hasDraft(draft.current))
      draft.current = {
        base: { ...v.snapshot, content: structuredClone(v.snapshot.content) },
        compositionId: composition.id,
        layerId: layer.id,
        transform: {},
        composing: new Set(),
      };
    return draft.current;
  }
  function changeBase(p: ControlledProperty, raw: string) {
    const d = begin();
    if (d) {
      d.transform[p] = raw;
      setInputProblem(null);
      notify();
    }
  }
  function changeKey(p: 'tick' | 'value', raw: string) {
    if (!track || !key) return;
    const d = begin();
    if (d) {
      d.key ??= {
        trackId: track.id,
        keyId: key.id,
        tick: String(key.tick),
        value: String(key.value),
      };
      d.key[p] = raw;
      setInputProblem(null);
      notify();
    }
  }
  function changeEasing(easing: NonNullable<NonNullable<AnimationInputDraft['key']>['easing']>) {
    if (!track || !key) return;
    const d = begin();
    if (!d) return;
    d.key ??= {
      trackId: track.id,
      keyId: key.id,
      tick: String(key.tick),
      value: String(key.value),
    };
    d.key.easing = easing;
    setInputProblem(null);
    // changed() can synchronously flush and clear the draft. Publish only after
    // the complete edit is ready; never mutate the draft after this notification.
    notify();
  }
  function cancelMove() {
    const d = draft.current;
    if (!d) return;
    d.composing.delete('timeline');
    if (!hasDraft(d)) draft.current = null;
    notify();
  }
  function startMove() {
    if (!clean()) return false;
    const d = begin();
    if (!d) return false;
    d.composing.add('timeline');
    notify();
    return true;
  }
  function moveKey(id: string, tick: number) {
    const d = draft.current;
    const t = d?.base.content.compositions
      .find((c) => c.id === d.compositionId)
      ?.tracks.find((t) => t.id === track?.id);
    const k = t?.keys.find((k) => k.id === id);
    if (!d || !t || !k) {
      cancelMove();
      return;
    }
    d.composing.delete('timeline');
    d.key = { trackId: t.id, keyId: k.id, tick: String(tick), value: String(k.value) };
    notify();
    report(editor.applyInputs());
  }
  function composing(id: string, on: boolean) {
    const d = on ? begin() : draft.current;
    if (d) {
      setInputProblem(null);
      if (on) d.composing.add(id);
      else d.composing.delete(id);
      // An IME cancellation may emit no change. Do not retain its target/revision.
      // Other raw edits or active compositions must continue to own their baseline.
      if (!hasDraft(d)) draft.current = null;
      notify();
    }
  }
  function execute(make: (content: AnimationContent) => EditorCommand<AnimationContent>) {
    if (!clean()) return;
    try {
      const v = editor.getSnapshot();
      if (v.state !== 'open') return;
      const result = editor.execute({
        baseRevision: v.snapshot.revision,
        command: make(v.snapshot.content),
      });
      report(result);
      return result;
    } catch (e) {
      setMessage(String(e));
    }
  }
  const scope = {
    canEdit: () => {
      const v = editor.getSnapshot();
      return v.state === 'open' && v.canEdit;
    },
  };
  function addRectangle() {
    const id = crypto.randomUUID();
    const result = execute((content) =>
      putRectangleLayerV1(
        content,
        composition.id,
        {
          id,
          type: 'rect',
          parentId: null,
          start: 0,
          end: composition.duration,
          width: 80,
          height: 80,
          fill: '#818cf8',
          transform: { ...identityTransform(), x: 80, y: 140 },
        },
        scope,
      ),
    );
    if (result?.state === 'applied') {
      setLayerId(id);
      setKeyId(null);
    }
  }
  function addKey() {
    if (!layer) return;
    const id = crypto.randomUUID();
    const result = execute((content) => {
      const c = content.compositions.find((c) => c.id === composition.id)!,
        existing = c.tracks.find((t) => t.layerId === layer.id && t.property === property),
        tick = playback.getSnapshot().tick;
      if (existing?.keys.some((k) => k.tick === tick))
        throw new Error('A key already exists at this tick');
      const next = existing
        ? structuredClone(existing)
        : { id: crypto.randomUUID(), layerId: layer.id, property, keys: [] };
      next.keys.push({
        id,
        tick,
        value: layer.transform[property],
        easing: { type: 'linear' },
      });
      next.keys.sort((a, b) => a.tick - b.tick);
      return replaceTrack(content, c.id, next, scope);
    });
    if (result?.state === 'applied') setKeyId(id);
  }
  function deleteKey() {
    if (!track || !key) return;
    execute((content) => {
      const keys = track.keys.filter((k) => k.id !== key.id);
      return keys.length
        ? replaceTrack(content, composition.id, { ...track, keys }, scope)
        : removeAnimationTrackV1(content, composition.id, track.id, scope);
    });
  }
  async function save() {
    try {
      const result = await editor.save();
      if (!alive.current) return;
      if (result.state === 'refused') focusInputFailure();
      setMessage(
        result.state === 'refused'
          ? `${result.code}: ${result.message}`
          : `Save: ${result.outcome.state}`,
      );
    } catch (e) {
      if (alive.current) setMessage(`Save failed: ${String(e)}`);
    }
  }
  return (
    <section className="animation-controlled">
      <header>
        <h2>Animation</h2>
        <p>Host-controlled native schema 1 · rectangles and groups</p>
      </header>
      <div className="ac-actions">
        <button disabled={!canEdit || pending} onClick={addRectangle}>
          Add rectangle
        </button>
        <button disabled={!canEdit || pending} onClick={() => report(editor.undo())}>
          Undo
        </button>
        <button disabled={!canEdit || pending} onClick={() => report(editor.redo())}>
          Redo
        </button>
        <button disabled={!view.canSave || view.saving} onClick={() => void save()}>
          Save through Host
        </button>
      </div>
      <label>
        Composition
        <select
          aria-label="Composition"
          value={composition.id}
          disabled={pending || view.saving}
          onChange={(e) =>
            select(() => {
              report(playback.selectComposition(e.target.value));
              setLayerId('');
              setKeyId(null);
            })
          }
        >
          {native.compositions.map((c) => (
            <option key={c.id}>{c.id}</option>
          ))}
        </select>
      </label>
      <nav aria-label="Layers">
        {composition.layers.map((l) => (
          <button
            key={l.id}
            disabled={pending || view.saving}
            aria-pressed={layer?.id === l.id}
            onClick={() =>
              select(() => {
                setLayerId(l.id);
                setKeyId(null);
              })
            }
          >
            {l.type} {l.id}
          </button>
        ))}
      </nav>
      <div className="ac-presentation" ref={stage} />
      <div className="ac-actions">
        <button
          disabled={!player.ready || pending || view.saving}
          onClick={() => report(player.playing ? playback.pause() : playback.play())}
        >
          {player.playing ? 'Pause' : 'Play'}
        </button>
        <span>
          {player.tick} / {player.duration} ticks
        </span>
      </div>
      <input
        aria-label="Seek"
        type="range"
        min={0}
        max={player.duration}
        step={1}
        value={player.tick}
        disabled={!player.ready || pending || view.saving}
        onChange={(e) => report(playback.seek(Number(e.target.value)))}
      />
      <KeyTimeline
        key={`${composition.id}/${track?.id}`}
        track={track}
        duration={composition.duration}
        tick={player.tick}
        selected={keyId}
        frameStep={frameTickV1(1, composition.frameRate)}
        disabled={!canEdit || (pending && !moving)}
        select={(id) => select(() => setKeyId(id))}
        start={startMove}
        cancelMove={cancelMove}
        move={moveKey}
        seek={(tick) => {
          if (!hasDraft(draft.current)) report(playback.seek(tick));
        }}
        report={setMessage}
      />
      <div ref={form}>
        <p className="ac-note" aria-live="polite">
          {layerId && !layer
            ? 'Selected layer is unavailable. Choose a layer to continue.'
            : keyId && !key
              ? 'Selected key is unavailable. Choose a key to continue.'
              : ''}
        </p>
        <fieldset disabled={!canEdit || !layer || moving}>
          <legend>Base transform — Apply inputs to commit</legend>
          <div className="ac-fields">
            {controlledProperties.map((p) => (
              <label key={p}>
                {p}
                <input
                  aria-label={`Base ${p}`}
                  type="text"
                  inputMode="decimal"
                  data-input-field={p}
                  aria-invalid={inputProblem?.field === p || undefined}
                  aria-describedby={inputProblem?.field === p ? inputErrorId : undefined}
                  data-dirty={draft.current?.transform[p] !== undefined}
                  value={draft.current?.transform[p] ?? String(layer?.transform[p] ?? 0)}
                  onChange={(e) => changeBase(p, e.target.value)}
                  onCompositionStart={() => composing(p, true)}
                  onCompositionEnd={() => composing(p, false)}
                />
                {inputProblem?.field === p && (
                  <span id={inputErrorId} role="alert" className="ac-input-error">
                    {inputProblem.message}
                  </span>
                )}
              </label>
            ))}
          </div>
          <label>
            Property
            <select
              aria-label="Property"
              value={property}
              disabled={pending}
              onChange={(e) =>
                select(() => {
                  setProperty(e.target.value as ControlledProperty);
                  setKeyId(null);
                })
              }
            >
              {controlledProperties.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <button disabled={pending} onClick={addKey}>
            Add key at playhead (base value)
          </button>
          <button disabled={pending || !key} onClick={deleteKey}>
            Delete selected key
          </button>
          <div className="ac-fields">
            {(['tick', 'value'] as const).map((p) => (
              <label key={p}>
                Key {p}
                <input
                  aria-label={`Key ${p}`}
                  disabled={!key}
                  type="text"
                  inputMode="decimal"
                  data-input-field={`key-${p}`}
                  aria-invalid={inputProblem?.field === `key-${p}` || undefined}
                  aria-describedby={inputProblem?.field === `key-${p}` ? inputErrorId : undefined}
                  data-dirty={!!draft.current?.key}
                  value={draft.current?.key?.[p] ?? (key ? String(key[p]) : '')}
                  onChange={(e) => changeKey(p, e.target.value)}
                  onCompositionStart={() => composing(`key-${p}`, true)}
                  onCompositionEnd={() => composing(`key-${p}`, false)}
                />
                {inputProblem?.field === `key-${p}` && (
                  <span id={inputErrorId} role="alert" className="ac-input-error">
                    {inputProblem.message}
                  </span>
                )}
              </label>
            ))}
          </div>
          {key && (
            <ControlledEasing
              value={
                draft.current?.key?.easing ?? {
                  type: key.easing.type,
                  points:
                    key.easing.type === 'bezier'
                      ? [key.easing.x1, key.easing.y1, key.easing.x2, key.easing.y2].map(String)
                      : ['0.42', '0', '0.58', '1'],
                }
              }
              change={changeEasing}
              composing={composing}
              problemField={inputProblem?.field}
              problemMessage={inputProblem?.message}
              errorId={inputErrorId}
            />
          )}
        </fieldset>
        {inputProblem && !inputProblem.field && (
          <p id={inputErrorId} role="alert" className="ac-input-error">
            {inputProblem.message}
          </p>
        )}
        <div className="ac-actions">
          <button
            disabled={!canEdit || !pending || moving}
            onClick={() => report(editor.applyInputs())}
          >
            Apply inputs
          </button>
          <button
            disabled={!pending || view.saving || moving}
            onClick={() => {
              draft.current = null;
              setInputProblem(null);
              notify();
              setMessage('Input cancelled; native content unchanged');
            }}
          >
            Cancel inputs
          </button>
        </div>
      </div>
      <p role="status">{player.error ?? message}</p>
      <p className="ac-note">
        {pending
          ? 'Pending inputs: Apply or Cancel before unrelated operations.'
          : 'No pending inputs.'}{' '}
        Save asks the Host to flush inputs and report its exact outcome. No JSON download or local
        storage is used here.
      </p>
    </section>
  );
}
