import { useState, type ReactNode } from 'react';
import { useWording } from '@editor-platform/editor-ui';
import {
  type Slide,
  type SlideEffectPhase,
  type SlideEffectValue,
  type SlideFollowingTrigger,
  type SlideMotionDirection,
  type SlideObject,
  type SlideStep,
  type SlideTransition,
} from './model';
import { slideMotionDirections } from './motion';

const motionEnd = 'append';
const effectsByPhase = {
  enter: ['fade', 'slide-in', 'zoom'],
  exit: ['fade', 'slide-out', 'zoom'],
  emphasis: ['zoom'],
} as const;
export const motionLabels = {
  enter: 'Entrance',
  exit: 'Exit',
  emphasis: 'Emphasis',
  fade: 'Fade',
  'slide-in': 'Slide in',
  'slide-out': 'Slide out',
  zoom: 'Zoom',
  'on-click': 'On click',
  'with-previous': 'With previous',
  'after-previous': 'After previous',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  none: 'None',
  push: 'Push',
};
export const motionTargetName = (object?: SlideObject) =>
  object
    ? object.text.trim() || object.animation?.label || object.alt || object.shape || object.type
    : '';

type MotionOption<T extends string> = readonly [T, string];
export function MotionChoice<T extends string>({
  label,
  value,
  options,
  change,
}: {
  label: string;
  value: T;
  options: readonly MotionOption<T>[];
  change(value: T): void;
}) {
  const t = useWording();
  return (
    <label className="ep-field">
      {t(label)}
      <select value={value} onChange={(event) => change(event.target.value as T)}>
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MotionPlacement({
  label,
  choices,
  index,
  change,
}: {
  label: string;
  choices: string[];
  index: number;
  change(index: number): void;
}) {
  const t = useWording();
  return (
    <MotionChoice
      label={label}
      value={index === choices.length ? motionEnd : String(index)}
      options={[
        ...choices.map((name, i) => [String(i), t('Before {0}', name)] as const),
        [motionEnd, t('At the end')],
      ]}
      change={(value) => change(value === motionEnd ? choices.length : Number(value))}
    />
  );
}

const followingTriggers = ['with-previous', 'after-previous'] as const;
export function FollowingTrigger({
  label,
  value,
  change,
}: {
  label: string;
  value: SlideFollowingTrigger;
  change(value: SlideFollowingTrigger): void;
}) {
  const t = useWording();
  return (
    <MotionChoice
      label={label}
      value={value}
      change={change}
      options={followingTriggers.map((key) => [key, t(motionLabels[key])])}
    />
  );
}

function Direction({
  value,
  change,
}: {
  value: SlideMotionDirection;
  change(value: SlideMotionDirection): void;
}) {
  const t = useWording();
  return (
    <MotionChoice
      label="Direction"
      value={value}
      change={change}
      options={slideMotionDirections.map((key) => [key, t(motionLabels[key])])}
    />
  );
}

function Milliseconds({
  label,
  value,
  min,
  max,
  change,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  change(value: string): void;
}) {
  const t = useWording();
  return (
    <label className="ep-field">
      {t(label)}
      <input
        type="number"
        required
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
}

export function MotionFormActions({
  cancel,
  action = 'Apply',
}: {
  cancel(): void;
  action?: string;
}) {
  const t = useWording();
  return (
    <div className="slide-motion-actions">
      <button type="submit">{t(action)}</button>
      <button type="button" onClick={cancel}>
        {t('Cancel')}
      </button>
    </div>
  );
}

export function EffectForm({
  page,
  targets,
  initialTarget,
  initial,
  step,
  editingFirst,
  disabled,
  cancel,
  save,
}: {
  page: Slide;
  targets: SlideObject[];
  initialTarget?: string;
  initial?: SlideEffectValue;
  step?: SlideStep;
  editingFirst?: boolean;
  disabled: boolean;
  cancel(): void;
  save(
    value: SlideEffectValue,
    beforeId?: string,
    previousFirstTrigger?: SlideFollowingTrigger,
  ): void;
}) {
  const t = useWording();
  const [target, setTarget] = useState(initial?.targetId ?? initialTarget ?? targets[0]?.id ?? '');
  const [phase, setPhase] = useState<SlideEffectPhase>(initial?.phase ?? 'enter');
  const [effect, setEffect] = useState(initial?.effect ?? 'fade');
  const [direction, setDirection] = useState<SlideMotionDirection>(initial?.direction ?? 'right');
  const [following, setFollowing] = useState<SlideFollowingTrigger>(
    initial?.trigger && initial.trigger !== 'on-click' ? initial.trigger : 'after-previous',
  );
  const [previous, setPrevious] = useState<SlideFollowingTrigger>('after-previous');
  const [delay, setDelay] = useState(String(initial?.delayMs ?? 0));
  const [length, setLength] = useState(String(initial?.durationMs ?? 300));
  const choices = (step?.effects ?? page.steps ?? []).map((item, i) =>
    'targetId' in item
      ? motionTargetName(targets.find((object) => object.id === item.targetId))
      : t('Step {0}', i + 1),
  );
  const [index, setIndex] = useState(choices.length);
  const position = Math.min(index, choices.length);
  const first = initial ? editingFirst : !step || position === 0;
  const displacesFirst = !initial && !!step && position === 0;
  const availableTarget = targets.some((object) => object.id === target);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !availableTarget) return;
        const common = {
          targetId: target,
          trigger: first ? ('on-click' as const) : following,
          delayMs: Number(delay),
          durationMs: Number(length),
        };
        const value: SlideEffectValue =
          phase === 'emphasis'
            ? { ...common, phase, effect: 'zoom' }
            : effect === 'slide-in'
              ? { ...common, phase: 'enter', effect, direction }
              : effect === 'slide-out'
                ? { ...common, phase: 'exit', effect, direction }
                : { ...common, phase, effect };
        save(
          value,
          initial ? undefined : (step?.effects ?? page.steps)?.[position]?.id,
          displacesFirst ? previous : undefined,
        );
      }}
    >
      <fieldset disabled={disabled} className="inspector-fields">
        <legend>{initial ? t('Edit effect') : t(step ? 'Add effect' : 'Add step')}</legend>
        <MotionChoice
          label="Target"
          value={target}
          change={setTarget}
          options={[
            ...(!availableTarget ? [[target, t('Choose an object')] as const] : []),
            ...targets.map((object) => [object.id, motionTargetName(object)] as const),
          ]}
        />
        {!initial && (
          <MotionPlacement label="Position" choices={choices} index={position} change={setIndex} />
        )}
        <MotionChoice
          label="Effect phase"
          value={phase}
          options={(['enter', 'exit', 'emphasis'] as const).map((key) => [
            key,
            t(motionLabels[key]),
          ])}
          change={(next) => {
            const choices: readonly SlideEffectValue['effect'][] = effectsByPhase[next];
            setPhase(next);
            if (!choices.includes(effect)) setEffect(choices[0]);
          }}
        />
        <MotionChoice<SlideEffectValue['effect']>
          label="Effect type"
          value={effect}
          change={setEffect}
          options={effectsByPhase[phase].map((key) => [key, t(motionLabels[key])])}
        />
        {(effect === 'slide-in' || effect === 'slide-out') && (
          <Direction value={direction} change={setDirection} />
        )}
        {first ? (
          <p>
            {t('Trigger')} · {t('On click')}
          </p>
        ) : (
          <FollowingTrigger label="Trigger" value={following} change={setFollowing} />
        )}
        {displacesFirst && (
          <FollowingTrigger label="Previous first effect" value={previous} change={setPrevious} />
        )}
        <Milliseconds label="Delay (ms)" value={delay} min={0} max={10000} change={setDelay} />
        <Milliseconds label="Duration (ms)" value={length} min={1} max={10000} change={setLength} />
        {!disabled && <MotionFormActions cancel={cancel} />}
      </fieldset>
    </form>
  );
}

