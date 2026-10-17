/** Explicit audio-only admission. Existing v1 still requires a video track. */
import { inspectMp4Tracks } from '../file-source/probe-v1';
import { metadataBlob } from '../indexed-media/metadata';
import { checkIndexV1 } from '../file-source/index-admission-v1.mjs';
import type { SelectedStreamV1 } from '../file-source/import-v1';
export interface AudioImportSetV2 {
  format: 'video-media-interpretation-v2';
  profile: 'aac-mono-v2';
  streams: Extract<SelectedStreamV1, { kind: 'audio' }>[];
}
export const mp4ProbeAudioV2 = {
  async inspect(metadata: Blob, signal: AbortSignal): Promise<AudioImportSetV2> {
    const parsed = await inspectMp4Tracks(metadata, signal, 'audio-only');
    const stream = parsed.streams[0];
    if (stream.kind !== 'audio' || ![44100, 48000].includes(stream.sampleRate))
      throw Error('AAC mono v2 rate profile');
    return { format: 'video-media-interpretation-v2', profile: 'aac-mono-v2', streams: [stream] };
  },
};
export async function inspectAudioOriginalV2(original: Blob, signal: AbortSignal) {
  if (original.size < 1 || original.size > 256 * 1024 * 1024) throw Error('v2 original quota');
  const metadata = await metadataBlob(original, signal);
  await checkIndexV1(original, metadata, signal);
  return { metadata, plan: await mp4ProbeAudioV2.inspect(metadata, signal) };
}
