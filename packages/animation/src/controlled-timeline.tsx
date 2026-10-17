import { useLayoutEffect, useRef, useState } from 'react';
import type { Track } from '@editor-platform/animation-core';
interface Props {
  track?: Track;
  duration: number;
  tick: number;
  selected: string | null;
  frameStep: number;
  select(id: string): void;
  move(id: string, tick: number): void;
  seek(tick: number): void;
  report(message: string): void;
  start(): boolean;
  cancelMove(): void;
  disabled: boolean;
}
interface Draft {
  id: string;
  tick: number;
  startTick: number;
  startX: number;
  width: number;
  pointer?: number;
}
export function KeyTimeline({
  track,
  duration,
  tick,
  selected,
  frameStep,
  select,
  move,
  seek,
  report,
  start,
  cancelMove,
  disabled,
}: Props) {
  const [zoom, setZoom] = useState(1),
    [draft, setDraft] = useState<Draft | null>(null);
  const active = useRef<Draft | null>(null),
    rail = useRef<HTMLDivElement>(null),
    ghost = useRef<HTMLDivElement>(null);
  const selectedTick = track?.keys.find((k) => k.id === selected)?.tick;
  useLayoutEffect(() => {
    const focused = rail.current?.querySelector<HTMLButtonElement>('button:focus');
    // Follow only an existing keyboard focus. Pointer drag and external history
    // must not move focus or scroll the user away from the Inspector/toolbar.
    if (!focused || draft?.pointer !== undefined) return;
    (draft ? ghost.current : focused)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [draft, selectedTick]);
  const update = (d: Draft | null) => {
    active.current = d;
    setDraft(d);
  };
  const reason = (d: Draft) =>
    !Number.isSafeInteger(d.tick) || d.tick < 0 || d.tick > duration
      ? 'Key tick is outside the composition range'
      : track?.keys.some((k) => k.id !== d.id && k.tick === d.tick)
        ? 'A key already exists at that tick'
        : null;
  const cancel = () => {
    update(null);
    cancelMove();
    report('Key move cancelled; native content unchanged');
  };
  function commit() {
    const d = active.current;
    if (!d) return;
    const error = reason(d);
    update(null);
    if (error) {
      cancelMove();
      report(`Move rejected: ${error}`);
      return;
    }
    if (d.tick !== d.startTick) move(d.id, d.tick);
    else cancelMove();
  }
  return (
    <div
      className="ae-time-editor"
      onKeyDownCapture={(e) => {
        if (e.key === 'Escape' && active.current) {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <label>
        Timeline zoom
        <input
          aria-label="Timeline zoom"
          type="range"
          min="1"
          max="4"
          step="1"
          disabled={disabled}
          value={zoom}
          onChange={(e) => {
            if (active.current) cancel();
            setZoom(Number(e.target.value));
          }}
        />
      </label>
      <p className="ae-hint">
        Drag a key to preview its time; release to commit. Arrow keys preview ±1 tick (Shift: one
        frame); Enter commits, Escape cancels. Scroll horizontally when zoomed.
      </p>
      <div className="ae-time-scroll" tabIndex={0} aria-label="Scrollable timeline">
        <div className="ae-time-width" style={{ width: `${zoom * 100}%`, minWidth: 600 * zoom }}>
          <div className="ae-time-rail" ref={rail}>
            <div
              className="ae-ruler"
              onPointerDown={(e) => {
                if (disabled || active.current || e.button !== 0) return;
                const box = rail.current!.getBoundingClientRect();
                seek(
                  Math.max(
                    0,
                    Math.min(duration, Math.round(((e.clientX - box.left) / box.width) * duration)),
                  ),
                );
              }}
            >
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} style={{ left: `${i * 12.5}%` }}>
                  {((duration * i) / 8 / 240000).toFixed(2)}s
                </span>
              ))}
            </div>
            <div
              className="ae-playhead"
              aria-label="Timeline playhead"
              data-tick={tick}
              style={{ left: `${(tick / duration) * 100}%` }}
            />
            {track?.keys.map((k) => (
              <button
                key={k.id}
                disabled={disabled}
                className="ae-key-marker"
                aria-label={`${k.tick} ticks · ${k.value}`}
                aria-pressed={selected === k.id}
                style={{ left: `${(k.tick / duration) * 100}%` }}
                onBlur={() => {
                  if (active.current?.pointer === undefined && active.current) cancel();
                }}
                onFocus={() => {
                  if (selected !== k.id) select(k.id);
                }}
                onClick={(e) => {
                  if (e.detail === 0 && !active.current) select(k.id);
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  select(k.id);
                  e.currentTarget.focus();
                  if (!start()) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  update({
                    id: k.id,
                    tick: k.tick,
                    startTick: k.tick,
                    startX: e.clientX,
                    width: rail.current!.getBoundingClientRect().width,
                    pointer: e.pointerId,
                  });
                }}
                onPointerMove={(e) => {
                  const d = active.current;
                  if (d?.pointer !== e.pointerId) return;
                  update({
                    ...d,
                    tick: d.startTick + Math.round(((e.clientX - d.startX) / d.width) * duration),
                  });
                }}
                onPointerUp={(e) => {
                  if (active.current?.pointer !== e.pointerId) return;
                  commit();
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={() => {
                  if (active.current) cancel();
                }}
                onLostPointerCapture={() => {
                  if (active.current) cancel();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    if (!active.current && !start()) return;
                    const d =
                      active.current?.id === k.id
                        ? active.current
                        : { id: k.id, tick: k.tick, startTick: k.tick, startX: 0, width: 0 };
                    update({
                      ...d,
                      tick:
                        d.tick + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? frameStep : 1),
                    });
                  } else if (e.key === 'Enter' && active.current) {
                    e.preventDefault();
                    commit();
                  }
                }}
              >
                ◆<small>{k.tick}</small>
              </button>
            ))}
            {draft && (
              <div
                className="ae-key-ghost"
                ref={ghost}
                style={{ left: `${Math.max(0, Math.min(1, draft.tick / duration)) * 100}%` }}
              >
                ◇
              </div>
            )}
          </div>
        </div>
      </div>
      <p aria-live="polite" className="ae-hint">
        {draft
          ? `Preview: ${draft.tick} ticks${reason(draft) ? ` — ${reason(draft)}` : ''}; not committed`
          : 'Select a key to edit its value and outgoing easing below.'}
      </p>
    </div>
  );
}
