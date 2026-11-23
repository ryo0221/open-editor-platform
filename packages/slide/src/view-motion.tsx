import { useRef, useState } from 'react';
import { Section, useWording } from '@editor-platform/editor-ui';
import {
  slideMotionCommand,
  type Slide,
  type SlideEffectValue,
  type SlideFollowingTrigger,
  type SlideMotionOperation,
  type SlideObject,
  type SlideStep,
} from './model';
import {
  EffectForm,
  FollowingTrigger,
  MotionChoice,
  MotionFormActions,
  MotionPlacement,
  MotionRowActions,
  TransitionForm,
  motionLabels,
  motionTargetName,
} from './view-motion-fields';
import type { SlideEditing } from './view-shared';

type MotionEditor =
  | { kind: 'new-step' }
  | { kind: 'new-effect' | 'edit-effect' }
  | { kind: 'move'; position?: number };
type Removal = Extract<SlideMotionOperation, { type: 'slide.step.delete' | 'slide.effect.delete' }>;

export function SlideMotionInspector({ editing }: { editing: SlideEditing }) {
  return (
    <Section title="Motion" open={false}>
      {editing.slide && (
        <MotionPanel key={editing.slide.id} page={editing.slide} editing={editing} />
      )}
    </Section>
  );
}

function MotionPanel({ page, editing }: { page: Slide; editing: SlideEditing }) {
  const t = useWording();
  const disabled = editing.readOnly || !!editing.sharedEditing;
  const steps = page.steps ?? [];
  const targets = page.objects.filter((object) => object.type !== 'group');
  const targetNames = new Map(targets.map((object) => [object.id, motionTargetName(object)]));
  const [selectedStep, setSelectedStep] = useState<string>();
  const [selectedEffect, setSelectedEffect] = useState<string>();
  const [editor, setEditor] = useState<MotionEditor>();
  const [removal, setRemoval] = useState<Removal>();
  const [error, setError] = useState('');
  const alert = useRef<HTMLParagraphElement>(null);
  const stepIndex = steps.findIndex(({ id }) => id === selectedStep);
  const step = steps[stepIndex];
  const effectIndex = step?.effects.findIndex(({ id }) => id === selectedEffect) ?? -1;
  const effect = step?.effects[effectIndex];
  const slideId = page.id;
  const hold =
    step &&
    editing.content.exportSettings?.mp4?.holds?.find(
      (entry) => entry.slideId === slideId && entry.stepId === step.id,
    );

  const cancel = () => {
    setEditor(undefined);
    setRemoval(undefined);
    setError('');
  };
  function chooseStep(id: string) {
    cancel();
    setSelectedStep(id);
    setSelectedEffect(undefined);
  }
  function chooseEffect(stepId: string, effectId: string, targetId: string) {
    cancel();
    setSelectedStep(stepId);
    setSelectedEffect(effectId);
    setEditor({ kind: 'edit-effect' });
    editing.choose([targetId], slideId);
  }
  function openEditor(next: MotionEditor) {
    cancel();
    setEditor(next);
  }
  function commit(operation: SlideMotionOperation) {
    if (disabled) return;
    try {
      const command = slideMotionCommand(operation);
      const next = command.apply(editing.content);
      if (next !== editing.content && !editing.apply(command)) return;
      setError('');
      return next.slides.find(({ id }) => id === slideId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(motionError(message, t));
      requestAnimationFrame(() => alert.current?.focus());
    }
  }
  function saveEffect(
    value: SlideEffectValue,
    beforeId?: string,
    previousFirstTrigger?: SlideFollowingTrigger,
  ) {
    let updated: Slide | undefined;
    if (editor?.kind === 'new-step') {
      updated = commit({
        type: 'slide.step.insert',
        slideId,
        beforeStepId: beforeId,
        effects: [{ value }],
      });
    } else if (editor?.kind === 'new-effect' && step) {
      updated = commit({
        type: 'slide.effect.insert',
        slideId,
        stepId: step.id,
        beforeEffectId: beforeId,
        previousFirstTrigger,
        value,
      });
    } else if (step && effect) {
      updated = commit({
        type: 'slide.effect.update',
        slideId,
        stepId: step.id,
        effectId: effect.id,
        value,
      });
    }
    if (!updated) return;
    for (const candidate of updated.steps ?? []) {
      const selected = candidate.effects.find((item) =>
        editor?.kind === 'edit-effect'
          ? item.id === effect?.id
          : !steps.some((before) => before.effects.some(({ id }) => id === item.id)),
      );
      if (selected) {
        chooseEffect(candidate.id, selected.id, selected.targetId);
        return;
      }
    }
  }
  const remove = (operation: Removal) => {
    if (commit(operation)) cancel();
  };
  const requestRemoval = (operation: Removal) => {
    if (hold && (operation.type === 'slide.step.delete' || step?.effects.length === 1)) {
      cancel();
      setRemoval(operation);
    } else remove(operation);
  };
  const showEffectForm =
    editor?.kind === 'edit-effect'
      ? effect
      : !disabled && (editor?.kind === 'new-step' || (editor?.kind === 'new-effect' && step));
  return (
    <div
      className="slide-motion-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (editor || removal)) {
          cancel();
          event.stopPropagation();
        }
      }}
    >
      {disabled && (
        <p>
          {t(
            editing.readOnly
              ? 'Slide motion is read only.'
              : 'Slide motion is unavailable in shared editing.',
          )}
        </p>
      )}
      {steps.length === 0 && <p>{t('This page has no motion.')}</p>}
      <ol className="slide-motion-steps">
        {steps.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={step?.id === item.id && !effect}
              onClick={() => chooseStep(item.id)}
            >
              {t('Step {0}', index + 1)}
            </button>
            <ul>
              {item.effects.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-pressed={effect?.id === entry.id}
                    onClick={() => chooseEffect(item.id, entry.id, entry.targetId)}
                  >
                    <strong>{targetNames.get(entry.targetId)}</strong>
                    <span>
                      {[
                        t(motionLabels[entry.phase]),
                        t(motionLabels[entry.effect]),
                        t(motionLabels[entry.trigger]),
                      ].join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <button
        type="button"
        disabled={disabled || !targets.length}
        onClick={() => openEditor({ kind: 'new-step' })}
      >
        {t('Add step')}
      </button>
      {!disabled && !targets.length && <p>{t('Add an object to give it an effect.')}</p>}
      {step && !disabled && (
        <fieldset className="inspector-fields">
          <legend>{t('Step {0}', stepIndex + 1)}</legend>
          <MotionRowActions
            up={
              stepIndex > 0
                ? () =>
                    commit({
                      type: 'slide.step.move',
                      slideId,
                      stepId: step.id,
                      beforeStepId: steps[stepIndex - 1].id,
                    })
                : undefined
            }
            down={
              stepIndex < steps.length - 1
                ? () =>
                    commit({
                      type: 'slide.step.move',
                      slideId,
                      stepId: step.id,
                      beforeStepId: steps[stepIndex + 2]?.id,
                    })
                : undefined
            }
            remove={() => requestRemoval({ type: 'slide.step.delete', slideId, stepId: step.id })}
          >
            <button type="button" onClick={() => openEditor({ kind: 'new-effect' })}>
              {t('Add effect')}
            </button>
          </MotionRowActions>
        </fieldset>
      )}
      {effect && step && (
        <fieldset className="inspector-fields">
          <legend>{t('Selected effect')}</legend>
          <p>
            {page.title || t('Untitled slide')} · {targetNames.get(effect.targetId)}
          </p>
          {!disabled && (
            <MotionRowActions
              up={
                effectIndex > 0
                  ? () => openEditor({ kind: 'move', position: effectIndex - 1 })
                  : undefined
              }
              down={
                effectIndex < step.effects.length - 1
                  ? () => openEditor({ kind: 'move', position: effectIndex + 1 })
                  : undefined
              }
              remove={() =>
                requestRemoval({
                  type: 'slide.effect.delete',
                  slideId,
                  stepId: step.id,
                  effectId: effect.id,
                })
              }
            >
              <button type="button" onClick={() => openEditor({ kind: 'move' })}>
                {t('Move effect…')}
              </button>
              {editor?.kind !== 'edit-effect' && (
                <button type="button" onClick={() => openEditor({ kind: 'edit-effect' })}>
                  {t('Edit effect')}
                </button>
              )}
            </MotionRowActions>
          )}
        </fieldset>
      )}
      {editor && showEffectForm && (
        <EffectForm
          key={JSON.stringify([
            editor.kind,
            disabled,
            step?.id,
            editor.kind === 'edit-effect' && effect,
            steps.map((entry) => [entry.id, entry.effects.map(({ id }) => id)]),
          ])}
          page={page}
          targets={targets}
          initialTarget={targets.find((object) => editing.ids.includes(object.id))?.id}
          initial={editor.kind === 'edit-effect' ? effect : undefined}
          step={editor.kind === 'new-effect' ? step : undefined}
          editingFirst={effectIndex === 0}
          disabled={disabled}
          cancel={cancel}
          save={saveEffect}
        />
      )}
      {editor?.kind === 'move' && step && effect && (
        <MoveEffect
          key={JSON.stringify([
            effect.id,
            editor.position,
            steps.map((entry) => [entry.id, entry.effects.map(({ id }) => id)]),
          ])}
          steps={steps}
          targets={targets}
          source={step}
          effectId={effect.id}
          initialPosition={editor.position}
          hold={hold?.holdSeconds}
          disabled={disabled}
          cancel={cancel}
          save={(destination, trigger) => {
            const updated = commit({
              type: 'slide.effect.move',
              slideId,
              stepId: step.id,
              effectId: effect.id,
              destination,
              trigger,
            });
            const destinationStep = updated?.steps?.find((item) =>
              item.effects.some(({ id }) => id === effect.id),
            );
            if (destinationStep) chooseEffect(destinationStep.id, effect.id, effect.targetId);
          }}
        />
      )}
      {removal && hold && !disabled && (
        <div>
          <p role="status">{t('This removes the {0} s hold for this step.', hold.holdSeconds)}</p>
          <div className="slide-motion-actions">
            <button type="button" onClick={() => remove(removal)}>
              {t('Confirm deletion')}
            </button>
            <button type="button" onClick={cancel}>
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" tabIndex={-1} ref={alert}>
          {error}
        </p>
      )}
      <TransitionForm
        key={JSON.stringify([page.transition, disabled])}
        initial={page.transition ?? { kind: 'none' }}
        disabled={disabled}
        save={(transition) => !!commit({ type: 'slide.transition.set', slideId, transition })}
      />
    </div>
  );
}

type Move = Extract<SlideMotionOperation, { type: 'slide.effect.move' }>;
function MoveEffect({
  steps,
  targets,
  source,
  effectId,
  initialPosition,
  hold,
  disabled,
  cancel,
  save,
}: {
  steps: SlideStep[];
  targets: SlideObject[];
  source: SlideStep;
  effectId: string;
  initialPosition?: number;
  hold?: number;
  disabled: boolean;
  cancel(): void;
  save(destination: Move['destination'], trigger: SlideEffectValue['trigger']): void;
}) {
  const t = useWording();
  const [destination, setDestination] = useState(source.id);
  const targetStep = steps.find(({ id }) => id === destination);
  const effects = targetStep?.effects.filter(({ id }) => id !== effectId) ?? [];
  const [position, setPosition] = useState(initialPosition ?? effects.length);
  const choices = targetStep
    ? effects.map((effect) => motionTargetName(targets.find(({ id }) => id === effect.targetId)))
    : steps.map((_, index) => t('Step {0}', index + 1));
  const index = Math.min(position, choices.length);
  const first = !targetStep || index === 0;
  const trigger = source.effects.find(({ id }) => id === effectId)?.trigger;
  const [following, setFollowing] = useState<SlideFollowingTrigger>(
    trigger && trigger !== 'on-click' ? trigger : 'after-previous',
  );
  const [previous, setPrevious] = useState<SlideFollowingTrigger>('after-previous');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        save(
          targetStep
            ? {
                stepId: targetStep.id,
                beforeEffectId: effects[index]?.id,
                previousFirstTrigger: first && effects.length ? previous : undefined,
              }
            : { newStep: { beforeStepId: steps[index]?.id } },
          first ? 'on-click' : following,
        );
      }}
    >
      <fieldset disabled={disabled} className="inspector-fields">
        <legend>{t('Move effect…')}</legend>
        <MotionChoice
          label="Destination"
          value={destination}
          options={[
            ...steps.map((step, i) => [step.id, t('Step {0}', i + 1)] as const),
            ['', t('New step')],
          ]}
          change={(id) => {
            setDestination(id);
            const step = steps.find((item) => item.id === id);
            setPosition(
              step ? step.effects.filter((item) => item.id !== effectId).length : steps.length,
            );
          }}
        />
        <MotionPlacement label="Position" choices={choices} index={index} change={setPosition} />
        {first ? (
          <p>
            {t('Trigger')} · {t('On click')}
          </p>
        ) : (
          <FollowingTrigger label="Trigger" value={following} change={setFollowing} />
        )}
        {targetStep && first && effects.length > 0 && (
          <FollowingTrigger label="Previous first effect" value={previous} change={setPrevious} />
        )}
        {hold !== undefined && source.effects.length === 1 && destination !== source.id && (
          <p role="status">{t('This removes the {0} s hold for this step.', hold)}</p>
        )}
        <MotionFormActions cancel={cancel} />
      </fieldset>
    </form>
  );
}

function motionError(message: string, t: ReturnType<typeof useWording>) {
  const reason = message.split(' at ')[0];
  switch (reason) {
    case 'missing-target':
    case 'unsupported-target':
      return t('Choose an object on this page.');
    case 'missing-slide':
    case 'missing-step':
    case 'missing-effect':
      return t('The page, step or effect is no longer available.');
    case 'repeated-target':
      return t('An object can have only one effect per step.');
    case 'invalid-visibility':
      return t('This order conflicts with the target’s visibility.');
    case 'too-many-steps':
    case 'too-many-effects':
      return t(
        'Motion is limited to 100 steps and 100 effects per page and 1,000 effects per deck.',
      );
    case 'invalid-delay':
    case 'invalid-duration':
    case 'step-duration-limit':
      return t('Check the effect timings and duration limits.');
    default:
      return message;
  }
}
