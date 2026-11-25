import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createSharedMediaReader,
  type MediaDestination,
  type SharedMediaAccess,
} from '@editor-platform/collaboration-adapters/shared-media';
import { createReferenceServer } from './server';

function media() {
  // PCM WAV containing one second of silence, including its actual container header.
  const audio = Buffer.alloc(44 + 48000 * 2);
  audio.write('RIFF');
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(48000, 24);
  audio.writeUInt32LE(96000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  const pin = {
    assetId: 'audio',
    sourceArtifactId: 'recording',
    sourceVersionId: 'v1',
    byteLength: audio.length,
    sha256: createHash('sha256').update(audio).digest('hex'),
  };
  const readers = new Set(['A', 'B']);
  let activeReceipt = true;
  const access: SharedMediaAccess<string> = {
    canReadDestination: async (viewer, d) =>
      readers.has(viewer) && ['team', 'other'].includes(d.artifactId),
    pin: async (d, id) =>
      id === 'audio' &&
      ('versionId' in d ? d.versionId === 'saved-3' : d.generation === 'g1' && d.revision === 3)
        ? pin
        : undefined,
    canReadSource: async (viewer) => viewer === 'A',
    canUseRelease: async (viewer, d, p) =>
      activeReceipt && viewer === 'B' && d.artifactId === 'team' && p.sourceVersionId === 'v1',
    openOriginal: async () => new Blob([audio]),
  };
  return {
    access,
    readers,
    audio,
    pin,
    expire: () => {
      activeReceipt = false;
    },
  };
}

it('serves pinned native bytes to current readers at the live and saved version and checks the release on every range request', async () => {
  const { access, readers, audio, expire } = media();
  const server = createReferenceServer({
    media: {
      access,
      authenticate: async (req) => {
        return { 'Bearer writer-token': 'A', 'Bearer recipient-token': 'B' }[
          req.headers.authorization ?? ''
        ];
      },
    },
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const path =
    'http://127.0.0.1:' +
    (server.address() as AddressInfo).port +
    '/collaboration-api/editor/media?';
  const get = (token: string, snapshot: string, dest = 'team') =>
    fetch(path + 'artifactId=' + dest + '&assetId=audio&' + snapshot, {
      headers: { Authorization: 'Bearer ' + token, Range: 'bytes=4-11' },
    });
  try {
    for (const snapshot of ['generation=g1&revision=3', 'versionId=saved-3']) {
      for (const token of ['writer-token', 'recipient-token']) {
        const response = await get(token, snapshot);
        expect(response.status).toBe(206);
        expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(response.headers.get('Content-Range')).toBe('bytes 4-11/' + audio.length);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(audio.subarray(4, 12));
      }
    }
    expect((await get('A', 'versionId=saved-3')).status).toBe(404);
    expect((await get('recipient-token', 'versionId=saved-3', 'other')).status).toBe(404);
    expect((await get('recipient-token', 'generation=g1&revision=4')).status).toBe(404);
    expire();
    expect((await get('recipient-token', 'versionId=saved-3')).status).toBe(404);
    readers.delete('A');
    expect((await get('writer-token', 'generation=g1&revision=3')).status).toBe(404);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  }
});

it('withholds corrupt originals and stops an open response after access is lost', async () => {
  const { access, audio, readers, pin } = media();
  const destination: MediaDestination = { artifactId: 'team', versionId: 'saved-3' };
  const request = new Request('http://localhost/media');
  const bad = createSharedMediaReader({
    ...access,
    openOriginal: async () => new Blob([new Uint8Array(audio.length)]),
  });
  expect((await bad(request, 'A', destination, 'audio')).status).toBe(404);
  const large = new Blob([audio, audio, audio, audio]);
  const data = new Uint8Array(await large.arrayBuffer());
  const resolve = createSharedMediaReader({
    ...access,
    openOriginal: async () => large,
    pin: async () => ({
      ...pin,
      sha256: createHash('sha256').update(data).digest('hex'),
      byteLength: large.size,
    }),
  });
  const reader = (await resolve(request, 'A', destination, 'audio')).body!.getReader();
  expect((await reader.read()).value?.length).toBe(256 * 1024);
  readers.delete('A');
  await expect(reader.read()).rejects.toThrow('Media access ended');
});
