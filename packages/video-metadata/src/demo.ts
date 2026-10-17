import { canonicalJson } from '@editor-platform/artifact-core';
import {
  add,
  subtract,
  compare,
  isTime,
  time,
  assertVideoContent,
  evaluateSequence,
  videoCommand,
  type VideoContent,
  type Time,
  type MediaAssetRef,
} from '@editor-platform/video-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { PreparedSurfaceCommand } from '@editor-platform/extension-contract/controlled-surface';

type Snapshot = LocalReadSnapshot<VideoContent>;
/** Limited demo subset, not a new native schema. Audio bytes must also be excluded by Host. */
export function assertVideoDemoContent(content: VideoContent): void {
  assertVideoContent(content);
  if (
    content.sequence.tracks.length !== 1 ||
    content.sequence.tracks[0].kind !== 'visual' ||
    content.sources.length > 2 ||
    content.sequence.clips.some(
      (c) => c.kind !== 'video' || compare(c.rate, time(1)) !== 0 || c.linkGroupId !== undefined,
    )
  )
    throw Error('VideoDemoSubset: one visual track, at most two sources, unlinked unit-rate video');
}
export type VideoDemoPlan =
  | { kind: 'gap'; at: Time }
  | {
      kind: 'frame';
      at: Time;
      clipId: string;
      sourceId: string;
      streamId: string;
      asset: MediaAssetRef;
      sourceTime: Time;
      sourceStart: Time;
      sourceEnd: Time;
    };
/** The same half-open source mapping as Core; no frame-index/fps inference or URL. */
export function planVideoDemo(content: VideoContent, at: Time): VideoDemoPlan {
  assertVideoDemoContent(content);
  // Validate even when the sequence is empty or at a gap.
  if (!isTime(at)) throw Error('Invalid preview time');
  const request = evaluateSequence(content, at)[0];
  if (!request) return { kind: 'gap', at: structuredClone(at) };
  const clip = content.sequence.clips.find((c) => c.id === request.clipId)!;
  if (clip.kind !== 'video') throw Error('VideoDemoSubset');
  const asset = content.sources.find((s) => s.id === request.sourceId)!.asset;
  return structuredClone({
    kind: 'frame',
    at,
    ...request,
    asset,
    sourceStart: clip.sourceIn,
    sourceEnd: clip.sourceOut,
  });
}
/** Permute all clips; retain leading/inter-slot gaps, source windows and sequence duration.
 * Intermediate parking uses existing native move commands but is never committed/observable.
 * One prepared command is submitted through the existing authority/revision/input controller.
 */
export function prepareVideoDemoOrder(
  snapshot: Snapshot,
  clipIds: readonly string[],
): PreparedSurfaceCommand<VideoContent> {
  const ids = [...clipIds];
  const apply = (input: VideoContent): VideoContent => {
    assertVideoDemoContent(input);
    const clips = [...input.sequence.clips].sort((a, b) => compare(a.start, b.start));
    if (
      ids.length !== clips.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !clips.some((c) => c.id === id))
    )
      throw Error('Provide an exact clip permutation');
    if (ids.every((id, i) => id === clips[i].id)) return structuredClone(input);
    const gaps = clips.map((c, i) =>
      subtract(c.start, i ? add(clips[i - 1].start, clips[i - 1].duration) : time(0)),
    );
    let next = input;
    let parking = input.sequence.duration;
    for (const c of clips) {
      next = videoCommand({ type: 'move', clipId: c.id, delta: subtract(parking, c.start) }).apply(
        next,
      );
      parking = add(parking, c.duration);
    }
    let cursor = time(0);
    ids.forEach((id, index) => {
      cursor = add(cursor, gaps[index]);
      const parked = next.sequence.clips.find((c) => c.id === id)!;
      next = videoCommand({
        type: 'move',
        clipId: id,
        delta: subtract(cursor, parked.start),
      }).apply(next);
      cursor = add(cursor, parked.duration);
    });
    return videoCommand({ type: 'resize', duration: input.sequence.duration }).apply(next);
  };
  const next = apply(snapshot.content);
  return {
    baseRevision: snapshot.revision,
    command:
      canonicalJson(next) === canonicalJson(snapshot.content)
        ? null
        : {
            type: 'video.demo.order',
            label: 'Reorder video clips',
            readonlyInput: true,
            reads: { content: ['*'] },
            apply,
          },
  };
}

