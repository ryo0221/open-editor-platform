import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { blockyFigure } from '@editor-platform/character-core';
import { videoTimelineFixture } from '@editor-platform/collaboration-adapters';
import { createReferenceServer } from '../../../apps/collaboration-reference/src/server';

/** The browser test owns both accounts, the release recipient and the original bytes. */
export async function startFixture(encoded: Uint8Array) {
  const movie = new Uint8Array(encoded);
  const figure = blockyFigure();
  const video = videoTimelineFixture();
  video.sequence.id = 'field-film';
  video.sources[0].asset = {
    assetId: 'capture',
    byteLength: movie.byteLength,
    sha256: createHash('sha256').update(movie).digest('hex'),
  };
  const originals = new Map([
    [
      'host-video-film',
      {
        assetId: 'capture',
        blob: new Blob([movie], { type: 'video/webm' }),
        sha256: video.sources[0].asset.sha256,
      },
    ],
    [
      'host-character-figure',
      {
        assetId: 'mesh-body',
        blob: new Blob([new Uint8Array(figure.assets.get('mesh-body')!)]),
        sha256: figure.doc.assets[0].sha256.slice(7),
      },
    ],
  ]);
  const viewers = new Set(['author', 'recipient']);
  let releaseActive = true;
  const fromCookie = (value = '') => value.match(/(?:^|; )fixture=(author|recipient)(?:;|$)/)?.[1];
  const server = createReferenceServer({
    projects: {
      access: async (req, id) => {
        const viewer = fromCookie(req.headers.cookie);
        return viewer && viewers.has(viewer) && originals.has(id)
          ? { viewerId: viewer, generation: 'g1', writable: true }
          : undefined;
      },
      load: async (id) => ({ name: id, content: id === 'host-video-film' ? video : figure.doc }),
    },
    media: {
      authenticate: async (req) => fromCookie(req.headers.cookie),
      access: {
        canReadDestination: async (who, d) => viewers.has(who) && originals.has(d.artifactId),
        pin: async (d, assetId) => {
          const original = originals.get(d.artifactId);
          if (
            !original ||
            original.assetId !== assetId ||
            !('generation' in d) ||
            d.generation !== 'g1'
          )
            return;
          return {
            sourceArtifactId: d.artifactId,
            sourceVersionId: 'v1',
            assetId,
            sha256: original.sha256,
            byteLength: original.blob.size,
          };
        },
        canReadSource: async (who) => who === 'author',
        canUseRelease: async (who, d, pin) =>
          releaseActive &&
          who === 'recipient' &&
          pin.sourceArtifactId === d.artifactId &&
          pin.sourceVersionId === 'v1',
        openOriginal: async (pin) => originals.get(pin.sourceArtifactId)?.blob,
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
    setReleaseActive: (value: boolean) => {
      releaseActive = value;
    },
    revoke: (who: string) => viewers.delete(who),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
