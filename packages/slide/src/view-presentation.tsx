import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { isTextInput, useWording } from '@editor-platform/editor-ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimationPresentationObject } from './animation';
import { SlideObjectDrawing } from './live-references';
import {
  slideMotionState,
  slidePaintOrder,
  slidePlaybackPages,
  slideStepTiming,
  type Slide,
} from './model';
import type { SlideEditing } from './view-shared';
import { slideMotionTransform, slideTransitionLayers } from './motion';

type Position = { pageId: string; step: number };
type Playback = {
  position: Position;
  run?: { from: Position; durationMs: number };
  elapsedMs?: number;
};
const lastStep = (page: Slide) => page.steps?.length ?? 0;

function openingPage(editing: SlideEditing, pageId: string | undefined) {
  const { slides } = editing.content;
  const index = Math.max(
    0,
    slides.findIndex((page) => page.id === pageId),
  );
  return (
    slides.slice(index).find((page) => !page.hidden) ?? slides.filter((page) => !page.hidden).at(-1)
  );
}

function nextPosition(
  playback: Playback,
  pages: ReturnType<typeof slidePlaybackPages>,
  index: number,
): Playback {
  const current = pages[index]?.page;
  if (!current || playback.run) return playback;
  const step = Math.min(playback.position.step, lastStep(current));
  const effectStep = current.steps?.[step];
  const following = pages[index + 1];
  if (effectStep) {
    return {
      position: { pageId: current.id, step: step + 1 },
      run: {
        from: { pageId: current.id, step },
        durationMs: slideStepTiming(effectStep).durationMs,
      },
      elapsedMs: 0,
    };
  }
  if (!following) return playback;
  const position = { pageId: following.page.id, step: 0 };
  const transition = following.transition;
  return transition && transition.kind !== 'none'
    ? {
        position,
        run: { from: { pageId: current.id, step }, durationMs: transition.durationMs },
        elapsedMs: 0,
      }
    : { position };
}

