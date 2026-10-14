import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  checkExportAbort,
  exportAssetLimits,
  type ExportAsset,
} from '@editor-platform/export-core';
import { inspectOfficeImage } from './image';

// Trusted fixed program; no image bytes become source, command arguments, paths or URLs.
// Native codecs can terminate on malformed input. A worker thread cannot contain that crash.
const decoderProgram = `
const { createCanvas, loadImage } = require(process.argv[1]);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  try {
    const image = await loadImage(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify({ width:image.width, height:image.height }) + '\\n');
    if (process.argv[2] === 'png') {
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      process.stdout.write(await canvas.encode('png'));
    }
  } catch { process.exitCode = 1; }
});`;

async function decode(asset: ExportAsset, png: boolean, signal?: AbortSignal) {
  checkExportAbort(signal);
  const entry = createRequire(import.meta.url).resolve('@napi-rs/canvas');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', decoderProgram, entry, png ? 'png' : 'check'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      signal,
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });
    const output: Buffer[] = [];
    let length = 0;
    child.on('error', reject);
    child.stdin.on('error', () => {
      /* Rejection is reported by the child exit/error event. */
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > exportAssetLimits.bytesPerImage + 256) {
        child.kill('SIGKILL');
        reject(Error('Converted image exceeds 16 MiB'));
      } else output.push(chunk);
    });
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(output))
        : reject(Error('Image decoder rejected the input or exceeded its time limit')),
    );
    child.stdin.end(asset.bytes);
  });
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
