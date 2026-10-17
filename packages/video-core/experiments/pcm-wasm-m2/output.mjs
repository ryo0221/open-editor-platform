/** Private actual AAC resource handoff; library last-alias close owns the backing. */
import { AudioSample, AudioSampleResource } from 'mediabunny';
export async function ownedHash(chunk, owner) {
  const release = owner.reserve(chunk.planes[0].byteLength + 32, 'hash-copy-and-digest');
  try {
    const data = chunk.planes[0].slice();
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data)), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
  } finally {
    release();
  }
}
export async function addOwnedAudio(audio, chunk, owner, observe) {
  let release, sample;
  let resolveDrain;
  const drain = new Promise((resolve) => {
    resolveDrain = resolve;
  });
  let handed = false;
  try {
    release = owner.reserve(chunk.planes[0].byteLength, 'export-backing');
    const pcm = chunk.planes[0].slice();
    const first = chunk.first;
    await observe(pcm, await ownedHash(chunk, owner));
    let resourceClosed = false;
    class Resource extends AudioSampleResource {
      getFormat() {
        return 'f32';
      }
      getSampleRate() {
        return 48000;
      }
      getNumberOfFrames() {
        return pcm.length;
      }
      getNumberOfChannels() {
        return 1;
      }
      getTimestamp() {
        return first / 48000;
      }
      getDataPlane(index) {
        if (index !== 0 || resourceClosed) throw Error('M2 AAC resource plane');
        return new Uint8Array(pcm.buffer);
      }
      close() {
        if (resourceClosed) throw Error('Duplicate M2 AAC resource close');
        resourceClosed = true;
        release();
        resolveDrain();
      }
    }
    sample = new AudioSample(new Resource());
    handed = true;
    // Keep the real add and caller close together, never an aborted wait's finally.
    try {
      await audio.add(sample);
    } finally {
      sample.close();
    }
    await drain;
  } finally {
    chunk.release();
    if (!handed) release?.();
    else await drain; // Library clone closure is the proof even on failed add.
  }
}
