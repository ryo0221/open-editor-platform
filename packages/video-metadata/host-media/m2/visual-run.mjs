import { time } from '@editor-platform/video-core';
import { createVisualV2 } from './visual-v2.mjs';
import { videoStatus } from '../indexed-media/video-window.mjs';
const need = (ok, text) => {
  if (!ok) throw Error(text);
};
globalThis.runVisualV2 = async (native) => {
  const files = [...globalThis.document.querySelector('input').files],
    map = new Map(native.sources.slice(0, 2).map((s, i) => [s.asset.sha256, files[i]])),
    signal = new globalThis.AbortController().signal;
  for (const f of files)
    f.arrayBuffer = () => {
      throw Error('Whole original read');
    };
  const owner = await createVisualV2(native, map, signal),
    pictures = [];
  try {
    for (const at of [
      time(0),
      time(49, 25),
      time(1999, 1000),
      time(2),
      time(2001, 1000),
      time(99, 25),
    ]) {
      const row = await owner.frameAt(at, signal);
      try {
        const portrait = row.rotation === 90,
          canvas = globalThis.document.createElement('canvas');
        canvas.width = portrait ? 270 : 480;
        canvas.height = portrait ? 480 : 270;
        globalThis.document.body.append(canvas);
        const ctx = canvas.getContext('2d');
        if (portrait) {
          ctx.translate(270, 0);
          ctx.rotate(Math.PI / 2);
        }
        ctx.drawImage(row.frame, 0, 0, 480, 270);
        pictures.push({
          at,
          sourceId: row.sourceId,
          sourceTime: row.sourceTime,
          rawTime: row.rawTime,
          pts: row.pts,
          scale: row.scale,
          rotation: row.rotation,
          width: canvas.width,
          height: canvas.height,
          pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
        });
      } finally {
        row.release();
      }
    }
    need(
      pictures.map((p) => p.sourceId).join() === 'one,one,one,two,two,two',
      'Wrong concatenated source',
    );
    need(
      pictures.map((p) => p.rotation).join() === '90,90,90,0,0,0',
      'Wrong per-source orientation',
    );
    const lease = await owner.frameAt(time(0), signal);
    let drained = false;
    const closing = owner.dispose().then(() => {
      drained = true;
    });
    await new Promise((r) => globalThis.setTimeout(r, 0));
    need(!drained, 'Disposed before outstanding frame release');
    lease.release();
    await closing;
  } finally {
    await owner.dispose();
  }
  need(videoStatus().sessions === 0, 'Reader leak');
  const gapNative = globalThis.structuredClone(native);
  gapNative.sequence.tracks.find((t) => t.kind === 'visual').enabled = false;
  const gap = await createVisualV2(gapNative, new Map(), signal);
  try {
    need((await gap.frameAt(time(1), signal)) === null, 'Disabled visual not empty');
  } finally {
    await gap.dispose();
  }
  const wrong = globalThis.structuredClone(native);
  wrong.sources[1].asset.sha256 = 'f'.repeat(64);
  const wrongMap = new Map(map);
  wrongMap.set('f'.repeat(64), files[1]);
  let failure;
  try {
    const invalid = await createVisualV2(wrong, wrongMap, signal);
    await invalid.dispose();
  } catch (e) {
    failure = String(e);
  }
  need(failure?.includes('original SHA'), 'Wrong second source accepted');
  need(videoStatus().sessions === 0, 'Partial reader leak');
  return {
    pictures,
    after: videoStatus(),
    leaseDrain: true,
    disabledGap: true,
    partialRefusal: failure,
  };
};