export function TransitionForm({
  initial,
  disabled,
  save,
}: {
  initial: SlideTransition;
  disabled: boolean;
  save(value: SlideTransition): boolean;
}) {
  const t = useWording();
  const [kind, setKind] = useState(initial.kind);
  const [length, setLength] = useState(String(initial.kind === 'none' ? 300 : initial.durationMs));
  const [direction, setDirection] = useState<SlideMotionDirection>(
    initial.kind === 'push' ? initial.direction : 'right',
  );
  const reset = () => {
    setKind(initial.kind);
    setLength(String(initial.kind === 'none' ? 300 : initial.durationMs));
    setDirection(initial.kind === 'push' ? initial.direction : 'right');
  };
  return (
    <form
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !disabled &&
          (kind !== initial.kind ||
            (kind !== 'none' && initial.kind !== 'none' && Number(length) !== initial.durationMs) ||
            (kind === 'push' && initial.kind === 'push' && direction !== initial.direction))
        ) {
          reset();
          event.stopPropagation();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        save(
          kind === 'none'
            ? { kind }
            : kind === 'push'
              ? { kind, durationMs: Number(length), direction }
              : { kind, durationMs: Number(length) },
        );
      }}
    >
      <fieldset disabled={disabled} className="inspector-fields">
        <legend>{t('Page transition')}</legend>
        <MotionChoice<SlideTransition['kind']>
          label="Transition type"
          value={kind}
          change={setKind}
          options={(['none', 'fade', 'push'] as const).map((key) => [key, t(motionLabels[key])])}
        />
        {kind === 'push' && <Direction value={direction} change={setDirection} />}
        {kind !== 'none' && (
          <Milliseconds
            label="Transition duration (ms)"
            value={length}
            min={1}
            max={3000}
            change={setLength}
          />
        )}
        {!disabled && <MotionFormActions cancel={reset} />}
      </fieldset>
    </form>
  );
}

export function MotionRowActions({
  up,
  down,
  remove,
  children,
}: {
  up?(): void;
  down?(): void;
  remove(): void;
  children?: ReactNode;
}) {
  const t = useWording();
  return (
    <div className="slide-motion-actions">
      <button type="button" disabled={!up} onClick={up}>
        {t('Move up')}
      </button>
      <button type="button" disabled={!down} onClick={down}>
        {t('Move down')}
      </button>
      <button type="button" onClick={remove}>
        {t('Delete')}
      </button>
      {children}
    </div>
  );
}