/** Full-screen presentation with a private cursor and the shared model's motion sampler. */
export function SlidePresentation({
  editing,
  pageId,
  trigger,
  menuTrigger,
  isComposing,
  close,
}: {
  editing: SlideEditing;
  pageId?: string;
  trigger: HTMLButtonElement;
  menuTrigger?: HTMLButtonElement | null;
  isComposing(): boolean;
  close(): void;
}) {
  const t = useWording();
  const { content } = editing;
  const dialog = useRef<HTMLDialogElement>(null);
  const playable = slidePlaybackPages(content);
  const [playback, setPlayback] = useState<Playback>(() => ({
    position: { pageId: openingPage(editing, pageId)?.id ?? '', step: 0 },
  }));
  const index = playable.findIndex(({ page }) => page.id === playback.position.pageId);
  const fallback = index === -1 ? openingPage(editing, playback.position.pageId) : undefined;
  const activeIndex = index === -1 ? playable.findIndex(({ page }) => page === fallback) : index;
  const current = playable[activeIndex]?.page;
  const step = current && index !== -1 ? Math.min(playback.position.step, lastStep(current)) : 0;
  const from = playable.find(({ page }) => page.id === playback.run?.from.pageId)?.page;
  const run = index !== -1 && from ? playback.run : undefined;
  const transition = run && from !== current ? playable[activeIndex]?.transition : undefined;

  useLayoutEffect(() => {
    const surface = dialog.current;
    surface?.showModal();
    surface?.focus();
    return () => {
      surface?.close();
      const opener = trigger.isConnected && trigger.getClientRects().length ? trigger : menuTrigger;
      opener?.focus();
    };
  }, [trigger, menuTrigger]);

  useEffect(() => {
    if (!playback.run) return;
    const playing = playback.run;
    const start = performance.now();
    let frame: number;
    const tick = (time: number) => {
      const elapsed = Math.max(0, time - start);
      setPlayback((state) => {
        if (state.run !== playing) return state;
        return elapsed >= playing.durationMs
          ? { position: state.position }
          : { ...state, elapsedMs: elapsed };
      });
      if (elapsed < playing.durationMs) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playback.run]);

  const next = () => {
    if (!current || isComposing()) return;
    setPlayback((state) => {
      const currentIndex = playable.findIndex(({ page }) => page.id === state.position.pageId);
      if (currentIndex !== -1) return nextPosition(state, playable, currentIndex);
      return nextPosition({ position: { pageId: current.id, step: 0 } }, playable, activeIndex);
    });
  };
  const previous = () => {
    if (!current || isComposing()) return;
    if (run) setPlayback({ position: run.from });
    else if (step > 0) setPlayback({ position: { pageId: current.id, step: step - 1 } });
    else if (activeIndex > 0) {
      const page = playable[activeIndex - 1].page;
      setPlayback({ position: { pageId: page.id, step: lastStep(page) } });
    }
  };
  const exit = () => {
    if (!isComposing()) close();
  };

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) exit();
      return;
    }
    if (event.key === 'Tab') {
      const controls = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((control) => !control.closest('[inert]') && control.getClientRects().length);
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if (
        document.activeElement === edge ||
        (event.shiftKey && document.activeElement === event.currentTarget)
      ) {
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
      return;
    }
    if (isTextInput(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    const backward = ['ArrowLeft', 'PageUp'].includes(event.key);
    const forward =
      ['ArrowRight', 'PageDown'].includes(event.key) ||
      (event.key === ' ' && !(event.target instanceof Element && event.target.closest('button')));
    if (!backward && !forward) return;
    event.preventDefault();
    if (!event.repeat) (forward ? next : previous)();
  }

  const progress = run ? (playback.elapsedMs ?? 0) / run.durationMs : 1;
  const layers = slideTransitionLayers(content, transition, progress);
  return (
    <dialog
      className="presenting"
      aria-label="Slide presentation"
      ref={dialog}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        exit();
      }}
    >
      {current ? (
        <div className="slide-presentation-stage">
          <svg
            viewBox={`0 0 ${content.width} ${content.height}`}
            aria-label={`Presentation page ${activeIndex + 1}`}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button, a, input'))
                return;
              dialog.current?.focus();
              next();
            }}
          >
            <svg width={content.width} height={content.height} overflow="hidden">
              {transition && from && run && (
                <PresentedSlide
                  key={from.id}
                  editing={editing}
                  page={from}
                  step={Math.min(run.from.step, lastStep(from))}
                  {...layers.outgoing}
                  outgoing
                />
              )}
              <PresentedSlide
                key={current.id}
                editing={editing}
                page={current}
                step={step}
                elapsedMs={run && !transition ? playback.elapsedMs : undefined}
                {...layers.incoming}
              />
            </svg>
          </svg>
        </div>
      ) : (
        <p>{t('No visible slides')}</p>
      )}
      <footer>
        {current && (
          <>
            <div className="slide-presentation-position">
              <PresentationPageNumber
                key={activeIndex}
                number={activeIndex + 1}
                max={playable.length}
                go={(pageNumber) => {
                  if (isComposing()) return;
                  setPlayback({ position: { pageId: playable[pageNumber - 1].page.id, step: 0 } });
                  dialog.current?.focus();
                }}
              />
              {!!lastStep(current) && (
                <output aria-live="polite">
                  {step === 0
                    ? t('Initial / {0} steps', lastStep(current))
                    : t('Step {0} / {1}', step, lastStep(current))}
                </output>
              )}
            </div>
            <div className="slide-presentation-buttons">
              <button
                type="button"
                aria-label="Previous slide"
                aria-disabled={!run && activeIndex === 0 && step === 0}
                onClick={previous}
              >
                <ChevronLeft size={18} aria-hidden="true" />
                {t('Previous')}
              </button>
              <button
                type="button"
                aria-label="Next slide"
                className="slide-presentation-next"
                aria-disabled={
                  !!run || (activeIndex === playable.length - 1 && step >= lastStep(current))
                }
                onClick={next}
              >
                {t('Next')}
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            </div>
          </>
        )}
        <button type="button" aria-label="Exit presentation" onClick={exit}>
          <X size={18} aria-hidden="true" />
          {t('End presentation')}
        </button>
      </footer>
    </dialog>
  );
}

function PresentationPageNumber({
  number,
  max,
  go,
}: {
  number: number;
  max: number;
  go(number: number): void;
}) {
  const t = useWording();
  const [value, setValue] = useState(String(number));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const requested = Number(value);
        if (!Number.isInteger(requested) || requested < 1 || requested > max) return;
        setValue(String(requested));
        go(requested);
      }}
    >
      <input
        aria-label="Presentation page"
        type="number"
        min={1}
        max={max}
        step={1}
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <span>{t('/ {0} pages', max)}</span>
      <button type="submit">{t('Go')}</button>
    </form>
  );
}

function PresentedSlide({
  editing,
  page,
  step,
  elapsedMs,
  x = 0,
  y = 0,
  opacity = 1,
  outgoing,
}: {
  editing: SlideEditing;
  page: Slide;
  step: number;
  elapsedMs?: number;
  x?: number;
  y?: number;
  opacity?: number;
  outgoing?: boolean;
}) {
  const { content } = editing;
  const state = slideMotionState(content, page, step, elapsedMs);
  return (
    <g transform={`translate(${x} ${y})`} opacity={opacity} aria-hidden={outgoing || undefined}>
      <rect width={content.width} height={content.height} fill={page.background} />
      {slidePaintOrder(page).map((object) => {
        const pose = state.get(object.id);
        if (!pose?.visible) return null;
        return (
          <g key={object.id} opacity={pose.opacity} transform={slideMotionTransform(object, pose)}>
            {object.type === 'animation' ? (
              <AnimationPresentationObject object={object} inert={outgoing} />
            ) : (
              <SlideObjectDrawing object={object} editing={editing} />
            )}
          </g>
        );
      })}
    </g>
  );
}
