import { add, compare, visualOpacityV3 } from '@editor-platform/video-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
import { readFixedFontAsset, assertFixedText } from './fixed-font';
/** Fixed font bytes and notice come from the same retained originals as media. */
export async function prepareTitleFramesV3(content, originals, output, signal) {
  const clips = content.sequence.clips.filter((c) => c.kind === 'title' || c.kind === 'caption');
  const sources = new Set(clips.map((c) => c.sourceId)),
    fonts = new Map(),
    byHash = new Map();
  const pixels = output.width * output.height;
  const budget = decodedFrameRealm.session({ pixels: pixels * 32, bytes: pixels * 32 * 4 });
  const frames = new Set();
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const release of frames) release();
    for (const font of fonts.values()) globalThis.document.fonts.delete(font.face);
    fonts.clear();
    byHash.clear();
    budget.close();
  };
  try {
    for (const sourceId of sources) {
      signal.throwIfAborted();
      const source = content.sources.find((s) => s.id === sourceId);
      const original = originals.find((o) => o.sourceId === sourceId);
      if (!source || source.kind !== 'font' || !original || original.plan.profile !== 'font-v3')
        throw Error('Title font unavailable');
      const cached = byHash.get(source.asset.sha256);
      if (cached) {
        if (cached.weight !== source.weight) throw Error('Font identity/weight mismatch');
        fonts.set(sourceId, cached);
        continue;
      }
      if (original.bytes.size > 18 * 1024 * 1024 || original.bytes.size !== source.asset.byteLength)
        throw Error('Title font original byte budget');
      const bytes = new Uint8Array(await original.bytes.arrayBuffer());
      if (
        bytes.length !== source.asset.byteLength ||
        bytesToHex(sha256(bytes)) !== source.asset.sha256
      )
        throw Error('Title font original mismatch');
      const decoded = await readFixedFontAsset(bytes, original.plan, signal);
      const family = 'EPVideo-' + source.asset.sha256;
      const face = new globalThis.FontFace(family, decoded.font, {
        weight: source.weight === 'bold' ? '700' : '400',
      });
      await face.load();
      signal.throwIfAborted();
      globalThis.document.fonts.add(face);
      const retained = { face, family, manifest: decoded.manifest, weight: source.weight };
      fonts.set(sourceId, retained);
      byHash.set(source.asset.sha256, retained);
    }
    for (const clip of clips) assertFixedText(clip.text, fonts.get(clip.sourceId).manifest);
    return {
      framesAt(at, caller, active) {
        if (closed || frames.size) throw Error('Title frame owner busy or closed');
        const rows = [];
        try {
          signal.throwIfAborted();
          caller.throwIfAborted();
          for (const clip of clips.filter(
            (c) =>
              content.sequence.tracks.find((t) => t.id === c.trackId).enabled &&
              (active
                ? active.has(c.id)
                : compare(at, c.start) >= 0 && compare(at, add(c.start, c.duration)) < 0),
          )) {
            const reservation = budget.reserve({ pixels, bytes: pixels * 4 });
            let canvas;
            const release = () => {
              if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
              }
              reservation.release();
              frames.delete(release);
            };
            frames.add(release);
            canvas = new globalThis.OffscreenCanvas(output.width, output.height);
            const ctx = canvas.getContext('2d'),
              font = fonts.get(clip.sourceId),
              style = clip.style;
            const size = style.size * output.height,
              x = style.x * output.width,
              y = style.y * output.height,
              width = style.width * output.width,
              height = style.height * output.height;
            ctx.font = `${font.weight === 'bold' ? 700 : 400} ${size}px "${font.family}"`;
            ctx.fillStyle = style.color;
            ctx.textAlign = style.align;
            ctx.textBaseline = 'alphabetic';
            const anchor =
              x + (style.align === 'center' ? width / 2 : style.align === 'right' ? width : 0);
            for (const [index, line] of clip.text.split('\n').entries()) {
              const metric = ctx.measureText(line),
                baseline = y + size + index * size * 1.2;
              if (
                metric.width > width ||
                anchor - metric.actualBoundingBoxLeft < x ||
                anchor + metric.actualBoundingBoxRight > x + width ||
                baseline - metric.actualBoundingBoxAscent < y ||
                baseline + metric.actualBoundingBoxDescent > y + height
              )
                throw Error('Title text exceeds declared box');
              ctx.fillText(line, anchor, baseline);
            }
            rows.push({
              frame: canvas,
              clipId: clip.id,
              sourceId: clip.sourceId,
              rotation: 0,
              visualOpacity: visualOpacityV3(clip, at),
              release,
            });
          }
          return rows;
        } catch (error) {
          for (const release of [...frames]) release();
          throw error;
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
