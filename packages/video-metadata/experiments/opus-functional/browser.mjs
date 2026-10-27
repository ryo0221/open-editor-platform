/* global window */
import {
  Output,
  WebMOutputFormat,
  BufferTarget,
  AudioSampleSource,
  VideoSampleSource,
  AudioSample,
  VideoSample,
  Input,
  BufferSource,
  WEBM,
  AudioSampleSink,
} from 'mediabunny';
import { signal } from './signal.mjs';
window.runFixture = async (n, origin, av = false, sampleRate = 48000, resample48 = false) => {
  const target = new BufferTarget(),
    output = new Output({ format: new WebMOutputFormat(), target });
  const packets = [];
  const audio = new AudioSampleSource({
    codec: 'opus',
    ...(resample48 && sampleRate !== 48000 ? { transform: { sampleRate: 48000 } } : {}),
    bitrate: 128000,
    onEncodedPacket: (p) => packets.push({ timestamp: p.timestamp, duration: p.duration }),
  });
  output.addAudioTrack(audio);
  const video = av ? new VideoSampleSource({ codec: 'vp8', bitrate: 250000 }) : null;
  if (video) output.addVideoTrack(video);
  await output.start();
  const block = new AudioSample({
    data: signal(n, sampleRate),
    format: 'f32',
    numberOfChannels: 2,
    sampleRate,
    timestamp: origin,
  });
  try {
    await audio.add(block);
  } finally {
    block.close();
  }
  if (video)
    for (let i = 0; i < 25; i++) {
      const planes = new Uint8Array((128 * 72 * 3) / 2);
      planes.fill([0, 12, 24].includes(i) ? 220 : 32, 0, 128 * 72);
      planes.fill(128, 128 * 72);
      const frame = new VideoSample(planes, {
        format: 'I420',
        codedWidth: 128,
        codedHeight: 72,
        timestamp: origin + i * 0.04,
        duration: 0.04,
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
      });
      try {
        await video.add(frame);
      } finally {
        frame.close();
      }
    }
  audio.close();
  video?.close();
  await output.finalize();
  const bytes = new Uint8Array(target.buffer),
    input = new Input({ formats: [WEBM], source: new BufferSource(bytes) });
  const track = await input.getPrimaryAudioTrack(),
    sink = new AudioSampleSink(track),
    decoded = [],
    frames = [];
  try {
    for await (const sample of sink.samples()) {
      const pcm = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
      sample.copyTo(pcm, { planeIndex: 0, format: 'f32' });
      decoded.push(...pcm);
      frames.push({
        timestamp: sample.timestamp,
        frames: sample.numberOfFrames,
        rate: sample.sampleRate,
        channels: sample.numberOfChannels,
      });
      sample.close();
    }
  } finally {
    input.dispose();
  }
  return { bytes: Array.from(bytes), decoded, frames, packets };
};
