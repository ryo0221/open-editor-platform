import { time, subtract } from '@editor-platform/video-core';
import { inspectOriginalV1 } from './inspect-v1';
import { prepareImportSetV1 } from './import-v1';
import { audioMappingV1, outputSpanV1 } from './timing-v1';
import { createPcmFile } from '../indexed-media/pcm-file.mjs';
import { createVideoWindow } from '../indexed-media/video-window.mjs';
import { PcmRenderSession } from '../../../video-core/experiments/pcm-renderer/session.ts';
globalThis.runV1Reader = async () => {
  const original = globalThis.document.querySelector('#source').files[0],
    signal = new globalThis.AbortController().signal;
  original.arrayBuffer = () => {
    throw Error('Whole original buffer prohibited');
  };
  const { plan } = await inspectOriginalV1(original, signal);
  const native = prepareImportSetV1(
    {
      schema: 'video-core-prototype-v1',
      sources: [],
      sequence: {
        id: 'sequence',
        duration: time(0),
        frameRate: time(25),
        clips: [],
        tracks: [
          { id: 'visual', kind: 'visual', enabled: true, locked: false },
          { id: 'audio', kind: 'audio', enabled: true, locked: false },
        ],
      },
    },
    plan,
    {
      assetId: 'original',
      sha256: '69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4',
      byteLength: original.size,
    },
    'source',
  );
  const a = native.sources[0].streams.find((s) => s.kind === 'audio');
  const pcm = await createPcmFile(
    original,
    signal,
    {
      originalHash: native.sources[0].asset.sha256,
      streamId: a.id,
      decodePolicy: 'native-aac-continuous-v1',
    },
    'iphone-sdr-v1',
  );
  let video;
  const lease = pcm.acquire(),
    renderer = new PcmRenderSession(lease, 'edge-hold-v0');
  try {
    const b = audioMappingV1(native, 'source:' + a.id),
      end = outputSpanV1(native.sequence.duration, 48000).end;
    const tail = await renderer.render(
      b.mapping,
      end - 4096,
      end,
      48000,
      a.sampleRate,
      b.valid,
      1,
      signal,
    );
    video = await createVideoWindow(original, signal, 'iphone-sdr-v1');
    const frame = await video.frameAt(subtract(native.sequence.duration, time(1, 48000)), signal);
    try {
      const canvas = globalThis.document.querySelector('canvas');
      canvas.width = 270;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.translate(270, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame.frame, 0, 0, 480, 270);
      return {
        native,
        plan,
        pcm: pcm.evidence,
        valid: pcm.valid,
        outputEnd: end,
        tail: Array.from(tail.planes[0]),
        video: {
          ...video.evidence,
          pts: frame.pts,
          scale: video.clock.scale,
          rotation: video.rotation,
        },
        pixels: Array.from(ctx.getImageData(0, 0, 270, 480).data),
      };
    } finally {
      frame.release();
    }
  } finally {
    renderer.dispose();
    lease.release();
    await Promise.allSettled([pcm.dispose(), video?.dispose()]);
  }
};
