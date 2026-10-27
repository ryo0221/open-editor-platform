import type { EditorCommand } from '@editor-platform/editor-core';
import type { Track } from './model';
import { add, compare, subtract, time, type Time } from './time';

/** Placement fields shared by every schema version's clips. */
interface TimelineClip {
  id: string;
  trackId: string;
  start: Time;
  duration: Time;
  linkGroupId?: string;
}
interface TimelineContent<C extends TimelineClip> {
  sequence: { duration: Time; tracks: Track[]; clips: C[] };
}
export type TimelineEdit<C> =
  | { type: 'insert'; clip: C }
  | { type: 'move'; clipId: string; delta: Time }
  | { type: 'trim'; clipId: string; start: Time; end: Time; independent: true }
  | {
      type: 'split';
      clipId: string;
      at: Time;
      rightIds: Record<string, string>;
      rightLinkGroupId?: string;
    }
  | { type: 'delete'; clipId: string }
  | { type: 'link'; clipIds: string[]; groupId: string }
  | { type: 'unlink'; clipId: string }
  | { type: 'ripple-delete'; trackIds: string[]; start: Time; end: Time }
  | { type: 'ripple-insert-gap'; trackIds: string[]; at: Time; duration: Time }
  | { type: 'resize'; duration: Time };

/** What differs between schema versions; edit semantics are shared. */
export interface TimelineSchema<V extends TimelineContent<C>, C extends TimelineClip> {
  /** Command type prefix, e.g. `video.prototype.v1`. */
  commandType: string;
  /** Version named in unsupported-edit messages, e.g. `v0`. */
  version: string;
  assert(value: unknown): asserts value is V;
  /** Domain-owned dependent metadata updated atomically before final validation. */
  afterEdit?(content: V, edit: TimelineEdit<C>): void;
  /** Re-window `clip` to `[start, end)` in its source coordinates. */
  slice(content: V, clip: C, start: Time, end: Time): C;
}

const endOf = (c: TimelineClip) => add(c.start, c.duration);
export function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Edit<C, T extends TimelineEdit<C>['type']> = Extract<TimelineEdit<C>, { type: T }>;
class TimelineEditor<V extends TimelineContent<C>, C extends TimelineClip> {
  constructor(
    readonly schema: TimelineSchema<V, C>,
    readonly v: V,
  ) {}
  get q() {
    return this.v.sequence;
  }
  select(id: string): C {
    const c = this.q.clips.find((c) => c.id === id);
    need(c, 'Missing clip');
    return c;
  }
  group(clip: C): C[] {
    return this.q.clips.filter(
      (c) => c.id === clip.id || (clip.linkGroupId && c.linkGroupId === clip.linkGroupId),
    );
  }
  unlocked(clips: C[]) {
    need(
      clips.every((c) => !this.q.tracks.find((t) => t.id === c.trackId)?.locked),
      'Locked track',
    );
  }
  slice(clip: C, start: Time, end: Time): C {
    need(compare(start, end) < 0, 'Empty clip');
    return this.schema.slice(this.v, clip, start, end);
  }

