import { add, subtract, multiply, compare, type Time } from '@editor-platform/video-core';
import type { ExportSnapshot } from './export';
/** Browser reference only; never advertised as exact audio/frame output. */
export async function referencePreview(
  snapshot: ExportSnapshot,
  at: Time,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  reason: string,
) {
  const c = snapshot.native.content;
  const clip = c.sequence.clips.find(
    (x) =>
      x.kind === 'video' && compare(x.start, at) <= 0 && compare(at, add(x.start, x.duration)) < 0,
  );
  if (!clip || clip.kind !== 'video') throw Error('No reference video at this timeline time');
  const original = snapshot.originals.find((x) => x.sourceId === clip.sourceId);
  if (!original) throw Error('Missing reference original');
  const video = document.createElement('video'),
    url = URL.createObjectURL(original.bytes);
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  const wait = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(Error('Reference preview timeout')), 10000);
      const done = () => finish(),
        fail = () => finish(Error('Browser codec unavailable')),
        abort = () => finish(signal.reason);
      function finish(error?: unknown) {
        clearTimeout(timer);
        video.removeEventListener(event, done);
        video.removeEventListener('error', fail);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      }
      signal.throwIfAborted();
      video.addEventListener(event, done, { once: true });
      video.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
    });
  try {
    signal.throwIfAborted();
    const loaded = wait('loadeddata');
    video.src = url;
    await loaded;
    const point = add(clip.sourceIn, multiply(subtract(at, clip.start), clip.rate));
    // Explicit seek also at the start: loadeddata can precede the drawable
    // compositor frame. This is a browser reference, not an exact PTS claim.
    const seconds = Math.max(0.001, point.value / point.timescale);
    if (seconds !== video.currentTime) {
      const sought = wait('seeked');
      video.currentTime = seconds;
      await sought;
    }
    signal.throwIfAborted();
    canvas.width = 320;
    canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth);
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
      mode: 'browser-reference',
      accuracy: 'browser-selected frame; no sample/frame accuracy claim',
      sequence: at,
      reason,
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
