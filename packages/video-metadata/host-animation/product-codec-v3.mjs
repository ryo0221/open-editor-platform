/** Same bounded AVC/AAC backend and native Animation renderer for still/play/export. */
import { animationSceneSvg2 } from '@editor-platform/animation-player/v2';
import { prepareTitleFramesV3 } from '../host-visual/title-frames.mjs';
import { createImageFramesV3 } from '../host-visual/image-frames.mjs';
import {
  visualOpacityV3,
  evaluateVisualV3,
  add,
  subtract,
  multiply,
} from '@editor-platform/video-core';
import { createProductCodec } from '../host-media/m2/product-codec-v2.mjs';
import { playTimeline } from '../host-media/m2/playback-v2.mjs';
import {
  timelinePlanV2,
  timelinePcmV2,
  timelineVideoV2,
  drawLayerContainedV2,
} from '../host-media/m2/timeline-v2.mjs';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
import { abortable } from '../host-media/native-video.mjs';
import { mediaProjectionV3, validateHostV3 } from './host-v3';
import { prepareAnimationTimelineV3 } from './timeline-v3';
function plan(snapshot) {
  if (!validateHostV3(snapshot.native.content)) throw Error('Video Animation Host profile');
  const content = globalThis.structuredClone(snapshot.native.content);
  const media = timelinePlanV2({
    ...snapshot,
    originals: snapshot.originals.filter((o) =>
      content.sources.some((s) => s.id === o.sourceId && !('kind' in s)),
    ),
    native: { ...snapshot.native, content: mediaProjectionV3(content) },
  });
  return {
    ...media,
    imageContent: content,
    imageOriginals: snapshot.originals,
    animation: prepareAnimationTimelineV3(content),
    visualClips: new Map(
      content.sequence.clips.filter((c) => c.kind !== 'audio').map((c) => [c.id, c]),
    ),
    animationSources: content.sequence.clips
      .filter((c) => c.kind === 'animation')
      .map((c) => c.embed.source),
  };
}
async function video(plan, caller) {
  const selectRequests = (at) => {
    const { active } = evaluateVisualV3(plan.imageContent, at);
    return plan.imageContent.sequence.clips
      .filter((c) => c.kind === 'video' && active.has(c.id))
      .map((clip) => {
        const source = plan.imageContent.sources.find((s) => s.id === clip.sourceId);
        const stream = source.streams.find((s) => s.id === clip.streamId);
        const sourceTime = add(clip.sourceIn, multiply(subtract(at, clip.start), clip.rate));
        return {
          clipId: clip.id,
          sourceId: source.id,
          streamId: stream.id,
          asset: source.asset,
          sourceTime,
          rawTime: subtract(sourceTime, stream.presentationOrigin),
        };
      });
  };
  const media = await timelineVideoV2(plan, caller, selectRequests);
  let titles;
  try {
    titles = await prepareTitleFramesV3(
      plan.imageContent,
      plan.imageOriginals,
      plan.output,
      caller,
    );
  } catch (error) {
    await media.dispose();
    throw error;
  }
  const imageOwners = plan.imageContent.sequence.clips
    .filter((c) => c.kind === 'image')
    .map((clip) =>
      createImageFramesV3(
        { ...plan.imageContent, sequence: { ...plan.imageContent.sequence, clips: [clip] } },
        plan.imageOriginals,
        caller,
      ),
    );
  const pixels = plan.output.width * plan.output.height;
  // Existing realm admission bounds all simultaneous layers; no expanded realm.
  const budget = decodedFrameRealm.session({ pixels: pixels * 2 * 32, bytes: pixels * 8 * 32 });
  const stop = new globalThis.AbortController();
  let closed = false,
    pending,
    outstanding,
    closing;
  async function animationFrame(sample, signal) {
    const reservation = budget.reserve({ pixels: pixels * 2, bytes: pixels * 8 });
    let url, image;
    const release = () => {
      if (image) image.src = '';
      if (url) globalThis.URL.revokeObjectURL(url);
      reservation.release();
    };
    try {
      const parsed = new globalThis.DOMParser().parseFromString(
        animationSceneSvg2(sample.scene),
        'image/svg+xml',
      );
      const root = parsed.documentElement;
      if (root.localName !== 'svg' || parsed.querySelector('parsererror'))
        throw Error('Native Animation SVG');
      root.setAttribute('width', String(plan.output.width));
      root.setAttribute('height', String(plan.output.height));
      root.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      url = globalThis.URL.createObjectURL(
        new globalThis.Blob([new globalThis.XMLSerializer().serializeToString(root)], {
          type: 'image/svg+xml',
        }),
      );
      image = new globalThis.Image();
      image.src = url;
      await abortable(image.decode(), signal);
      signal.throwIfAborted();
      return {
        frame: image,
        rotation: 0,
        sourceId: sample.source.artifactId,
        clipId: sample.clipId,
        pts: sample.scene.tick,
        scale: 240000,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  return {
    async frameAt(at, call) {
      if (closed || pending || outstanding) throw Error('Visual frame owner busy or closed');
      const signal = globalThis.AbortSignal.any([caller, call, stop.signal]);
      const job = (async () => {
        const rows = [];
        try {
          signal.throwIfAborted();
          const evaluated = evaluateVisualV3(plan.imageContent, at);
          media.releaseInactive(at);
          for (const images of imageOwners) images.releaseInactive(at, evaluated.active);
          for (const images of imageOwners) {
            const image = await images.frameAt(at, signal, evaluated.active);
            if (image) rows.push(image);
          }
          rows.push(...(await media.framesAt(at, signal)));
          for (const sample of plan.animation.sample(at, evaluated.active))
            rows.push(await animationFrame(sample, signal));
          signal.throwIfAborted();
          rows.push(...titles.framesAt(at, signal, evaluated.active));
          const order = new Map(
            plan.imageContent.sequence.tracks.map((track, index) => [track.id, index]),
          );
          rows.sort(
            (a, b) =>
              order.get(plan.visualClips.get(a.clipId).trackId) -
              order.get(plan.visualClips.get(b.clipId).trackId),
          );
          const layers = rows.map((row) => ({
            ...row,
            visualOpacity: visualOpacityV3(plan.visualClips.get(row.clipId), at, true),
          }));
          for (const { edge, progress } of evaluated.edges) {
            const left = layers.find((r) => r.clipId === edge.leftClipId);
            const right = layers.find((r) => r.clipId === edge.rightClipId);
            if (!left || !right) throw Error('Dissolve frame unavailable');
            const reservation = budget.reserve({ pixels, bytes: pixels * 4 });
            let canvas;
            const release = () => {
              if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
              }
              reservation.release();
            };
            try {
              canvas = new globalThis.OffscreenCanvas(plan.output.width, plan.output.height);
              const ctx = canvas.getContext('2d');
              if (!ctx) throw Error('Dissolve canvas unavailable');
              // Linear premultiplied blend, then one source-over layer. Ordinary
              // source-over of two weighted rows would attenuate the left twice.
              ctx.globalCompositeOperation = 'lighter';
              ctx.globalAlpha = (1 - progress) * left.visualOpacity;
              drawLayerContainedV2(ctx, left, canvas.width, canvas.height);
              ctx.globalAlpha = progress * right.visualOpacity;
              drawLayerContainedV2(ctx, right, canvas.width, canvas.height);
              const mixed = {
                frame: canvas,
                rotation: 0,
                clipId: left.clipId,
                visualOpacity: 1,
                release,
              };
              rows.push(mixed);
              const index = Math.min(layers.indexOf(left), layers.indexOf(right));
              layers.splice(Math.max(layers.indexOf(left), layers.indexOf(right)), 1);
              layers.splice(index, 1, mixed);
            } catch (error) {
              release();
              throw error;
            }
          }
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            for (const row of rows) row.release();
            outstanding = undefined;
          };
          outstanding = release;
          return { layers, release };
        } catch (error) {
          for (const row of rows) row.release();
          throw error;
        }
      })();
      pending = job;
      try {
        return await job;
      } finally {
        pending = undefined;
      }
    },
    dispose() {
      return (closing ??= (async () => {
        closed = true;
        stop.abort();
        await pending?.catch(() => {});
        outstanding?.();
        const settled = await Promise.allSettled([
          media.dispose(),
          titles.dispose(),
          ...imageOwners.map((owner) => owner.dispose()),
        ]);
        budget.close();
        const failures = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
        if (failures.length) throw new AggregateError(failures, 'Visual cleanup failed');
      })());
    },
  };
}
function draw(canvas, row, output, preview) {
  const scale = preview ? 0.25 : 1;
  canvas.width = output.width * scale;
  canvas.height = output.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = output.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const geometry = [];
  for (const layer of row?.layers ?? []) {
    ctx.save();
    try {
      ctx.globalAlpha = layer.visualOpacity;
      geometry.push(drawLayerContainedV2(ctx, layer, canvas.width, canvas.height));
    } finally {
      ctx.restore();
    }
  }
  return geometry;
}
const ports = { plan, pcm: timelinePcmV2, video, draw };
export const productCodecV3 = createProductCodec({
  ...ports,
  play: (snapshot, at, canvas, caller, report) =>
    playTimeline(snapshot, at, canvas, caller, report, ports),
});
