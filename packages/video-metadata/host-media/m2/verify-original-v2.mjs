/** Private original-owning multi-source PCM adapter. JS resampler; no scheduling/sink ownership. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { contentHash } from '@editor-platform/artifact-core';
import { time } from '@editor-platform/video-core';
import { prepareAudioImportV2 } from './audio-import-v2';
import { inspectAudioOriginalV2 } from './audio-profile-v2';
import { inspectOriginalV1 } from '../file-source/inspect-v1';
import { prepareImportSetV1 } from '../file-source/import-v1';
const need = (ok, msg) => {
  if (!ok) throw Error(msg);
};
const empty = (schema) => ({
  schema,
  sources: [],
  sequence: {
    id: 'probe-sequence',
    duration: time(0),
    frameRate: time(25),
    tracks: [
      { id: 'visual', kind: 'visual', enabled: true, locked: false },
      { id: 'audio', kind: 'audio', enabled: true, locked: false },
    ],
    clips: [],
  },
});
export async function verifyOriginal(source, bytes, signal) {
  need(
    bytes instanceof globalThis.Blob &&
      bytes.size === source.asset.byteLength &&
      bytes.size <= 256 * 1024 * 1024,
    'V2 original identity/size',
  );
  const digest = sha256.create();
  try {
    for (let at = 0; at < bytes.size; at += 65536) {
      signal.throwIfAborted();
      digest.update(new Uint8Array(await bytes.slice(at, at + 65536).arrayBuffer()));
    }
    signal.throwIfAborted();
    need(bytesToHex(digest.digest()) === source.asset.sha256, 'V2 original SHA');
  } finally {
    digest.destroy();
  }
  const av = source.streams.some((s) => s.kind === 'video');
  const { plan } = await (av ? inspectOriginalV1 : inspectAudioOriginalV2)(bytes, signal);
  const expected = av
    ? prepareImportSetV1(empty('video-core-prototype-v1'), plan, source.asset, 'probe-source')
        .sources[0]
    : prepareAudioImportV2(
        empty('video-core-prototype-v2'),
        plan,
        source.asset,
        'probe-source',
        time(0),
      ).sources[0];
  expected.id = source.id;
  need(
    (await contentHash(expected)) === (await contentHash(source)),
    'V2 original interpretation mismatch',
  );
  return av ? 'iphone-sdr-v1' : 'aac-mono-v2';
}