export interface VideoDemoFrame {
  /** Synchronous display of a detached prepared frame. Never start decoder work here. */
  present(): void;
  /** Idempotent release of bitmap/decoder lease, including discarded stale frames. */
  release(): void;
}
export interface VideoDemoPreviewPort {
  /** Host owns the private play clock and MUST stop it synchronously here. */
  pause(): void;
  /** Hide the prior frame immediately. Never imply missing media is a successful decode. */
  clear(): void;
  /** Host decodes immutable verified bytes. Must not touch visible output until present().
   * Respect abort, reject unsupported/missing sources; do not return a previous seek's frame.
   */
  prepare(
    plan: Extract<VideoDemoPlan, { kind: 'frame' }>,
    signal: AbortSignal,
  ): Promise<VideoDemoFrame>;
}
/** Host experimental adapter coordination, not an extension Resource capability.
 * Host supplies snapshots only after its scoped read checks, and calls update on content changes.
 * Host play ticks may call render; edits/update always pause. No session/history/clock is owned here.
 */
export function createVideoDemoPreview(port: VideoDemoPreviewPort, signal: AbortSignal) {
  let snapshot: Snapshot | undefined;
  let pending: AbortController | undefined;
  let generation = 0;
  let disposed = false;
  let identity: string | undefined;
  const cancel = () => {
    // Claim before abort dispatches synchronous Host listeners. Never clear a newer controller.
    const token = ++generation;
    const previous = pending;
    pending = undefined;
    previous?.abort();
    return token;
  };
  const current = (token: number) => !disposed && !signal.aborted && generation === token;
  const assertCurrent = (token: number) => {
    if (disposed || signal.aborted) throw Error('ScopeRevoked');
    if (generation !== token) throw Error('VideoPreviewSuperseded');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    snapshot = undefined;
    signal.removeEventListener('abort', dispose);
    cancel();
    try {
      port.pause();
    } finally {
      port.clear();
    }
  };
  if (signal.aborted) dispose();
  else signal.addEventListener('abort', dispose, { once: true });
  return {
    update(value: Snapshot) {
      if (disposed) throw Error('ScopeRevoked');
      const key = canonicalJson(value.scope);
      if (identity !== undefined && key !== identity) {
        dispose();
        throw Error('ScopeChanged: create a new preview');
      }
      // Invalid content must not leave the previous movie running/visible.
      snapshot = undefined;
      const token = cancel();
      assertCurrent(token);
      port.pause();
      assertCurrent(token);
      port.clear();
      assertCurrent(token);
      assertVideoDemoContent(value.content);
      identity = key;
      snapshot = structuredClone(value);
    },
    async render(at: Time): Promise<'frame' | 'gap' | 'superseded'> {
      if (disposed) throw Error('ScopeRevoked');
      if (!snapshot) throw Error('NoVideoSnapshot');
      const captured = snapshot;
      const token = cancel();
      if (!current(token)) return 'superseded';
      port.clear();
      if (!current(token)) return 'superseded';
      const plan = planVideoDemo(captured.content, at);
      if (plan.kind === 'gap') return 'gap';
      const controller = new AbortController();
      pending = controller;
      let frame: VideoDemoFrame | undefined;
      try {
        frame = await port.prepare(plan, controller.signal);
        if (!current(token) || controller.signal.aborted) return 'superseded';
        frame.present();
        return current(token) ? 'frame' : 'superseded';
      } catch (error) {
        if (!current(token) || controller.signal.aborted) return 'superseded';
        port.pause();
        if (!current(token)) return 'superseded';
        port.clear();
        if (!current(token)) return 'superseded';
        throw error;
      } finally {
        frame?.release();
        if (pending === controller) pending = undefined;
      }
    },
    dispose,
  };
}