  insert(e: Edit<C, 'insert'>) {
    this.unlocked([e.clip]);
    this.q.clips.push(structuredClone(e.clip));
  }
  ripple(e: Edit<C, 'ripple-delete' | 'ripple-insert-gap'>) {
    const q = this.q;
    need(
      e.trackIds.length > 0 && new Set(e.trackIds).size === e.trackIds.length,
      'Invalid ripple cohort',
    );
    need(
      e.trackIds.every((id) => q.tracks.some((t) => t.id === id && !t.locked)),
      'Missing or locked ripple track',
    );
    const isDelete = e.type === 'ripple-delete';
    const start = isDelete ? e.start : e.at;
    const end = isDelete ? e.end : e.at;
    const delta = isDelete ? subtract(start, end) : e.duration;
    need(
      compare(start, time(0)) >= 0 &&
        compare(end, q.duration) <= 0 &&
        (isDelete ? compare(start, end) < 0 : compare(delta, time(0)) > 0),
      'Invalid ripple interval',
    );
    const affected = q.clips.filter(
      (c) => e.trackIds.includes(c.trackId) && compare(endOf(c), start) > 0,
    );
    const crosses = (c: C, at: Time) => compare(c.start, at) < 0 && compare(endOf(c), at) > 0;
    for (const c of affected) {
      need(
        this.group(c).every((member) => affected.includes(member)),
        'Ripple excludes linked member',
      );
      need(
        !crosses(c, start) && !crosses(c, end),
        `Crossing ripple clip unsupported in ${this.schema.version}`,
      );
    }
    if (isDelete)
      for (const c of affected) {
        const removed = compare(c.start, end) < 0;
        need(
          this.group(c).every((member) => compare(member.start, end) < 0 === removed),
          'Ripple would separate a linked group',
        );
      }
    this.unlocked(affected);
    q.clips = q.clips.flatMap((c) => {
      if (!affected.includes(c)) return [c];
      if (isDelete && compare(c.start, end) < 0) return [];
      return [{ ...c, start: add(c.start, delta) }];
    });
  }
  link(e: Edit<C, 'link'>) {
    need(
      e.clipIds.length >= 2 && new Set(e.clipIds).size === e.clipIds.length,
      'Link requires distinct clips',
    );
    need(!this.q.clips.some((c) => c.linkGroupId === e.groupId), 'Link group already exists');
    const clips = e.clipIds.map((id) => this.select(id));
    this.unlocked(clips);
    need(
      clips.every((c) => !c.linkGroupId),
      'Unlink existing groups first',
    );
    for (const c of clips) c.linkGroupId = e.groupId;
  }
  /** Edits addressed to one clip; linked members follow unless trimming. */
  clipEdit(e: Edit<C, 'move' | 'trim' | 'delete' | 'unlink' | 'split'>) {
    const clip = this.select(e.clipId);
    const targets = e.type === 'trim' ? [clip] : this.group(clip);
    this.unlocked(targets);
    if (e.type === 'move') for (const c of targets) c.start = add(c.start, e.delta);
    else if (e.type === 'trim') {
      need(e.independent === true, 'Independent trim must be explicit');
      this.q.clips = this.q.clips.map((c) =>
        c.id === clip.id ? this.slice(c, e.start, e.end) : c,
      );
    } else if (e.type === 'delete') this.q.clips = this.q.clips.filter((c) => !targets.includes(c));
    else if (e.type === 'unlink') for (const c of targets) delete c.linkGroupId;
    else if (e.type === 'split') this.split(e, clip, targets);
    else throw new Error('Unsupported video command');
  }
  split(e: Edit<C, 'split'>, clip: C, targets: C[]) {
    const q = this.q;
    need(
      Object.keys(e.rightIds).length === targets.length &&
        targets.every((c) => Object.hasOwn(e.rightIds, c.id)),
      'Provide exact split ID map',
    );
    need(
      targets.length === 1
        ? e.rightLinkGroupId === undefined
        : !!e.rightLinkGroupId &&
            e.rightLinkGroupId !== clip.linkGroupId &&
            !q.clips.some((c) => c.linkGroupId === e.rightLinkGroupId),
      'New right link group required',
    );
    const rights: C[] = [];
    q.clips = q.clips.map((c) => {
      if (!targets.includes(c)) return c;
      need(
        compare(c.start, e.at) < 0 && compare(e.at, endOf(c)) < 0,
        'Split must be interior to every linked clip',
      );
      const right = { ...this.slice(c, e.at, endOf(c)), id: e.rightIds[c.id] };
      if (e.rightLinkGroupId) right.linkGroupId = e.rightLinkGroupId;
      rights.push(right);
      return this.slice(c, c.start, e.at);
    });
    q.clips.push(...rights);
  }
  apply(e: TimelineEdit<C>) {
    if (e.type === 'insert') this.insert(e);
    else if (e.type === 'resize') this.q.duration = e.duration;
    else if (e.type === 'ripple-delete' || e.type === 'ripple-insert-gap') this.ripple(e);
    else if (e.type === 'link') this.link(e);
    else this.clipEdit(e);
    if (e.type !== 'resize')
      for (const c of this.q.clips)
        if (compare(endOf(c), this.q.duration) > 0) this.q.duration = endOf(c);
  }
}

/** Trusted local code only. Host authorization/stale checks occur at submission. */
export function timelineCommand<V extends TimelineContent<C>, C extends TimelineClip>(
  schema: TimelineSchema<V, C>,
  edit: TimelineEdit<C>,
): EditorCommand<V> {
  const owned = structuredClone(edit);
  return {
    type: `${schema.commandType}.${owned.type}`,
    label: `Video ${owned.type}`,
    readonlyInput: true,
    reads: { content: ['*'] },
    apply(input) {
      schema.assert(input);
      const v = structuredClone(input);
      new TimelineEditor(schema, v).apply(owned);
      schema.afterEdit?.(v, owned);
      schema.assert(v);
      // Do not expose captured edit objects through the returned snapshot.
      return structuredClone(v);
    },
  };
}
