import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';
import {
  animationCommand2,
  frameStep2,
  type AnimationContent2,
  type AnimationCommand2,
} from '@editor-platform/animation-core/v2';
interface Props {
  content: AnimationContent2;
  compositionId: string;
  inputs: EditorInputs;
  readOnly: boolean;
  canEdit(): boolean;
  execute(command: AnimationCommand2): boolean | void;
}
/** One native input boundary; its own draft stays editable while other buffers block duration edits. */
export function AnimationDurationInput2(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const composition = props.content.compositions.find((c) => c.id === props.compositionId)!,
    incoming = String(composition.duration / frameStep2(composition));
  const state = useRef({
      raw: incoming,
      dirty: false,
      composing: false,
      base: undefined as AnimationContent2 | undefined,
      compositionId: props.compositionId,
    }),
    input = useRef<HTMLInputElement>(null),
    [, refresh] = useState(0),
    [error, setError] = useState('');
  const aggregate = useSyncExternalStore(
    props.inputs.subscribe,
    props.inputs.getSnapshot,
    props.inputs.getSnapshot,
  );
  const otherPending = () => {
    const snapshot = latest.current.inputs.getSnapshot(),
      own = state.current;
    return snapshot.dirty > Number(own.dirty) || snapshot.composing > Number(own.composing);
  };
  const changed = () => {
    refresh((n) => n + 1);
    latest.current.inputs.changed();
  };
  const prepare = () => {
    const p = latest.current,
      own = state.current;
    if (p.readOnly || !p.canEdit()) throw Error('Read only');
    if (otherPending()) throw Error('Apply or cancel other pending inputs first');
    if (own.compositionId !== p.compositionId)
      throw Error('Composition changed; copy the duration or press Escape to cancel');
    const base = own.base ?? p.content,
      c = base.compositions.find((c) => c.id === p.compositionId)!;
    const frames = Number(own.raw);
    if (!own.raw.trim() || !Number.isFinite(frames) || frames <= 0)
      throw Error('Enter a positive frame duration');
    const command = animationCommand2(
      base,
      [{ type: 'composition.duration', compositionId: c.id, duration: frames * frameStep2(c) }],
      { canEdit: () => latest.current.canEdit() && !latest.current.readOnly },
      'Change composition duration',
    );
    return () => {
      if (latest.current.execute(command) === false)
        throw Error('Duration change refused; input is retained');
      own.dirty = false;
      own.base = undefined;
      setError('');
      changed();
      return true;
    };
  };
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  useEffect(
    () =>
      props.inputs.register({
        label: 'Composition duration (frames)',
        read: () => state.current,
        prepare: () => prepareRef.current(),
        focus: () => input.current?.focus(),
      }),
    [props.inputs],
  );
  useEffect(() => {
    if (!state.current.dirty && !state.current.composing) {
      state.current.raw = incoming;
      state.current.compositionId = props.compositionId;
      refresh((n) => n + 1);
    }
  }, [incoming, props.compositionId]);
  const cancel = () => {
    state.current = {
      raw: incoming,
      dirty: false,
      composing: false,
      base: undefined,
      compositionId: props.compositionId,
    };
    setError('');
    changed();
  };
  return (
    <fieldset
      disabled={
        props.readOnly ||
        aggregate.dirty > Number(state.current.dirty) ||
        aggregate.composing > Number(state.current.composing)
      }
    >
      <label className="ep-field">
        Composition duration (frames)
        <input
          ref={input}
          aria-label="Composition duration (frames)"
          type="number"
          step={1}
          value={state.current.raw}
          onChange={(e) => {
            const own = state.current;
            if (!own.base) own.compositionId = latest.current.compositionId;
            own.base ??= latest.current.content;
            own.raw = e.target.value;
            own.dirty = own.raw !== incoming;
            if (!own.dirty) own.base = undefined;
            setError('');
            changed();
          }}
          onCompositionStart={() => {
            state.current.composing = true;
            changed();
          }}
          onCompositionEnd={() => {
            state.current.composing = false;
            if (!state.current.dirty) {
              state.current.raw = incoming;
              state.current.compositionId = props.compositionId;
              state.current.base = undefined;
            }
            changed();
          }}
          onBlur={() => {
            if (state.current.dirty && !state.current.composing)
              try {
                prepareRef.current()();
              } catch (error) {
                setError(String(error));
              }
          }}
          onKeyDown={(e) => {
            if (state.current.composing || e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancel();
              e.currentTarget.blur();
              e.stopPropagation();
            }
          }}
        />
        {(error ||
          (state.current.dirty && state.current.compositionId !== props.compositionId)) && (
          <small role="alert">
            {error || 'Composition changed; copy the duration or press Escape to cancel'}
          </small>
        )}
      </label>
    </fieldset>
  );
}
