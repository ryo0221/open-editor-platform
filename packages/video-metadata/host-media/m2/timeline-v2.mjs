/** Private render-job settings; no new native schema fields or persistence semantics. */
import { assertVideoContentV2, compare, multiply, time } from '@editor-platform/video-core';
import { ceilTime } from '../../../video-core/experiments/pcm-renderer/render.ts';
import { outputSpanV1 } from '../file-source/timing-v1';
import { createMixedPcmV2 } from './mixed-pcm-v2.mjs';
import { createVisualV2 } from './visual-v2.mjs';
export function timelinePlanV2(snapshot) {
  assertVideoContentV2(snapshot.native.content);
  const content = globalThis.structuredClone(snapshot.native.content),
    output = globalThis.structuredClone(snapshot.output);
  if (
    !output ||
    Object.keys(output).sort().join() !== 'background,height,width' ||
    !(
      (output.width === 1080 && output.height === 1920) ||
      (output.width === 1920 && output.height === 1080)
    ) ||
    !/^#[0-9a-f]{6}$/i.test(output.background)
  )
    throw Error('Explicit v2 SDR1080 canvas required');
  const duration = content.sequence.duration,
    count = outputSpanV1(duration, 48000).end;
  if (count < 4800 || count > 48000 * 90 || compare(content.sequence.frameRate, time(25)) !== 0)
    throw Error('V2 output duration/frame profile');
  const files = new Map();
  for (const original of snapshot.originals) {
    const source = content.sources.find((s) => s.id === original.sourceId);
    if (
      !source ||
      (files.has(source.asset.sha256) && files.get(source.asset.sha256) !== original.bytes)
    )
      throw Error('V2 render originals');
    files.set(source.asset.sha256, original.bytes);
  }
  return {
    content,
    output,
    duration,
    count,
    files,
    frames: ceilTime(multiply(duration, time(25))),
  };
}
export const timelineVideoV2 = (plan, signal) => createVisualV2(plan.content, plan.files, signal);
export async function timelinePcmV2(plan, signal) {
  const owner = await createMixedPcmV2(plan.content, plan.files, signal);
  return {
    ...owner,
    async render(first, end, caller) {
      return { ...(await owner.render(first, end, caller)), end };
    },
  };
}
/** Shared still/continuous/export geometry: preserve full oriented display rectangle. */
export function drawContainedV2(canvas, row, output, preview = false) {
  const scale = preview ? 0.25 : 1;
  canvas.width = output.width * scale;
  canvas.height = output.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = output.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!row) return null;
  if (![0, 90].includes(row.rotation)) throw Error('V2 orientation profile');
  const rawWidth = row.frame.displayWidth,
    rawHeight = row.frame.displayHeight,
    width = row.rotation === 90 ? rawHeight : rawWidth,
    height = row.rotation === 90 ? rawWidth : rawHeight,
    fit = Math.min(canvas.width / width, canvas.height / height),
    x = (canvas.width - width * fit) / 2,
    y = (canvas.height - height * fit) / 2;
  ctx.save();
  try {
    ctx.translate(x, y);
    if (row.rotation === 90) {
      ctx.translate(width * fit, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(row.frame, 0, 0, rawWidth * fit, rawHeight * fit);
  } finally {
    ctx.restore();
  }
  return { x, y, width: width * fit, height: height * fit, rotation: row.rotation };
}
