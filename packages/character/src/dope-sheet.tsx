import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import type { Easing } from '@editor-platform/animation-core';
import type {
  CharacterAction,
  CharacterDocument,
  CharacterKeyAddress,
  CharacterTrack,
} from '@editor-platform/character-core';
import { IconButton } from '@editor-platform/editor-ui';
import { formatTicks } from './playback';

/** The easings a key can be given here; a Bézier from a file shows as "Custom". */
export const easingChoices: { id: string; label: string; easing: Easing }[] = [
  { id: 'linear', label: 'Linear', easing: { type: 'linear' } },
  { id: 'hold', label: 'Hold', easing: { type: 'hold' } },
  {
    id: 'ease',
    label: 'Ease in-out',
    easing: { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  },
];
const easingId = (e: Easing) =>
  easingChoices.find((c) => JSON.stringify(c.easing) === JSON.stringify(e))?.id ?? 'custom';

/** The name a track's target shows under: its bone, part or morph, and the property. */
export function trackLabel(
  doc: CharacterDocument,
  track: CharacterTrack,
  /** A prop joint's name from its version, when the Host has shown it. */
  jointName?: (propId: string, jointId: string) => string | undefined,
): string {
  const { target } = track;
  if (target.kind === 'prop-joint') {
    const prop = doc.props.find((p) => p.id === target.id)?.name ?? target.id;
    return `${prop} ${jointName?.(target.id, target.joint) ?? target.joint} ${target.property}`;
  }
  const name =
    target.kind === 'bone'
      ? doc.skeletons.flatMap((s) => s.bones).find((b) => b.id === target.id)?.name
      : target.kind === 'part'
        ? doc.parts.find((p) => p.id === target.id)?.name
        : doc.morphs.find((m) => m.id === target.id)?.name;
  return `${name ?? target.id} ${target.property}`;
}

/**
 * C2a dope sheet: one row per track of the action, its keys at their time. Keys are selected
 * here (Shift adds); deleting, nudging by a frame and easing are edits of the session.
 */
export function DopeSheet({
  doc,
  action,
  tick,
  frame,
  selected,
  readOnly,
  onSelect,
  onSeek,
  onDelete,
  onMove,
  onEasing,
  jointName,
}: {
  doc: CharacterDocument;
  action: CharacterAction;
  tick: number;
  /** One frame of the action's rate, in ticks. */
  frame: number;
  selected: readonly CharacterKeyAddress[];
  readOnly: boolean;
  onSelect(keys: CharacterKeyAddress[]): void;
  onSeek(tick: number): void;
  onDelete(): void;
  onMove(delta: number): void;
  onEasing(easing: Easing): void;
  jointName?: (propId: string, jointId: string) => string | undefined;
}) {
  const isSelected = (trackId: string, keyId: string) =>
    selected.some((s) => s.trackId === trackId && s.keyId === keyId);
  const chosen = selected
    .map((s) => action.tracks.find((t) => t.id === s.trackId)?.keys.find((k) => k.id === s.keyId))
    .filter((k) => k !== undefined);
  const easings = new Set(chosen.map((k) => easingId(k.easing)));
  const at = (t: number) => `${(100 * t) / Math.max(1, action.duration)}%`;
  return (
    <div
      className="character-dopesheet"
      role="group"
      aria-label="Keys"
      onKeyDown={(e) => {
        if (readOnly || !selected.length) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onDelete();
        } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          onMove(e.key === 'ArrowLeft' ? -frame : frame);
        }
      }}
    >
      <div className="character-keys-tools">
        <span>{selected.length ? `${selected.length} selected` : 'Select a key to edit it'}</span>
        <IconButton
          icon={ChevronLeft}
          label="Move keys a frame earlier"
          shortcut="Alt+Left"
          disabled={readOnly || !selected.length}
          reason={readOnly ? 'Read only' : 'Select keys first'}
          onClick={() => onMove(-frame)}
        />
        <IconButton
          icon={ChevronRight}
          label="Move keys a frame later"
          shortcut="Alt+Right"
          disabled={readOnly || !selected.length}
          reason={readOnly ? 'Read only' : 'Select keys first'}
          onClick={() => onMove(frame)}
        />
        <IconButton
          icon={Trash2}
          label="Delete keys"
          shortcut="Delete"
          disabled={readOnly || !selected.length}
          reason={readOnly ? 'Read only' : 'Select keys first'}
          onClick={onDelete}
        />
        <label className="character-pick">
          Easing
          <select
            aria-label="Key easing"
            disabled={readOnly || !selected.length}
            value={easings.size === 1 ? [...easings][0] : ''}
            onChange={(e) => {
              const c = easingChoices.find((x) => x.id === e.target.value);
              if (c) onEasing(c.easing);
            }}
          >
            <option value="" disabled>
              {easings.size > 1 ? 'Mixed' : '—'}
            </option>
            {easingChoices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            <option value="custom" disabled>
              Custom
            </option>
          </select>
        </label>
      </div>
      {action.tracks.length === 0 ? (
        <p className="character-keys-empty">No keys in this action yet.</p>
      ) : (
        <ul className="character-tracks" aria-label="Tracks">
          {action.tracks.map((t) => {
            const label = trackLabel(doc, t, jointName);
            return (
              <li key={t.id} className="character-track">
                <span className="character-track-name">{label}</span>
                <span
                  className="character-track-lane"
                  onClick={(e) => {
                    // A click on the lane (not on a key) moves the playhead there.
                    if (e.target !== e.currentTarget) return;
                    const box = e.currentTarget.getBoundingClientRect();
                    onSeek(Math.round(((e.clientX - box.left) / box.width) * action.duration));
                  }}
                >
                  <span className="character-track-playhead" style={{ left: at(tick) }} />
                  {t.keys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className="character-key"
                      style={{ left: at(k.tick) }}
                      aria-pressed={isSelected(t.id, k.id)}
                      aria-label={`Key ${label} at ${formatTicks(k.tick)}`}
                      onClick={(e) => {
                        const one = { trackId: t.id, keyId: k.id };
                        if (e.shiftKey)
                          onSelect(
                            isSelected(t.id, k.id)
                              ? selected.filter((s) => !(s.trackId === t.id && s.keyId === k.id))
                              : [...selected, one],
                          );
                        else {
                          onSelect([one]);
                          onSeek(k.tick);
                        }
                      }}
                    />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
