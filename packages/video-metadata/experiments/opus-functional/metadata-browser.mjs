/* global window */
import { Input, BufferSource, WEBM, AudioSampleSink } from 'mediabunny';
import { presentationTail } from './presentation-tail.mjs';
window.decodeMetadataFixture = async (bytes, timing) => {
  const input = new Input({ formats: [WEBM], source: new BufferSource(new Uint8Array(bytes)) });
  const pcm = [],
    frames = [];
  try {
    const sink = new AudioSampleSink(await input.getPrimaryAudioTrack());
    for await (const sample of sink.samples()) {
      try {
        if (
          sample.sampleRate !== 48000 ||
          sample.numberOfChannels !== 2 ||
          pcm.length + sample.numberOfFrames * 2 > 200000
        )
          throw Error('Finite decoder profile/budget');
        const chunk = new Float32Array(sample.numberOfFrames * 2);
        sample.copyTo(chunk, { planeIndex: 0, format: 'f32' });
        pcm.push(...chunk);
        frames.push({ timestamp: sample.timestamp, frames: sample.numberOfFrames });
      } finally {
        sample.close();
      }
    }
  } finally {
    input.dispose();
  }
  return {
    rawFrames: pcm.length / 2,
    frames,
    pcm: Array.from(presentationTail(Float32Array.from(pcm), timing)),
  };
};
