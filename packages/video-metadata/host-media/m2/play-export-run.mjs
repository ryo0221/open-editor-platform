import { time, videoCommandV2 } from '@editor-platform/video-core';
import { contentHash } from '@editor-platform/artifact-core';
import { inspectMediaOriginalV2, prepareAvImportV2 } from './media-profile-v2';
import { prepareAudioImportV2 } from './audio-import-v2';
import { productCodecV2 } from './product-codec-v2.mjs';
import { scratchStatus } from '../indexed-media/scratch.mjs';
import { videoStatus } from '../indexed-media/video-window.mjs';
import { encodingState } from '../encoder-state.mjs';
const need = (ok, message) => {
  if (!ok) throw Error(message);
};
const hash = async (data) =>
  Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const drained = () => {
  need(scratchStatus().files === 0 && videoStatus().sessions === 0, 'Media owner leak');
  let live = false;
  try {
    encodingState();
    live = true;
  } catch {
    /* no encoder owner */
  }
  need(!live, 'Encoder owner leak');
  return { scratch: scratchStatus(), video: videoStatus(), encoder: false };
};
globalThis.runM2Delivery = async (hashes) => {
  const files = [...globalThis.document.querySelector('input').files],
    signal = new globalThis.AbortController().signal;
  let content = {
    schema: 'video-core-prototype-v2',
    sources: [],
    sequence: {
      id: 'seq',
      duration: time(0),
      frameRate: time(25),
      tracks: [
        { id: 'visual', kind: 'visual', enabled: true, locked: false },
        { id: 'audio', kind: 'audio', enabled: true, locked: false },
        { id: 'music', kind: 'audio', enabled: true, locked: false },
      ],
      clips: [],
    },
  };
  const originals = [];
  for (let i = 0; i < 3; i++) {
    const file = files[i];
    file.arrayBuffer = () => {
      throw Error('Whole original prohibited');
    };
    const { plan } = await inspectMediaOriginalV2(
        file,
        i < 2 ? 'av-sdr-v2' : 'aac-mono-v2',
        signal,
      ),
      id = ['one', 'two', 'bgm'][i],
      asset = { assetId: hashes[i], sha256: hashes[i], byteLength: file.size };
    if (i < 2) content = prepareAvImportV2(content, plan, asset, id);
    else {
      plan.streams[0].destination = 'music';
      content = prepareAudioImportV2(content, plan, asset, id, time(1, 1000));
    }
    originals.push({ sourceId: id, bytes: file, plan });
  }
  const edit = (e) => {
    content = videoCommandV2(e).apply(content);
  };
  edit({
    type: 'trim',
    clipId: 'bgm:1',
    start: time(1, 1000),
    end: time(1999, 1000),
    independent: true,
  });
  edit({ type: 'resize', duration: time(2) });
  for (const clip of content.sequence.clips.filter((c) => c.kind === 'audio')) {
    edit({ type: 'gain', clipId: clip.id, gain: clip.trackId === 'music' ? 0.2 : 0.25 });
    edit({ type: 'fade', clipId: clip.id, fadeIn: time(1, 10), fadeOut: time(1, 10) });
  }
  const snapshot = {
    native: { content, revision: { kind: 'local', sessionId: 'm2', sequence: 0 } },
    originals,
    hash: await contentHash(content),
    output: { width: 1080, height: 1920, background: '#102030' },
  };
  const canvas = globalThis.document.querySelector('canvas');
  const still = await productCodecV2.preview(snapshot, time(1), canvas, signal);
  const bytes = await productCodecV2.encode(snapshot, signal);
  await productCodecV2.verify(bytes, snapshot, signal);
  const encoded = productCodecV2.provenance(bytes),
    afterExport = drained();
  const contexts = [],
    scheduled = [];
  let observed = scheduled;
  const Native = globalThis.AudioContext;
  globalThis.AudioContext = class extends Native {
    constructor(...args) {
      super(...args);
      contexts.push(this);
    }
    createBufferSource() {
      const source = super.createBufferSource(),
        start = source.start;
      source.start = (...args) => {
        const samples = new Float32Array(source.buffer.getChannelData(0));
        observed.push({
          count: samples.length,
          rate: source.buffer.sampleRate,
          hash: hash(samples.buffer),
        });
        return start.apply(source, args);
      };
      return source;
    }
  };
  let playback, overflowPlay, overflowExport, cancelPlay, cancelExport;
  try {
    playback = await productCodecV2.play(snapshot, time(0), canvas, signal);
    for (const c of scheduled) c.hash = await c.hash;
    need(playback.state === 'ended', 'Playback not completed');
    need(playback.chunks.length === encoded.chunkEvidence.length, 'Chunk count mismatch');
    for (let i = 0; i < scheduled.length; i++) {
      need(
        scheduled[i].count === encoded.chunkEvidence[i].end - encoded.chunkEvidence[i].first,
        'Scheduled block size',
      );
      need(
        scheduled[i].hash === encoded.chunkEvidence[i].hash &&
          playback.chunks[i].hash === scheduled[i].hash,
        'Scheduled PCM differs from export',
      );
    }
    need(scheduled.length === 50, 'Missing real audio scheduling');
    drained();
    let loud = content;
    for (const c of loud.sequence.clips.filter((c) => c.kind === 'audio')) {
      loud = videoCommandV2({ type: 'gain', clipId: c.id, gain: 1 }).apply(loud);
      loud = videoCommandV2({
        type: 'fade',
        clipId: c.id,
        fadeIn: time(0),
        fadeOut: time(0),
      }).apply(loud);
    }
    const invalid = {
      ...snapshot,
      native: { ...snapshot.native, content: loud },
      hash: await contentHash(loud),
    };
    observed = [];
    try {
      await productCodecV2.play(invalid, time(0), canvas, signal);
    } catch (e) {
      overflowPlay = String(e);
    }
    need(
      overflowPlay?.includes('out of range') && observed.length === 0,
      'Invalid preview block scheduled',
    );
    drained();
    try {
      await productCodecV2.encode(invalid, signal);
    } catch (e) {
      overflowExport = String(e);
    }
    need(overflowExport?.includes('out of range'), 'Invalid export returned completed bytes');
    drained();
    const stop = new globalThis.AbortController();
    observed = [];
    try {
      await productCodecV2.play(snapshot, time(0), canvas, stop.signal, (r) => {
        if (r.chunks.length) stop.abort();
      });
    } catch (e) {
      cancelPlay = String(e);
    }
    need(cancelPlay && observed.length === 1, 'Playback cancellation');
    drained();
  } finally {
    globalThis.AudioContext = Native;
  }
  need(
    contexts.every((c) => c.state === 'closed'),
    'AudioContext leak',
  );
  const NativeEncoder = globalThis.VideoEncoder,
    exportStop = new globalThis.AbortController();
  let encodedFrames = 0;
  globalThis.VideoEncoder = class extends NativeEncoder {
    encode(...args) {
      super.encode(...args);
      encodedFrames++;
      exportStop.abort();
    }
  };
  try {
    await productCodecV2.encode(snapshot, exportStop.signal);
  } catch (e) {
    cancelExport = String(e);
  } finally {
    globalThis.VideoEncoder = NativeEncoder;
  }
  need(cancelExport && encodedFrames === 1, 'Export cancellation did not refuse completed sink');
  drained();
  const landscapeSnapshot = {
    ...snapshot,
    output: { width: 1920, height: 1080, background: '#102030' },
  };
  const landscapeBytes = await productCodecV2.encode(landscapeSnapshot, signal);
  await productCodecV2.verify(landscapeBytes, landscapeSnapshot, signal);
  const landscape = productCodecV2.provenance(landscapeBytes);
  need(
    JSON.stringify(landscape.chunkEvidence) === JSON.stringify(encoded.chunkEvidence),
    'Canvas choice changed audio',
  );
  for (const [name, data] of [
    ['m2.mp4', bytes],
    ['output-landscape.mp4', landscapeBytes],
  ]) {
    const a = globalThis.document.createElement('a');
    a.href = globalThis.URL.createObjectURL(data);
    a.download = name;
    a.click();
  }
  return {
    snapshot: { content, hash: snapshot.hash, output: snapshot.output },
    still,
    encoded,
    landscape,
    playback,
    scheduled,
    contexts: contexts.map((c) => c.state),
    overflowPlay,
    overflowExport,
    cancelPlay,
    cancelExport,
    afterExport,
    after: drained(),
    size: bytes.size,
  };
};
