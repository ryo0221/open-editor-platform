import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createSharedMediaReader,
  type MediaDestination,
  type SharedMediaAccess,
} from '@editor-platform/collaboration-adapters/shared-media';

export interface ReferenceMediaHost {
  authenticate(request: IncomingMessage): Promise<string | undefined>;
  access: SharedMediaAccess<string>;
}

/** Binary reads have a separate Host authenticator. Demo actor letters are never media grants. */
export function mediaRoute(host?: ReferenceMediaHost) {
  const read = host && createSharedMediaReader(host.access);
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const viewer = await host?.authenticate(request);
    const params = url.searchParams;
    const artifactId = params.get('artifactId'),
      assetId = params.get('assetId');
    const versionId = params.get('versionId'),
      generation = params.get('generation'),
      revision = params.get('revision');
    const destination: MediaDestination | undefined = !artifactId
      ? undefined
      : versionId && generation === null && revision === null
        ? { artifactId, versionId }
        : versionId === null &&
            generation &&
            revision &&
            /^(0|[1-9]\d*)$/.test(revision) &&
            Number.isSafeInteger(Number(revision))
          ? { artifactId, generation, revision: Number(revision) }
          : undefined;
    response.setHeader('Cache-Control', 'private, no-store');
    if (!viewer || !read || !destination || !assetId) {
      response.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    const req = new Request(url, {
      method: request.method,
      signal: controller.signal,
      headers: request.headers.range ? { Range: request.headers.range } : {},
    });
    const result = await read(req, viewer, destination, assetId);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (!result.body) return void response.end();
    try {
      await pipeline(Readable.from(result.body as unknown as AsyncIterable<Uint8Array>), response, {
        signal: controller.signal,
      });
    } catch {
      response.destroy();
    }
  };
}
