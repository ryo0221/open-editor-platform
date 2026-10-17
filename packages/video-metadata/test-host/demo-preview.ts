/** TEST ONLY: detached browser decoder port. Production Host owns its own adapter. */
import { EditorSession } from '@editor-platform/editor-core';
import { time, type VideoContent, type VideoEdit } from '@editor-platform/video-core';
import {
  createVideoDemoPreview,
  prepareVideoDemoOrder,
  type VideoDemoPreviewPort,
} from '../src/demo';
import { prepareVideoTimelineEdit } from '../src/edit';
export async function startDemoPreview(content: VideoContent) {
  const session = new EditorSession(content),
    scopeAbort = new AbortController();
  const blobs = new Map<string, Blob>();
  for (const source of content.sources) {
    const blob = await (await fetch(`/${source.id}.webm`)).blob();
    const bytes = await blob.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
    if (digest !== source.asset.sha256 || blob.size !== source.asset.byteLength)
      throw Error('Fixture bytes mismatch');
    blobs.set(source.asset.assetId, blob);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d')!;
  let activeURLs = 0,
    released = 0,
    pauses = 0,
    playing = false,
    heldReady = false;
  let holdNext = false,
    releaseHold = () => {};
  const shown: { clipId: string; mediaTime: number; sourceTime: number }[] = [];
  const port: VideoDemoPreviewPort = {
    pause() {
      pauses++;
      playing = false;
    },
    clear() {
      ctx.clearRect(0, 0, 64, 48);
    },
    async prepare(plan, signal) {
      const blob = blobs.get(plan.asset.assetId);
      if (!blob) throw Error('Missing fixture');
      const url = URL.createObjectURL(blob);
      activeURLs++;
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      let bitmap: ImageBitmap | undefined;
      const shouldHold = holdNext;
      holdNext = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => finish(Error('load timeout')), 5000);
          const abort = () => finish(Error('load aborted'));
          const finish = (error?: Error) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            v.onloadeddata = null;
            v.onerror = null;
            if (error) reject(error);
            else resolve();
          };
          signal.addEventListener('abort', abort, { once: true });
          v.onloadeddata = () => finish();
          v.onerror = () => finish(Error('decode load'));
          if (signal.aborted) abort();
          else v.src = url;
        });
        const target = plan.sourceTime.value / plan.sourceTime.timescale;
        // TEST FIXTURE ONLY: ffprobe verifies every packet at 100 ms intervals.
        // A newly loaded video's queued initial frame is not the requested seek.
        const expectedPTS = Math.floor(target * 10 + 1e-8) / 10;
        if (
          expectedPTS < plan.sourceStart.value / plan.sourceStart.timescale ||
          expectedPTS >= plan.sourceEnd.value / plan.sourceEnd.timescale
        )
          throw Error('Fixture frame outside source window');
        const mediaTime = await new Promise<number>((resolve, reject) => {
          let lastPTS: number | undefined;
          const timer = setTimeout(
            () => finish(undefined, Error(`seek timeout: expected ${expectedPTS}, last ${lastPTS}`)),
            5000,
          );
          let callback = 0,
            finished = false;
          const abort = () => finish(undefined, Error('seek aborted'));
          const finish = (pts?: number, error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            v.cancelVideoFrameCallback(callback);
            if (error) reject(error);
            else resolve(pts!);
          };
          const ready: VideoFrameRequestCallback = (_now, meta) => {
            if (finished) return;
            lastPTS = meta.mediaTime;
            if (Math.abs(meta.mediaTime - expectedPTS) <= 0.000001) finish(meta.mediaTime);
            else callback = v.requestVideoFrameCallback(ready);
          };
          signal.addEventListener('abort', abort, { once: true });
          callback = v.requestVideoFrameCallback(ready);
          if (signal.aborted) abort();
          // Seek inside the verified interval, not an ambiguous decimal boundary.
          // Returned mediaTime must still match the exact fixture PTS above.
          else v.currentTime = expectedPTS + 0.05;
        });
        bitmap = await createImageBitmap(v);
        // Deliberate uncooperative late response to exercise domain stale-frame disposal.
        if (shouldHold)
          await new Promise<void>((resolve) => {
            heldReady = true;
            releaseHold = () => {
              heldReady = false;
              resolve();
            };
          });
        const frame = bitmap;
        bitmap = undefined;
        let closed = false;
        return {
          present() {
            if (closed) throw Error('Closed frame');
            ctx.drawImage(frame, 0, 0);
            shown.push({ clipId: plan.clipId, mediaTime, sourceTime: target });
          },
          release() {
            if (!closed) {
              closed = true;
              released++;
              frame.close();
            }
          },
        };
      } finally {
        bitmap?.close();
        v.pause();
        v.removeAttribute('src');
        v.load();
        URL.revokeObjectURL(url);
        activeURLs--;
      }
    },
  };
  const preview = createVideoDemoPreview(port, scopeAbort.signal);
  const snapshot = () => ({
    scope: { artifactId: 'demo', sessionId: 'host', generation: 'one' },
    revision: session.revision,
    content: session.content,
  });
  const update = () => preview.update(snapshot());
  update();
  return {
    render: (n: number, d = 1) => preview.render(time(n, d)),
    edit(edit: VideoEdit) {
      const p = prepareVideoTimelineEdit(snapshot(), edit);
      if (p.command) {
        session.execute(p.command);
        update();
      }
    },
    order(ids: string[]) {
      const p = prepareVideoDemoOrder(snapshot(), ids);
      if (p.command) {
        session.execute(p.command);
        update();
      }
    },
    undo() {
      session.undo();
      update();
    },
    redo() {
      session.redo();
      update();
    },
    evidence: () => ({
      shown,
      pixel: Array.from(ctx.getImageData(32, 24, 1, 1).data),
      activeURLs,
      released,
      pauses,
      playing,
      heldReady,
      revision: session.revision,
      canRedo: session.canRedo,
      content: session.content,
    }),
    hold() {
      holdNext = true;
    },
    release() {
      releaseHold();
    },
    startClock() {
      playing = true;
    },
    revoke() {
      scopeAbort.abort();
    },
    dispose() {
      preview.dispose();
    },
  };
}
type Demo = Awaited<ReturnType<typeof startDemoPreview>>;
type Start = typeof startDemoPreview;
declare global {
  var demoPreview: Demo;
  var startDemoPreview: Start;
}
Object.assign(globalThis, { startDemoPreview });
