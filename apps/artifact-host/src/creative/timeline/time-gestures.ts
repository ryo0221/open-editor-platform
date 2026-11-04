/** Pointer/keyboard time edits share the form's native command and asynchronous Host boundary. */
import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEventHandler } from 'react';
import type { TimelineWorldEntry } from './projection';
import type { TimelineWorkbench } from './workbench';
import type { Notice } from './edit';
import type { TimelineTimeInput } from './commands';
import { shiftEventTime } from './time-move';
type Edit = { workbench: TimelineWorkbench; notify(n: Notice): void };
type Gesture = {
  entry: TimelineWorldEntry;
  owner: string;
  id: string;
  w: TimelineWorkbench;
  controller: AbortController;
  ticket: ReturnType<TimelineWorkbench['watch']>;
  remove(): void;
  phase: 'drag' | 'validating';
};
export function useEventTimeGestures(edit: Edit | undefined, enabled: boolean) {
  const active = useRef<Gesture | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const latest = useRef(edit);
  latest.current = edit;
  const finish = () => {
    const g = active.current;
    active.current = undefined;
    g?.controller.abort();
    g?.ticket.cancel();
    g?.remove();
    setPending(false);
  };
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active.current) return;
      e.preventDefault();
      finish();
      latest.current?.notify({ ok: true, text: '時点の移動を取り消しました。' });
    };
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('keydown', cancel);
      finish();
    };
  }, [edit?.workbench]);
  const movable = (e: TimelineWorldEntry) =>
    enabled &&
    !!edit &&
    !e.inherited &&
    !['unset', 'derived'].includes(e.time.kind) &&
    edit.workbench.editable(e.key.split('#')[0]);
  const begin = (entry: TimelineWorldEntry): Gesture | undefined => {
    if (!edit || !movable(entry) || active.current) return;
    const w = edit.workbench;
    const [owner, id] = entry.key.split('#');
    const o = w.owner(owner)!;
    const input = o.inputs.getSnapshot();
    if (input.dirty || input.composing || input.settling) {
      edit.notify({
        ok: false,
        text: '未確定の入力を確定または取消してから時点を移動してください。',
      });
      return;
    }
    const ticket = w.watch(owner, 'gesture:' + id, () => [
      w.links.story,
      ...w.ownersOf('ledger').map((l) => [l.id, l.editor.revision]),
      w.owner(w.links.story.worldSettings)?.editor.revision,
    ]);
    const controller = new AbortController();
    const remove = o.forms.register({
      dirty: () => true,
      focus() {},
      consume() {},
      finalize() {},
      prepare() {
        throw Error('時点の移動中です。完了または取消してください。');
      },
    });
    const g: Gesture = { entry, owner, id, w, controller, ticket, remove, phase: 'drag' };
    active.current = g;
    return g;
  };
  const apply = async (g: Gesture, days: number) => {
    g.phase = 'validating';
    setPending(true);
    try {
      g.ticket.assert();
      if (days === 0) return;
      const command = await g.w.prepareTimeEdit(
        g.owner,
        g.id,
        () => shiftEventTime(g.id, days, g.entry.time as TimelineTimeInput),
        g.controller.signal,
      );
      g.ticket.assert();
      const r = g.w.run(g.owner, () => ({
        ...command,
        apply: (content) => {
          g.ticket.assert();
          return command.apply(content);
        },
      }));
      latest.current?.notify(
        r.ok
          ? { ok: true, text: `${g.id} の時点を${days > 0 ? '+' : ''}${days}日移動しました。` }
          : { ok: false, text: r.message },
      );
      if (r.ok)
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-tl-focus="event:${CSS.escape(g.entry.key)}"]`)
            ?.focus(),
        );
    } catch (error) {
      if (!g.controller.signal.aborted)
        latest.current?.notify({
          ok: false,
          text: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (active.current === g) finish();
    }
  };
  return {
    pending,
    props(entry: TimelineWorldEntry): {
      drag: HTMLAttributes<HTMLLIElement>;
      onKeyDown: KeyboardEventHandler<HTMLButtonElement>;
    } {
      return {
        drag: {
          draggable: movable(entry) && entry.onWorldClock?.start !== undefined,
          onDragStart: (e) => {
            if (entry.onWorldClock?.start === undefined) {
              e.preventDefault();
              return;
            }
            const g = begin(entry);
            if (!g) {
              e.preventDefault();
              return;
            }
            e.dataTransfer.setData('text/plain', entry.key);
            e.dataTransfer.effectAllowed = 'move';
          },
          onDragOver: (e) => {
            if (active.current?.phase === 'drag' && entry.onWorldClock?.start !== undefined)
              e.preventDefault();
          },
          onDrop: (e) => {
            const g = active.current;
            if (!g || g.phase !== 'drag') return;
            e.preventDefault();
            const from = g.entry.onWorldClock?.start,
              to = entry.onWorldClock?.start;
            if (from === undefined || to === undefined) {
              finish();
              return;
            }
            void apply(g, to - from);
          },
          onDragEnd: () => {
            if (active.current?.phase === 'drag') finish();
          },
        },
        onKeyDown: (e) => {
          if (
            !e.altKey ||
            e.ctrlKey ||
            e.metaKey ||
            e.shiftKey ||
            e.nativeEvent.isComposing ||
            !['ArrowLeft', 'ArrowRight'].includes(e.key) ||
            !movable(entry)
          )
            return;
          e.preventDefault();
          if (e.repeat) return;
          const g = begin(entry);
          if (g) void apply(g, e.key === 'ArrowRight' ? 1 : -1);
        },
      };
    },
  };
}
