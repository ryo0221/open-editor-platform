import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { time, videoCommand, type VideoContent } from '@editor-platform/video-core';
import { videoTimelineFixture } from './edit-fixture';
import {
  assertVideoDemoContent,
  planVideoDemo,
  prepareVideoDemoOrder,
  createVideoDemoPreview,
  type VideoDemoFrame,
} from './demo';

function fixture(): VideoContent {
  const v = videoTimelineFixture();
  v.sequence.tracks = [v.sequence.tracks[0]];
  const clip = v.sequence.clips[0];
  if (clip.kind !== 'video') throw Error('fixture');
  v.sequence.clips = [
    clip,
    { ...clip, id: 'b', start: time(4), duration: time(1), sourceOut: time(3) },
  ];
  for (const c of v.sequence.clips) delete c.linkGroupId;
  return v;
}
const snapshot = (session = new EditorSession(fixture())) => ({
  scope: { artifactId: 'demo', sessionId: 'host', generation: 'one' },
  revision: session.revision,
  content: session.content,
});

describe('limited native video demo', () => {
  it('maps exact source times, gap, half-open boundaries and disabled track', () => {
    const v = fixture();
    expect(planVideoDemo(v, time(0)).kind).toBe('gap');
    expect(planVideoDemo(v, time(3)).kind).toBe('gap');
    expect(planVideoDemo(v, time(4))).toMatchObject({ clipId: 'b', sourceTime: time(2) });
    expect(planVideoDemo(v, time(11, 5))).toMatchObject({
      sourceTime: time(16, 5),
      sourceEnd: time(4),
    });
    expect(planVideoDemo(v, time(5)).kind).toBe('gap');
    expect(planVideoDemo(v, time(6)).kind).toBe('gap');
    v.sequence.tracks[0].enabled = false;
    expect(planVideoDemo(v, time(2)).kind).toBe('gap');
    expect(() => planVideoDemo(v, { value: NaN, timescale: 1 })).toThrow();
  });
  it('reorders in one history entry, preserving gaps/windows/duration and no-op Redo', () => {
    const s = new EditorSession(fixture()),
      original = s.content;
    const command = prepareVideoDemoOrder(snapshot(s), ['b', 'v']).command!;
    s.execute(command);
    expect(s.revision.sequence).toBe(1);
    expect(s.content.sequence.clips.find((c) => c.id === 'b')!.start).toEqual(time(1));
    expect(s.content.sequence.clips.find((c) => c.id === 'v')!.start).toEqual(time(3));
    expect(s.content.sequence.duration).toEqual(original.sequence.duration);
    expect(s.content.sources).toEqual(original.sources);
    s.undo();
    expect(s.content).toEqual(original);
    expect(prepareVideoDemoOrder(snapshot(s), ['v', 'b']).command).toBeNull();
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.revision.sequence).toBe(3);
  });
  it('trim/split map to Core source windows and a reordered split remains undoable', () => {
    const s = new EditorSession(fixture());
    s.execute(
      videoCommand({
        type: 'trim',
        clipId: 'v',
        start: time(3, 2),
        end: time(3),
        independent: true,
      }),
    );
    expect(planVideoDemo(s.content, time(3, 2))).toMatchObject({ sourceTime: time(5, 2) });
    s.execute(videoCommand({ type: 'split', clipId: 'v', at: time(2), rightIds: { v: 'right' } }));
    expect(planVideoDemo(s.content, time(2))).toMatchObject({
      clipId: 'right',
      sourceTime: time(3),
    });
    const before = s.content;
    s.execute(prepareVideoDemoOrder(snapshot(s), ['b', 'right', 'v']).command!);
    s.undo();
    expect(s.content).toEqual(before);
  });
  it('rejects invalid permutations and locked edits without partial mutation', () => {
    const s = new EditorSession(fixture());
    for (const ids of [['v'], ['v', 'v'], ['v', 'x']])
      expect(() => prepareVideoDemoOrder(snapshot(s), ids)).toThrow();
    const locked = s.content;
    locked.sequence.tracks[0].locked = true;
    expect(() => prepareVideoDemoOrder({ ...snapshot(s), content: locked }, ['b', 'v'])).toThrow(
      'Locked',
    );
    expect(s.revision.sequence).toBe(0);
  });
  it('refuses audio, speed and multi-track subsets rather than silently dropping them', () => {
    expect(() => assertVideoDemoContent(videoTimelineFixture())).toThrow('VideoDemoSubset');
    const v = fixture();
    v.sequence.tracks.push({ id: 'other', kind: 'visual', enabled: true, locked: false });
    expect(() => assertVideoDemoContent(v)).toThrow('VideoDemoSubset');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function previewFixture() {
  const abort = new AbortController();
  const requests: { signal: AbortSignal; task: ReturnType<typeof deferred<VideoDemoFrame>> }[] = [];
  const port = {
    pause: vi.fn(),
    clear: vi.fn(),
    prepare: vi.fn((_plan: unknown, signal: AbortSignal) => {
      const task = deferred<VideoDemoFrame>();
      requests.push({ signal, task });
      return task.promise;
    }),
  };
  const preview = createVideoDemoPreview(port, abort.signal);
  preview.update(snapshot());
  const frame = () => ({ present: vi.fn(), release: vi.fn() });
  return { abort, port, preview, requests, frame };
}
describe('Host preview coordination', () => {
  it('discards out-of-order seeks and releases every detached frame', async () => {
    const { preview, requests, frame } = previewFixture();
    const old = preview.render(time(1)),
      newer = preview.render(time(2));
    expect(requests[0].signal.aborted).toBe(true);
    const a = frame(),
      b = frame();
    requests[1].task.resolve(b);
    expect(await newer).toBe('frame');
    requests[0].task.resolve(a);
    expect(await old).toBe('superseded');
    expect(a.present).not.toHaveBeenCalled();
    expect(a.release).toHaveBeenCalledOnce();
    expect(b.present).toHaveBeenCalledOnce();
    expect(b.release).toHaveBeenCalledOnce();
    preview.dispose();
  });
  it.each(['gap', 'update', 'abort', 'dispose'] as const)(
    '%s clears/invalidate pending media',
    async (mode) => {
      const { preview, requests, frame, abort, port } = previewFixture();
      const pending = preview.render(time(1));
      if (mode === 'gap') expect(await preview.render(time(0))).toBe('gap');
      if (mode === 'update') preview.update(snapshot());
      if (mode === 'abort') abort.abort();
      if (mode === 'dispose') preview.dispose();
      const f = frame();
      requests[0].task.resolve(f);
      expect(await pending).toBe('superseded');
      expect(f.present).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
      expect(port.clear).toHaveBeenCalled();
      if (mode !== 'gap') expect(port.pause.mock.calls.length).toBeGreaterThan(1);
      preview.dispose();
    },
  );
  it('stops old media before rejecting invalid update, and scopes cannot be reused', async () => {
    const { preview, port } = previewFixture();
    const bad = snapshot();
    bad.content = videoTimelineFixture();
    expect(() => preview.update(bad)).toThrow();
    expect(port.pause).toHaveBeenCalledTimes(2);
    await expect(preview.render(time(1))).rejects.toThrow('NoVideoSnapshot');
    const other = snapshot();
    other.scope.generation = 'two';
    expect(() => preview.update(other)).toThrow('ScopeChanged');
    await expect(preview.render(time(1))).rejects.toThrow('ScopeRevoked');
  });
  it('reports current decode errors, suppresses stale failures and clears visible media', async () => {
    const { preview, requests, port } = previewFixture();
    const first = preview.render(time(1));
    await preview.render(time(0));
    requests[0].task.reject(Error('old decode'));
    expect(await first).toBe('superseded');
    const current = preview.render(time(1));
    requests[1].task.reject(Error('decode failed'));
    await expect(current).rejects.toThrow('decode failed');
    expect(port.pause).toHaveBeenCalledTimes(2);
    preview.dispose();
  });
  it('does not admit an already revoked scope', async () => {
    const abort = new AbortController();
    abort.abort();
    const p = createVideoDemoPreview(
      { pause: vi.fn(), clear: vi.fn(), prepare: vi.fn() },
      abort.signal,
    );
    expect(() => p.update(snapshot())).toThrow('ScopeRevoked');
    await expect(p.render(time(1))).rejects.toThrow('ScopeRevoked');
  });
});

describe('preview callback reentrancy', () => {
  it('update pause refuses old-snapshot render; retired frames release exactly once', async () => {
    const { preview, port, requests, frame } = previewFixture();
    const old = preview.render(time(1));
    let attempted!: ReturnType<typeof preview.render>;
    port.pause.mockImplementationOnce(() => {
      attempted = preview.render(time(1));
    });
    const changed = snapshot();
    const clip = changed.content.sequence.clips[0];
    if (clip.kind !== 'video') throw Error('fixture');
    clip.sourceIn = time(1);
    clip.sourceOut = time(3);
    preview.update(changed);
    // Drain any incorrectly admitted reentrant work so the old code fails on a
    // resolved stale frame, rather than merely timing out on the expected refusal.
    for (const request of requests.slice(1)) request.task.resolve(frame());
    await expect(attempted).rejects.toThrow('NoVideoSnapshot');
    const newer = preview.render(time(1));
    expect(port.prepare.mock.calls.at(-1)![0]).toMatchObject({ sourceTime: time(1) });
    const stale = frame(),
      fresh = frame();
    requests[0].task.resolve(stale);
    requests[1].task.resolve(fresh);
    expect(await old).toBe('superseded');
    expect(await newer).toBe('frame');
    expect(stale.present).not.toHaveBeenCalled();
    expect(stale.release).toHaveBeenCalledOnce();
    expect(fresh.present).toHaveBeenCalledOnce();
    expect(fresh.release).toHaveBeenCalledOnce();
    preview.dispose();
    expect(stale.release).toHaveBeenCalledOnce();
    expect(fresh.release).toHaveBeenCalledOnce();
  });

  it('clear-started newer seek owns presentation; the outer seek is superseded', async () => {
    const { preview, port, requests, frame } = previewFixture();
    let newer!: ReturnType<typeof preview.render>;
    port.clear.mockImplementationOnce(() => {
      newer = preview.render(time(2));
    });
    const older = preview.render(time(1));
    for (const request of requests) request.task.resolve(frame());
    expect(await newer).toBe('frame');
    expect(await older).toBe('superseded');
    expect(requests).toHaveLength(1);
    preview.dispose();
  });
  it('scope abort inside clear returns superseded without reading a deleted snapshot', async () => {
    const { preview, port, abort, requests } = previewFixture();
    port.clear.mockImplementationOnce(() => abort.abort());
    await expect(preview.render(time(1))).resolves.toBe('superseded');
    expect(requests).toHaveLength(0);
  });
  it('abort-listener reentry retains the newer pending controller', async () => {
    const { preview, requests, frame } = previewFixture();
    const first = preview.render(time(1));
    let newer!: ReturnType<typeof preview.render>;
    requests[0].signal.addEventListener(
      'abort',
      () => {
        newer = preview.render(time(2));
      },
      { once: true },
    );
    const outer = preview.render(time(1));
    await preview.render(time(0));
    expect(requests[1].signal.aborted).toBe(true);
    for (const request of requests) request.task.resolve(frame());
    expect(await first).toBe('superseded');
    expect(await outer).toBe('superseded');
    expect(await newer).toBe('superseded');
    expect(requests).toHaveLength(2);
    preview.dispose();
  });
  it('scope abort in update pause cannot restore a retired snapshot', () => {
    const { preview, port, abort } = previewFixture();
    port.pause.mockImplementationOnce(() => abort.abort());
    expect(() => preview.update(snapshot())).toThrow('ScopeRevoked');
  });
  it('decode-error pause reentry cannot clear the newer operation', async () => {
    const { preview, port, requests, frame } = previewFixture();
    const old = preview.render(time(1));
    let newer!: ReturnType<typeof preview.render>;
    port.pause.mockImplementationOnce(() => {
      newer = preview.render(time(2));
    });
    const clears = port.clear.mock.calls.length;
    requests[0].task.reject(Error('decode failed'));
    await expect(old).resolves.toBe('superseded');
    expect(port.clear.mock.calls.length).toBe(clears + 1);
    requests[1].task.resolve(frame());
    expect(await newer).toBe('frame');
    preview.dispose();
  });
});
