import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  checkExportAbort,
  exportAssetLimits,
  type ExportAsset,
} from '@editor-platform/export-core';
import { inspectOfficeImage } from './image';
import { runOfficeImageDecoder } from './node-decoder';
export { OfficeImageDecodeError } from './node-decoder';
export type { OfficeImageDecodeDiagnostics, OfficeImageDecodeFailure } from './node-decoder';

// Trusted fixed program; no image bytes become source, command arguments, paths or URLs.
// Native codecs can terminate on malformed input. A worker thread cannot contain that crash.
const decoderProgram = `
const { createCanvas, loadImage } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  let image;
  try {
    image = await loadImage(Buffer.concat(chunks));
  } catch { process.exitCode = 65; return; }
  process.stdout.write(JSON.stringify({ width:image.width, height:image.height }) + '\\n');
  if (process.argv[2] === 'png') {
    try {
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      process.stdout.write(await canvas.encode('png'));
    } catch { process.exitCode = 66; }
  }
});`;

async function decode(asset: ExportAsset, png: boolean, signal?: AbortSignal) {
  checkExportAbort(signal);
  const entry = createRequire(import.meta.url).resolve('@napi-rs/canvas');
  let bytes: Buffer;
  try {
    bytes = await runOfficeImageDecoder({
      start: () =>
        spawn(process.execPath, ['-e', decoderProgram, entry, png ? 'png' : 'check'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      bytes: asset.bytes,
      input: {
        sha256: createHash('sha256').update(asset.bytes).digest('hex'),
        bytes: asset.bytes.length,
        mime: asset.mime,
        width: asset.width,
        height: asset.height,
      },
      operation: png ? 'png' : 'check',
      signal,
      timeoutMs: 10_000,
      outputLimit: exportAssetLimits.bytesPerImage + 256,
    });
  } catch (error) {
    checkExportAbort(signal);
    throw error;
  }
  checkExportAbort(signal);
  const end = bytes.indexOf(10);
  if (end < 0 || end > 255) throw Error('Image decoder returned invalid dimensions');
  const dimensions: { width: number; height: number } = JSON.parse(
    bytes.subarray(0, end).toString('utf8'),
  );
  if (dimensions.width !== asset.width || dimensions.height !== asset.height)
    throw Error('Image dimensions changed while decoding');
  return bytes.subarray(end + 1);
}

/** No file/network resolution: the trusted Host supplies authorized binary bytes. */
export async function decodeNodeOfficeImage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExportAsset> {
  const asset = inspectOfficeImage(bytes);
  await decode(asset, false, signal);
  return asset;
}
export async function nodeOfficeImagePng(
  asset: ExportAsset,
  signal?: AbortSignal,
): Promise<ExportAsset> {
  const owned = inspectOfficeImage(asset.bytes);
  return inspectOfficeImage(new Uint8Array(await decode(owned, true, signal)));
}
