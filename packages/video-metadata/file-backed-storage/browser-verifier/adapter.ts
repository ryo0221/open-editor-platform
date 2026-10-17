/** Private browser binding: shared schema/ZIP profile, injected streaming digest, no persistence. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import {
  CHUNK,
  MAX_ARCHIVE,
  createScanner,
  need,
  type DigestFactory,
  type Reader,
} from '../portable/io';
import {
  createProfileProject,
  v0Profile,
  type ArchiveContent,
  type ProjectProfile,
} from '../portable/project';
export interface ExpectedArchive {
  operationId: string;
  capture: SaveCapture;
  sha256: string;
  bytes: number;
}
export function blobReader(blob: Blob): Reader {
  need(
    Number.isSafeInteger(blob.size) && blob.size > 0 && BigInt(blob.size) <= MAX_ARCHIVE,
    'Blob budget',
  );
  return {
    size: BigInt(blob.size),
    async read(offset, length, signal) {
      signal.throwIfAborted();
      need(
        offset >= 0n &&
          Number.isSafeInteger(length) &&
          length >= 0 &&
          length <= CHUNK &&
          offset + BigInt(length) <= BigInt(blob.size),
        'Blob range',
      );
      const bytes = new Uint8Array(
        await blob.slice(Number(offset), Number(offset) + length).arrayBuffer(),
      );
      signal.throwIfAborted();
      need(bytes.length === length, 'Short blob');
      return bytes;
    },
  };
}
export function createBrowserVerifier(digest: DigestFactory) {
  return createProfileBrowserVerifier(digest, v0Profile);
}
export function createProfileBrowserVerifier<C extends ArchiveContent, P>(
  digest: DigestFactory,
  profile: ProjectProfile<C, P>,
) {
  const scan = createScanner(digest),
    { openProject } = createProfileProject(scan, profile);
  async function open(reader: Reader, signal: AbortSignal, expected?: ExpectedArchive) {
    const project = await openProject(reader, signal);
    const hash = await scan(reader, signal);
    if (expected)
      need(
        BigInt(expected.bytes) === reader.size &&
          expected.sha256 === hash.sha256 &&
          expected.operationId === project.operationId &&
          canonicalJson(expected.capture) === canonicalJson(project.capture),
        'Archive pin mismatch',
      );
    signal.throwIfAborted();
    return {
      project,
      receipt: {
        operationId: project.operationId,
        capture: structuredClone(project.capture),
        sha256: hash.sha256,
        bytes: reader.size.toString(),
      },
    };
  }
  return {
    open,
    /** Structurally compatible with private journal Verify; no journal mutation or false settlement. */
    async verify(
      reader: {
        size: number;
        read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
      },
      pin: ExpectedArchive,
      signal: AbortSignal,
    ) {
      try {
        need(
          Number.isSafeInteger(reader.size) &&
            reader.size > 0 &&
            BigInt(reader.size) <= MAX_ARCHIVE,
          'Reader budget',
        );
        await open(
          { size: BigInt(reader.size), read: (at, n, abort) => reader.read(Number(at), n, abort) },
          signal,
          pin,
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
