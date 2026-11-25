import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export type MediaDestination = { artifactId: string } & (
  | { generation: string; revision: number }
  | { versionId: string }
);
export interface SharedMediaPin {
  sourceArtifactId: string;
  sourceVersionId: string;
  assetId: string;
  sha256: string;
  byteLength: number;
}
/** Implement in the trusted Host. Viewer is taken from the authenticated request. */
export interface SharedMediaAccess<Viewer> {
  canReadDestination(viewer: Viewer, destination: MediaDestination): Promise<boolean>;
  /** Resolve an asset of this particular confirmed revision or saved version. */
  pin(destination: MediaDestination, assetId: string): Promise<SharedMediaPin | undefined>;
  canReadSource(viewer: Viewer, pin: SharedMediaPin): Promise<boolean>;
  /** Check the exact version, recipient, expiry and permitted use at the time of the call. */
  canUseRelease(
    viewer: Viewer,
    destination: MediaDestination,
    pin: SharedMediaPin,
  ): Promise<boolean>;
  openOriginal(pin: SharedMediaPin): Promise<Blob | undefined>;
}

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
const unavailable = () => new Response(null, { status: 404, headers: privateHeaders });

function byteRange(value: string | null, size: number) {
  if (value === null) return { start: 0, end: size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !size) return;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size } : undefined;
  if (first >= size || (match[2] && last < first)) return;
  return { start: first, end: match[2] && last < size - 1 ? last + 1 : size };
}

function samePin(a: SharedMediaPin | undefined, b: SharedMediaPin) {
  return (
    a?.assetId === b.assetId &&
    a.sourceArtifactId === b.sourceArtifactId &&
    a.sourceVersionId === b.sourceVersionId &&
    a.sha256 === b.sha256 &&
    a.byteLength === b.byteLength
  );
}

/** No URL or caller-supplied hash can authorize reading a binary original. */
export function createSharedMediaReader<Viewer>(host: SharedMediaAccess<Viewer>) {
  // A Blob is immutable. Cache only its digest; never cache access decisions or signed URLs.
  const digests = new WeakMap<Blob, string>();
  return async (
    request: Request,
    viewer: Viewer,
    destination: MediaDestination,
    assetId: string,
  ) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, {
        status: 405,
        headers: { ...privateHeaders, Allow: 'GET, HEAD' },
      });
    async function currentPin() {
      request.signal.throwIfAborted();
      if (!(await host.canReadDestination(viewer, destination))) return;
      const pin = await host.pin(destination, assetId);
      if (
        !pin ||
        !Number.isSafeInteger(pin.byteLength) ||
        pin.byteLength < 0 ||
        !pin.sourceArtifactId ||
        !pin.sourceVersionId ||
        !pin.assetId ||
        !/^[0-9a-f]{64}$/.test(pin.sha256)
      )
        return;
      if (
        (await host.canReadSource(viewer, pin)) ||
        (await host.canUseRelease(viewer, destination, pin))
      )
        return pin;
    }
    const binding = await currentPin();
    if (!binding) return unavailable();
    const pin = { ...binding };
    const blob = await host.openOriginal(pin);
    if (!blob || blob.size !== pin.byteLength) return unavailable();
    if (!digests.has(blob)) {
      const hash = sha256.create();
      for (let start = 0; start < blob.size; start += 1024 * 1024) {
        request.signal.throwIfAborted();
        hash.update(new Uint8Array(await blob.slice(start, start + 1024 * 1024).arrayBuffer()));
      }
      digests.set(blob, bytesToHex(hash.digest()));
    }
    if (digests.get(blob) !== pin.sha256 || !samePin(await currentPin(), pin)) return unavailable();
    const requested = request.headers.get('Range');
    const range = byteRange(requested, blob.size);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: {
          ...privateHeaders,
          'Content-Range': 'bytes */' + blob.size,
        },
      });
    let offset = range.start;
    const body =
      request.method === 'HEAD'
        ? null
        : new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                if (offset === range.end) return controller.close();
                const end = Math.min(offset + 256 * 1024, range.end);
                const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
                if (!samePin(await currentPin(), pin)) throw new Error('Media access ended');
                offset = end;
                controller.enqueue(bytes);
              },
            },
            { highWaterMark: 0 },
          );
    return new Response(body, {
      status: requested === null ? 200 : 206,
      headers: {
        ...privateHeaders,
        'Content-Type':
          /^(?:video\/(?:mp4|webm)|audio\/(?:wav|mpeg|mp4|ogg)|image\/(?:png|jpeg|webp))$/.test(
            blob.type,
          )
            ? blob.type
            : 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(range.end - range.start),
        ...(requested === null
          ? {}
          : { 'Content-Range': `bytes ${range.start}-${range.end - 1}/${blob.size}` }),
      },
    });
  };
}
