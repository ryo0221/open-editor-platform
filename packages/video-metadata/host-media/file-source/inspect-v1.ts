/** Metadata-only file admission before any demuxer; no whole original buffer. */
import { metadataBlob } from '../indexed-media/metadata';
import { checkIndexV1 } from './index-admission-v1.mjs';
import { mp4ProbeV1 } from './probe-v1';
export async function inspectOriginalV1(original: Blob, signal: AbortSignal) {
  if (original.size < 1 || original.size > 256 * 1024 * 1024) throw Error('v1 original quota');
  const metadata = await metadataBlob(original, signal);
  await checkIndexV1(original, metadata, signal);
  const plan = await mp4ProbeV1.inspect(metadata, signal);
  return { metadata, plan };
}
