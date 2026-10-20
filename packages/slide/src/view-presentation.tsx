import type { Dispatch, SetStateAction } from 'react';
import { IconButton } from '@editor-platform/editor-ui';
import { DrawingView } from '@editor-platform/canvas-ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimationPresentationObject } from './animation';
import { slideDrawing, slidePaintOrder } from './model';
import { projectedReference, type SlideEditing } from './view-shared';
/** Full-screen presentation of the slides not skipped during presentation. */
export function SlidePresentation({
  editing,
  presentIndex,
  setPresentIndex,
  close,
}: {
  editing: SlideEditing;
  presentIndex: number;
  setPresentIndex: Dispatch<SetStateAction<number>>;
  close(): void;
}) {
  const { content, references } = editing;
  const playable = content.slides.filter((s) => !s.hidden),
    present = playable[Math.min(presentIndex, playable.length - 1)];
  return (
    <div
      className="presenting"
      role="dialog"
      aria-label="Slide presentation"
      tabIndex={0}
      ref={(el) => el?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
        if (['ArrowRight', 'PageDown'].includes(e.key))
          setPresentIndex((i) => Math.min(playable.length - 1, i + 1));
        if (['ArrowLeft', 'PageUp'].includes(e.key)) setPresentIndex((i) => Math.max(0, i - 1));
      }}
    >
      {present ? (
        <svg
          viewBox={`0 0 ${content.width} ${content.height}`}
          aria-label={`Presentation page ${presentIndex + 1}`}
        >
          <rect width={content.width} height={content.height} fill={present.background} />
          {slidePaintOrder(present).map((o) =>
            o.type === 'animation' ? (
              <AnimationPresentationObject key={`${present.id}/${o.id}`} object={o} />
            ) : (
              <DrawingView
                key={`${present.id}/${o.id}`}
                drawing={slideDrawing(projectedReference(o, references))}
              />
            ),
          )}
        </svg>
      ) : (
        <p>No visible slides</p>
      )}
      <footer>
        <IconButton
          icon={ChevronLeft}
          label="Previous slide"
          disabled={presentIndex <= 0}
          onClick={() => setPresentIndex((i) => i - 1)}
        />
        <input
          aria-label="Presentation page"
          type="number"
          min={1}
          max={playable.length}
          value={presentIndex + 1}
          onChange={(e) =>
            setPresentIndex(Math.min(playable.length - 1, Math.max(0, Number(e.target.value) - 1)))
          }
        />
        <span>/ {playable.length}</span>
        <IconButton
          icon={ChevronRight}
          label="Next slide"
          disabled={presentIndex >= playable.length - 1}
          onClick={() => setPresentIndex((i) => i + 1)}
        />
        <IconButton icon={X} label="Exit presentation" onClick={close} />
      </footer>
    </div>
  );
}
