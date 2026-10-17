import {
  add,
  compare,
  frameTime,
  time,
  type Time,
  type VideoContent,
  type VideoEdit,
} from '@editor-platform/video-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
type Snapshot = LocalReadSnapshot<VideoContent>;
const seconds = (t: Time) => t.value / t.timescale;
const signedFrames = (n: number, fps: Time) => {
  const t = frameTime(Math.abs(n), fps);
  return time(Math.sign(n) * t.value, t.timescale);
};
/** Private timeline geometry/gesture state only; all writes return to the owning Surface. */
export function createVisualTimeline(
  doc: Document,
  ports: {
    read(): { snapshot: Snapshot; canEdit: boolean };
    select(id: string): boolean;
    selected(): string;
    begin(): void;
    gesture(active: boolean): void;
    submit(edit: VideoEdit, base: Snapshot): void;
    seek(frame: number): void;
    action(name: string): void;
    error(error: unknown): void;
  },
) {
  const root = doc.createElement('div');
  root.setAttribute('aria-label', 'Visual timeline');
  root.style.cssText =
    'max-width:100%;min-width:0;border:1px solid #b8c6d8;border-radius:8px;padding:8px;box-sizing:border-box;background:#f5f8fc;color:#162a42';
  const controls = doc.createElement('div');
  controls.setAttribute('aria-label', 'Clip drag controls');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
  const selectedInfo = doc.createElement('p');
  selectedInfo.style.cssText = 'flex-basis:100%;margin:0;overflow-wrap:anywhere';
  controls.append(selectedInfo);
  const handles = (['start', 'move', 'end'] as const).map((mode) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = mode === 'move' ? 'Move selected clip' : `Trim selected ${mode}`;
    button.style.cssText =
      'padding:8px 12px;border:1px solid #8b9cb0;border-radius:4px;touch-action:none';
    controls.append(button);
    return button;
  });
  const label = doc.createElement('label');
  label.textContent = 'Timeline zoom ';
  const zoom = doc.createElement('input');
  zoom.type = 'range';
  zoom.min = '20';
  zoom.max = '200';
  zoom.value = '80';
  zoom.setAttribute('aria-label', 'Timeline zoom');
  label.append(zoom);
  const help = doc.createElement('p');
  help.textContent =
    'Drag clips to move; drag edges to trim. Arrow keys move one frame; edge arrows trim. S splits at the red Split target, Delete removes, Ctrl/Cmd+Z undoes. Escape cancels.';
  const scroll = doc.createElement('div');
  scroll.style.cssText = 'overflow-x:auto;max-width:100%;position:relative';
  const canvas = doc.createElement('div');
  canvas.style.cssText = 'position:relative;touch-action:pan-y;min-width:100%;';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Timeline tracks');
  const splitHelp = doc.createElement('p');
  splitHelp.setAttribute('aria-label', 'Split target help');
  splitHelp.textContent =
    'The red Split target does not follow Player playback or Player seeking. Set it with the ruler or the split-frame field; changing it requests a preview seek when available.';
  scroll.append(canvas);
  root.append(label, help, splitHelp, scroll);
  let frameAt = time(0);
  let transitioning = false,
    reentered = false;
  let frame = 0,
    disposed = false;
  let drag:
    | {
        id: string;
        mode: string;
        pointer: number;
        x: number;
        scroll: number;
        base: Snapshot;
        delta: number;
        px: number;
        control?: HTMLButtonElement;
      }
    | undefined;
  const guard = (work: () => void) => {
    if (disposed) return;
    if (transitioning) {
      reentered = true;
      return;
    }
    transitioning = true;
    reentered = false;
    try {
      work();
    } catch (error) {
      ports.error(error);
    } finally {
      transitioning = false;
    }
  };
  const checkTransition = () => {
    if (disposed) throw Error('ScopeRevoked');
    if (reentered) throw Error('TimelineReentry');
  };
  const px = () => Number(zoom.value);
  const mark = () => {
    const marker = canvas.querySelector<HTMLElement>('[data-playhead]');
    if (marker) {
      marker.style.left = `${seconds(frameAt) * px()}px`;
      marker.textContent = `▼ Split ${frame}f`;
    }
  };
  const setFrame = (value: number) => {
    if (disposed) throw Error('ScopeRevoked');
    const content = ports.read().snapshot.content;
    const at = frameTime(value, content.sequence.frameRate);
    if (compare(at, content.sequence.duration) > 0) throw Error('PlayheadOutsideSequence');
    frame = value;
    frameAt = at;
    mark();
    return at;
  };
  const cancel = () => {
    if (!drag) return;
    const old = drag;
    drag = undefined;
    if (canvas.hasPointerCapture(old.pointer)) canvas.releasePointerCapture(old.pointer);
    ports.gesture(false);
    render();
  };
  const editFor = (d: NonNullable<typeof drag>): VideoEdit => {
    const c = d.base.content.sequence.clips.find((c) => c.id === d.id)!;
    const delta = signedFrames(d.delta, d.base.content.sequence.frameRate);
    return d.mode === 'move'
      ? { type: 'move', clipId: c.id, delta }
      : {
          type: 'trim',
          clipId: c.id,
          independent: true,
          start: d.mode === 'start' ? add(c.start, delta) : c.start,
          end: d.mode === 'end' ? add(add(c.start, c.duration), delta) : add(c.start, c.duration),
        };
  };
  function render() {
    if (disposed || drag) return;
    const { snapshot, canEdit } = ports.read(),
      v = snapshot.content;
    const selectedClip = v.sequence.clips.find((c) => c.id === ports.selected());
    selectedInfo.textContent = selectedClip
      ? `Selected: ${selectedClip.id} · source ${selectedClip.sourceId}. For short clips, use the clip selector below and these drag controls.`
      : 'Select a clip to move or trim.';
    for (const handle of handles) {
      handle.dataset.id = selectedClip?.id ?? '';
      handle.disabled =
        !selectedClip ||
        !canEdit ||
        !!v.sequence.tracks.find((t) => t.id === selectedClip.trackId)?.locked;
    }
    const focused =
      doc.activeElement instanceof HTMLElement && canvas.contains(doc.activeElement)
        ? { id: doc.activeElement.dataset.id, mode: doc.activeElement.dataset.mode }
        : undefined;
    canvas.replaceChildren();
    canvas.style.width = `${Math.max(600, seconds(v.sequence.duration) * px() + 40)}px`;
    canvas.style.height = `${40 + v.sequence.tracks.length * 76}px`;
    const duration = seconds(v.sequence.duration),
      step = Math.max(1, Math.ceil(60 / px()));
    // A viewport ruler, not one DOM node per frame of an entire long project.
    const first = Math.max(0, Math.floor(scroll.scrollLeft / px() / step) * step);
    const last = Math.min(duration, first + (scroll.clientWidth || 600) / px() + step * 2);
    for (let n = first; n <= last; n += step) {
      const tick = doc.createElement('span');
      tick.textContent = `${n}s`;
      tick.style.cssText = `position:absolute;left:${n * px()}px;top:18px;border-left:1px solid #8b9cb0;padding-left:3px;font-size:11px`;
      canvas.append(tick);
    }
    v.sequence.tracks.forEach((track, index) => {
      const lane = doc.createElement('div');
      lane.style.cssText = `position:absolute;top:${40 + index * 76}px;height:70px;left:0;right:0;border-top:1px solid #c6d2df`;
      lane.setAttribute('aria-label', `${track.id}${track.locked ? ' locked' : ''}`);
      canvas.append(lane);
      for (const clip of v.sequence.clips.filter((c) => c.trackId === track.id)) {
        const box = doc.createElement('div');
        box.dataset.clipId = clip.id;
        box.style.cssText = `position:absolute;top:8px;left:${seconds(clip.start) * px()}px;width:${Math.max(2, seconds(clip.duration) * px())}px;height:52px;display:flex;box-sizing:border-box;border:2px solid ${ports.selected() === clip.id ? '#d27700' : '#386ca5'};border-radius:5px;background:${clip.kind === 'audio' ? '#d9f1e5' : '#dceaff'};overflow:hidden`;
        for (const mode of ['start', 'move', 'end']) {
          const b = doc.createElement('button');
          b.type = 'button';
          b.dataset.mode = mode;
          b.dataset.id = clip.id;
          b.textContent = mode === 'move' ? clip.id : mode === 'start' ? '‹' : '›';
          b.setAttribute(
            'aria-label',
            mode === 'move' ? `Select clip ${clip.id}` : `Trim ${mode} ${clip.id}`,
          );
          b.style.cssText = `border:0;background:transparent;color:inherit;padding:2px;min-width:0;${mode === 'move' ? 'flex:1;overflow:hidden;text-overflow:ellipsis' : 'width:16px;flex-shrink:0;cursor:ew-resize'}`;
          b.setAttribute('aria-disabled', String(!canEdit || track.locked));
          b.onclick = () =>
            guard(() => {
              if (!drag && ports.select(clip.id)) {
                render();
                canvas
                  .querySelector<HTMLButtonElement>(`[data-id="${clip.id}"][data-mode="${mode}"]`)
                  ?.focus();
              }
            });
          box.append(b);
        }
        lane.append(box);
      }
    });
    const marker = doc.createElement('div');
    marker.dataset.playhead = '';
    marker.style.cssText =
      'position:absolute;top:0;bottom:0;width:1px;background:#b74335;pointer-events:none;white-space:nowrap;font-size:11px;color:#92281b';
    canvas.append(marker);
    mark();
    if (focused?.id)
      canvas
        .querySelector<HTMLButtonElement>(`[data-id="${focused.id}"][data-mode="${focused.mode}"]`)
        ?.focus({ preventScroll: true });
  }
  canvas.onpointerdown = (e) =>
    guard(() => {
      if (e.button !== 0 || drag) return;
      const target = (e.target as Element).closest<HTMLButtonElement>('button[data-id]');
      if (!target) {
        const x = e.clientX - canvas.getBoundingClientRect().left;
        const v = ports.read().snapshot.content;
        const nextFrame = Math.max(
          0,
          Math.min(
            Math.round(seconds(v.sequence.duration) * seconds(v.sequence.frameRate)),
            Math.round((x / px()) * seconds(v.sequence.frameRate)),
          ),
        );
        setFrame(nextFrame);
        ports.seek(nextFrame);
        checkTransition();
        return;
      }
      if (!ports.select(target.dataset.id!)) return;
      checkTransition();
      const view = ports.read(),
        clip = view.snapshot.content.sequence.clips.find((c) => c.id === target.dataset.id)!;
      if (
        !view.canEdit ||
        view.snapshot.content.sequence.tracks.find((t) => t.id === clip.trackId)!.locked
      ) {
        render();
        return;
      }
      ports.begin();
      checkTransition();
      drag = {
        id: clip.id,
        mode: target.dataset.mode!,
        pointer: e.pointerId,
        x: e.clientX,
        scroll: scroll.scrollLeft,
        base: view.snapshot,
        delta: 0,
        px: px(),
        control: controls.contains(target) ? target : undefined,
      };
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      ports.gesture(true);
      e.preventDefault();
    });
  canvas.onpointermove = (e) =>
    guard(() => {
      if (!drag || e.pointerId !== drag.pointer) return;
      drag.delta = Math.round(
        ((e.clientX - drag.x + scroll.scrollLeft - drag.scroll) / drag.px) *
          seconds(drag.base.content.sequence.frameRate),
      );
      const c = drag.base.content.sequence.clips.find((c) => c.id === drag!.id)!;
      const delta = seconds(signedFrames(drag.delta, drag.base.content.sequence.frameRate));
      for (const member of drag.base.content.sequence.clips.filter(
        (x) =>
          x.id === c.id ||
          (drag!.mode === 'move' && c.linkGroupId && x.linkGroupId === c.linkGroupId),
      )) {
        const box = canvas.querySelector<HTMLElement>(`[data-clip-id="${member.id}"]`);
        if (!box) continue;
        box.style.left = `${(seconds(member.start) + (drag.mode === 'end' ? 0 : delta)) * drag.px}px`;
        box.style.width = `${Math.max(2, (seconds(member.duration) + (drag.mode === 'move' ? 0 : drag.mode === 'start' ? -delta : delta)) * drag.px)}px`;
        box.style.opacity = '.6';
      }
    });
  canvas.onpointerup = (e) =>
    guard(() => {
      if (!drag || e.pointerId !== drag.pointer) return;
      const old = drag;
      drag = undefined;
      if (canvas.hasPointerCapture(old.pointer)) canvas.releasePointerCapture(old.pointer);
      ports.gesture(false);
      checkTransition();
      try {
        ports.submit(editFor(old), old.base);
      } finally {
        render();
        if (!disposed && old.control && !old.control.disabled)
          old.control.focus({ preventScroll: true });
      }
    });
  canvas.onpointercancel = () => guard(cancel);
  canvas.onlostpointercapture = () => {
    if (drag) guard(cancel);
  };
  canvas.onkeydown = (e) =>
    guard(() => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        const control = drag?.control;
        cancel();
        if (!disposed && control && !control.disabled) control.focus({ preventScroll: true });
        return;
      }
      if (drag) return;
      const target = (e.target as Element).closest<HTMLButtonElement>('button[data-id]');
      const id = target?.dataset.id ?? ports.selected();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        ports.action(e.shiftKey ? 'Redo' : 'Undo');
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Delete' || e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!id || !ports.select(id)) return;
        checkTransition();
        ports.action(e.key === 'Delete' ? 'Delete linked clips' : 'Split linked clips');
        return;
      }
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !id) return;
      e.preventDefault();
      if (!ports.select(id)) return;
      const view = ports.read();
      if (!view.canEdit) return;
      ports.begin();
      checkTransition();
      ports.submit(
        editFor({
          id,
          mode: target?.dataset.mode ?? 'move',
          pointer: 0,
          x: 0,
          scroll: 0,
          base: view.snapshot,
          delta: e.key === 'ArrowRight' ? 1 : -1,
          px: px(),
        }),
        view.snapshot,
      );
      render();
    });
  controls.onpointerdown = (e) => {
    if ((e.target as Element).closest('button[data-id]')) canvas.onpointerdown?.call(canvas, e);
  };
  controls.onkeydown = canvas.onkeydown;
  root.append(controls);
  const onBlur = () => guard(cancel);
  doc.defaultView?.addEventListener('blur', onBlur);
  zoom.oninput = () =>
    guard(() => {
      cancel();
      render();
    });
  scroll.onscroll = () => guard(render);
  return {
    root,
    render,
    cancel,
    setFrame,
    getFrame: () => frame,
    dispose() {
      disposed = true;
      doc.defaultView?.removeEventListener('blur', onBlur);
      drag = undefined;
      root.remove();
    },
  };
}
