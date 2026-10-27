import type { RefObject } from 'react';
import { CommitInput } from '@editor-platform/editor-ui';
import type { EditorInputs } from '@editor-platform/editor-core';
import type { AnimationCommand2, AnimationContent2 } from '@editor-platform/animation-core/v2';
import { AnimationDurationInput2 } from './duration-input';

export type AnimationLayerType2 = 'rect' | 'path' | 'text' | 'group';
export type AnimationWorkArea2 = { start: number; end: number };

const layerTypes = ['rect', 'path', 'text', 'group'] as const;
const playbackRates = [0.25, 0.5, 1, 2, 4];

function addLabel(type: AnimationLayerType2) {
  return type === 'rect' ? 'rectangle' : type === 'path' ? 'vector' : type;
}

export function AnimationSurfaceHeader2({
  content,
  compositionId,
  disabled,
  pending,
  ready,
  playing,
  loop,
  rate,
  exportDisabled,
  addButton,
  onAdd,
  onComposition,
  onTogglePlay,
  onLoop,
  onRate,
  onExport,
}: {
  content: AnimationContent2;
  compositionId: string;
  disabled: boolean;
  pending: boolean;
  ready: boolean;
  playing: boolean;
  loop: boolean;
  rate: number;
  exportDisabled: boolean;
  addButton: RefObject<HTMLButtonElement | null>;
  onAdd(type: AnimationLayerType2): void;
  onComposition(id: string): void;
  onTogglePlay(): void;
  onLoop(loop: boolean): void;
  onRate(rate: number): void;
  onExport(): void;
}) {
  return (
    <header className="a2-toolbar">
      <h2>Animation 2D</h2>
      <div className="a2-actions">
        {layerTypes.map((type) => (
          <button
            ref={type === 'rect' ? addButton : undefined}
            key={type}
            disabled={disabled}
            onClick={() => onAdd(type)}
          >
            Add {addLabel(type)}
          </button>
        ))}
        <label>
          Composition
          <select
            aria-label="Animation composition"
            disabled={pending}
            value={compositionId}
            onChange={(e) => onComposition(e.target.value)}
          >
            {content.compositions.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={pending || !ready} onClick={onTogglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <label>
          Loop
          <input type="checkbox" checked={loop} onChange={(e) => onLoop(e.target.checked)} />
        </label>
        <label>
          Playback rate
          <select
            aria-label="Playback rate"
            value={rate}
            onChange={(e) => onRate(Number(e.target.value))}
          >
            {playbackRates.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <button disabled={exportDisabled} onClick={onExport}>
          Export static frame…
        </button>
      </div>
    </header>
  );
}

/** Composition duration plus a preview-only work area, both edited in whole frames. */
export function AnimationTimingControls2({
  content,
  compositionId,
  duration,
  step,
  workArea,
  inputs,
  readOnly,
  canEdit,
  execute,
  onWorkArea,
}: {
  content: AnimationContent2;
  compositionId: string;
  duration: number;
  step: number;
  workArea: AnimationWorkArea2 | undefined;
  inputs: EditorInputs;
  readOnly: boolean;
  canEdit(): boolean;
  execute(command: AnimationCommand2): boolean | void;
  onWorkArea(workArea: AnimationWorkArea2 | undefined): void;
}) {
  return (
    <div className="a2-actions a2-timing">
      <AnimationDurationInput2
        content={content}
        compositionId={compositionId}
        inputs={inputs}
        readOnly={readOnly}
        canEdit={canEdit}
        execute={execute}
      />
      <CommitInput
        label="Work area start (frame)"
        type="number"
        value={(workArea?.start ?? 0) / step}
        onCommit={(value) => {
          const start = Number(value) * step,
            end = workArea?.end ?? duration;
          if (!Number.isSafeInteger(start) || start < 0 || start >= end)
            throw Error('Invalid work area');
          onWorkArea({ start, end });
        }}
      />
      <CommitInput
        label="Work area end (frame)"
        type="number"
        value={(workArea?.end ?? duration) / step}
        onCommit={(value) => {
          const end = Number(value) * step,
            start = workArea?.start ?? 0;
          if (!Number.isSafeInteger(end) || end > duration || end <= start)
            throw Error('Invalid work area');
          onWorkArea({ start, end });
        }}
      />
      <button onClick={() => onWorkArea(undefined)}>Reset work area</button>
    </div>
  );
}
