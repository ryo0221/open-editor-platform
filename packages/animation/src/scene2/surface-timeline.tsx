import type { MutableRefObject } from 'react';
import type { EditorInputs } from '@editor-platform/editor-core';
import {
  animationCommand2,
  type AnimationAction2,
  type AnimationCommand2,
  type AnimationContent2,
  type Composition2,
  type Property2,
  type Track2,
} from '@editor-platform/animation-core/v2';
import { KeyTimeline } from '../controlled-timeline';
import type { KeySelection2 } from './keyframe-commands';

const animatedProperties: Property2[] = [
  'x',
  'y',
  'anchorX',
  'anchorY',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
  'fill',
  'stroke',
  'strokeWidth',
  'text',
];

export function AnimationKeyActions2({
  compositionId,
  step,
  trackProperty,
  keySelection,
  moveFrames,
  disabled,
  pending,
  hasSelection,
  hasClipboard,
  onTrackProperty,
  onAddKey,
  onDeleteKeys,
  onCopyKeys,
  onPasteKeys,
  onMoveFrames,
  report,
  actions,
}: {
  compositionId: string;
  step: number;
  trackProperty: Property2;
  keySelection: KeySelection2[];
  moveFrames: string;
  disabled: boolean;
  pending: boolean;
  hasSelection: boolean;
  hasClipboard: boolean;
  onTrackProperty(property: Property2): void;
  onAddKey(): void;
  onDeleteKeys(): void;
  onCopyKeys(): void;
  onPasteKeys(): void;
  onMoveFrames(value: string): void;
  report(message: string): void;
  actions(values: AnimationAction2[], label: string): void;
}) {
  return (
    <div className="a2-actions">
      <select
        aria-label="Animated property"
        value={trackProperty}
        disabled={pending}
        onChange={(e) => onTrackProperty(e.target.value as Property2)}
      >
        {animatedProperties.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <button disabled={disabled || !hasSelection} onClick={onAddKey}>
        Add key at playhead
      </button>
      <button disabled={disabled || !keySelection.length} onClick={onDeleteKeys}>
        Delete keys
      </button>
      <button disabled={pending || !keySelection.length} onClick={onCopyKeys}>
        Copy keys
      </button>
      <button disabled={disabled || !hasClipboard} onClick={onPasteKeys}>
        Paste keys
      </button>
      <label>
        Move by frames
        <input
          aria-label="Move keys by frames"
          value={moveFrames}
          onChange={(e) => onMoveFrames(e.target.value)}
        />
      </label>
      <button
        disabled={disabled || !keySelection.length}
        onClick={() => {
          const frames = Number(moveFrames);
          if (!moveFrames.trim() || !Number.isSafeInteger(frames)) {
            report('Enter a whole number of frames');
            return;
          }
          actions(
            [{ type: 'keys.move', compositionId, keys: keySelection, delta: frames * step }],
            'Move selected keys',
          );
        }}
      >
        Move keys
      </button>
    </div>
  );
}

/** One rail per track; shift-click extends the key selection. */
export function AnimationTrackRails2({
  composition: c,
  step,
  keySelection,
  pending,
  onSelectKey,
}: {
  composition: Composition2;
  step: number;
  keySelection: KeySelection2[];
  pending: boolean;
  onSelectKey(layerId: string, keys: KeySelection2[]): void;
}) {
  return (
    <div className="a2-tracks">
      {c.tracks.map((track) => (
        <div key={track.id} className="a2-track">
          <strong>
            {c.layers.find((l) => l.id === track.layerId)?.name}: {track.property}
          </strong>
          <div className="a2-key-rail">
            {track.keys.map((key) => (
              <button
                key={key.id}
                aria-label={`${track.property} key ${key.id}`}
                aria-pressed={keySelection.some((s) => s.keyId === key.id)}
                disabled={pending}
                style={{ left: `${(key.tick / c.duration) * 100}%` }}
                onClick={(e) =>
                  onSelectKey(
                    track.layerId,
                    e.shiftKey
                      ? [
                          ...keySelection.filter((s) => s.keyId !== key.id),
                          { trackId: track.id, keyId: key.id },
                        ]
                      : [{ trackId: track.id, keyId: key.id }],
                  )
                }
              >
                ◆<small>{(key.tick / step).toFixed(1)}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AnimationPlayhead2({
  duration,
  step,
  tick,
  snap,
  pending,
  ready,
  onSeek,
  onSnap,
}: {
  duration: number;
  step: number;
  tick: number;
  snap: boolean;
  pending: boolean;
  ready: boolean;
  onSeek(tick: number): void;
  onSnap(snap: boolean): void;
}) {
  return (
    <>
      <label>
        Playhead
        <input
          aria-label="Animation playhead"
          type="range"
          min={0}
          max={duration}
          step={snap ? step : 1}
          value={tick}
          disabled={pending || !ready}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </label>
      <output aria-label="Animation frame">Frame {(tick / step).toFixed(2)}</output>
      <div className="a2-actions">
        <button disabled={pending} onClick={() => onSeek(tick - step)}>
          Previous frame
        </button>
        <button disabled={pending} onClick={() => onSeek(tick + step)}>
          Next frame
        </button>
        <button disabled={pending} onClick={() => onSeek(duration)}>
          Final pose
        </button>
        <label>
          Snap to frames
          <input type="checkbox" checked={snap} onChange={(e) => onSnap(e.target.checked)} />
        </label>
      </div>
    </>
  );
}

export type AnimationKeyGesture2 = {
  base: AnimationContent2;
  keys: { trackId: string; keyId: string }[];
};

/**
 * Key timeline for the selected track. A key drag holds a gesture (registered as a
 * composing input) from start until it commits once against the content it began on.
 */
export function AnimationTrackTimeline2({
  track,
  basis,
  compositionId,
  duration,
  tick,
  step,
  snap,
  keySelection,
  readOnly,
  pending,
  disabled,
  gesture,
  inputs,
  scope,
  read,
  seek,
  report,
  run,
  selectLayer,
  onKeySelection,
}: {
  track: Track2;
  basis: string;
  compositionId: string;
  duration: number;
  tick: number;
  step: number;
  snap: boolean;
  keySelection: KeySelection2[];
  readOnly: boolean;
  pending: boolean;
  disabled: boolean;
  gesture: MutableRefObject<AnimationKeyGesture2 | null>;
  inputs: EditorInputs;
  scope: { canEdit(): boolean };
  read(): AnimationContent2;
  seek(tick: number): void;
  report(message: string): void;
  run(make: () => AnimationCommand2): boolean;
  selectLayer(layerId: string): void;
  onKeySelection(keys: KeySelection2[]): void;
}) {
  return (
    <KeyTimeline
      basis={basis}
      track={track}
      duration={duration}
      tick={tick}
      frameStep={step}
      selected={keySelection[0]?.keyId ?? null}
      movingIds={keySelection.map((key) => key.keyId)}
      disabled={readOnly || (pending && !gesture.current)}
      seek={seek}
      report={report}
      select={(id) => {
        selectLayer(track.layerId);
        if (!keySelection.some((key) => key.keyId === id))
          onKeySelection([{ trackId: track.id, keyId: id }]);
      }}
      start={(id) => {
        if (disabled || !id) return false;
        const keys = keySelection.some((key) => key.keyId === id)
          ? keySelection
          : [{ trackId: track.id, keyId: id }];
        gesture.current = { base: structuredClone(read()), keys };
        inputs.changed();
        return true;
      }}
      cancelMove={() => {
        gesture.current = null;
        inputs.changed();
      }}
      move={(id, value) => {
        const current = gesture.current;
        if (!current) return;
        const comp = current.base.compositions.find((comp) => comp.id === compositionId)!,
          key = comp.tracks.flatMap((track) => track.keys).find((key) => key.id === id)!;
        gesture.current = null;
        inputs.changed();
        run(() =>
          animationCommand2(
            current.base,
            [
              {
                type: 'keys.move',
                compositionId,
                keys: current.keys,
                delta: (snap ? Math.round(value / step) * step : value) - key.tick,
              },
            ],
            scope,
            'Move selected Animation keys',
          ),
        );
      }}
    />
  );
}
