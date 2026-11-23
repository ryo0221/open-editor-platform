import { downloadBlob, drawExportSvg, type PdfExportLifecycle } from '@editor-platform/canvas-ui';
import {
  browserVideoEncoding,
  encodeMp4,
  VideoExportError,
} from '@editor-platform/character/video';
import { slideExportRenderer } from './export-drawing';
import { slideMp4Frame, slideMp4Limits, type SlideMp4Plan } from './export-playback';
import type { SlideContent } from './model';

export async function exportSlideMp4(
  deck: SlideContent,
  plan: SlideMp4Plan,
  comment: string | undefined,
  { signal, progress, beforeDownload }: PdfExportLifecycle,
) {
  const { width, height, frames } = plan;
  const { fps, bytes } = slideMp4Limits;
  const canvas = document.createElement('canvas');
  const renderer = slideExportRenderer(deck);
  const images = new Set<string>();
  let lastHold: SlideMp4Plan['segments'][number] | undefined;
  let lastSvg: string | undefined;
  const encoding = browserVideoEncoding();
  if (!encoding || typeof VideoFrame === 'undefined')
    throw Error('この環境では H.264 を符号化できません。');
  try {
    const blob = await encodeMp4(
      {
        width,
        height,
        fps: { numerator: fps, denominator: 1 },
        ticks: Array.from({ length: frames }, (_, index) => index),
        comment,
      },
      {
        begin() {
          canvas.width = width;
          canvas.height = height;
        },
        async frame(index, timestamp, duration) {
          const { segment } = slideMp4Frame(plan, index);
          if (segment !== lastHold) {
            lastHold = segment.kind === 'hold' ? segment : undefined;
            const svg = renderer.video(plan, index);
            if (svg !== lastSvg) {
              await drawExportSvg(svg, canvas, images);
              lastSvg = svg;
            }
          }
          signal?.throwIfAborted();
          return new VideoFrame(canvas, { timestamp, duration, alpha: 'discard' });
        },
        end() {
          canvas.width = canvas.height = 0;
        },
      },
      encoding,
      progress,
      signal,
      bytes,
    );
    if (blob.size > bytes) throw Error('MP4 のファイルサイズが 1 GiB を超えています。');
    signal?.throwIfAborted();
    beforeDownload?.();
    downloadBlob('slide-deck.mp4', blob);
  } catch (error) {
    if (error instanceof VideoExportError && error.code === 'video-encoder-unsupported')
      throw Error(`この環境では ${width}×${height}、${fps} fps の H.264 を符号化できません。`);
    throw error;
  }
}
