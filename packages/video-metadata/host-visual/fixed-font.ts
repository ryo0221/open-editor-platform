/** Existing fixed Office fonts retained byte-for-byte as one original asset. */
import { zipSync, unzipSync } from 'fflate';
import {
  hashExportBytes,
  missingFontGlyphs,
  type ExportFontProfile,
} from '@editor-platform/export-core';
export type FixedFontWeight = 'regular' | 'bold';
export const VIDEO_FONT_PROFILE = 'noto-cjk-jp-2.004' as const;
const pins = {
  manifest: '8470b7aaa2f9d45395796e69442b0f3bd5779a218308e06a2c34981f7837e43d',
  notice: '849f4ea9c214fa4ac3593b770c699f387534b11ce671264c1b10d85bdcb5997b',
  regular: '828bf816295d2f293f5f25f09777b3be53ff981df1ec1d7a57cc66f12b50ab55',
  bold: '137ca65a894da3c1854f406151c15046c1ecc48435451c6566d3e7fa3504ca8b',
};
const sizes = { regular: 16467712, bold: 17032596, manifest: 81840, notice: 14712 };
export interface FontInterpretationV3 {
  format: 'video-font-interpretation-v3';
  profile: 'font-v3';
  fontProfile: typeof VIDEO_FONT_PROFILE;
  weight: FixedFontWeight;
}
export function assertFontInterpretationV3(value: unknown): asserts value is FontInterpretationV3 {
  const p = value as FontInterpretationV3;
  if (
    !p ||
    Object.keys(p).sort().join() !== 'fontProfile,format,profile,weight' ||
    p.format !== 'video-font-interpretation-v3' ||
    p.profile !== 'font-v3' ||
    p.fontProfile !== VIDEO_FONT_PROFILE ||
    !['regular', 'bold'].includes(p.weight)
  )
    throw Error('Unsupported fixed Video font');
}
function pack(files: Record<string, Uint8Array>) {
  // Internal original asset, not another portable profile. Store entries avoid a
  // decompression multiplier and preserve exact font/manifest/notice bytes.
  return zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) });
}
async function verifyFiles(
  files: Record<string, Uint8Array>,
  weight: FixedFontWeight,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (Object.keys(files).sort().join() !== 'COPYRIGHT.txt,font.otf,manifest.json')
    throw Error('Fixed font asset entries');
  for (const [file, pin, size] of [
    ['font.otf', pins[weight], sizes[weight]],
    ['manifest.json', pins.manifest, sizes.manifest],
    ['COPYRIGHT.txt', pins.notice, sizes.notice],
  ] as const) {
    if (files[file].length !== size || (await hashExportBytes(files[file])) !== pin)
      throw Error(`Fixed font bytes/notice mismatch: ${file}`);
    signal.throwIfAborted();
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(files['manifest.json']),
  ) as ExportFontProfile;
}
export async function readFixedFontAsset(
  bytes: Uint8Array,
  plan: FontInterpretationV3,
  signal: AbortSignal,
) {
  assertFontInterpretationV3(plan);
  signal.throwIfAborted();
  if (bytes.length > 18 * 1024 * 1024) throw Error('Fixed font asset byte budget');
  const files = unzipSync(bytes, {
    filter(entry) {
      const limit =
        entry.name === 'font.otf'
          ? sizes[plan.weight]
          : entry.name === 'manifest.json'
            ? sizes.manifest
            : entry.name === 'COPYRIGHT.txt'
              ? sizes.notice
              : 0;
      if (!limit || entry.originalSize !== limit || entry.compression !== 0)
        throw Error('Fixed font asset entry budget/format');
      return true;
    },
  });
  const manifest = await verifyFiles(files, plan.weight, signal);
  const canonical = pack({
    'font.otf': files['font.otf'],
    'manifest.json': files['manifest.json'],
    'COPYRIGHT.txt': files['COPYRIGHT.txt'],
  });
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i]))
    throw Error('Noncanonical fixed font asset');
  return { manifest, font: files['font.otf'], notice: files['COPYRIGHT.txt'] };
}
export async function loadFixedFontAsset(
  manifestUrl: string,
  weight: FixedFontWeight,
  signal: AbortSignal,
) {
  if (!['regular', 'bold'].includes(weight)) throw Error('Unsupported font weight');
  const files: Record<string, Uint8Array> = {};
  for (const [entry, file, limit] of [
    ['manifest.json', 'manifest.json', sizes.manifest],
    ['COPYRIGHT.txt', 'COPYRIGHT.txt', sizes.notice],
    [
      'font.otf',
      weight === 'regular' ? 'NotoSansCJKjp-Regular.otf' : 'NotoSansCJKjp-Bold.otf',
      sizes[weight],
    ],
  ] as const) {
    const response = await fetch(new URL(file, manifestUrl), { signal, credentials: 'omit' });
    if (!response.ok || !response.body) throw Error(`Fixed font file unavailable: ${file}`);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > limit) throw Error('Fixed font download byte budget');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    files[entry] = bytes;
  }
  await verifyFiles(files, weight, signal);
  const bytes = pack({
    'font.otf': files['font.otf'],
    'manifest.json': files['manifest.json'],
    'COPYRIGHT.txt': files['COPYRIGHT.txt'],
  });
  const plan: FontInterpretationV3 = {
    format: 'video-font-interpretation-v3',
    profile: 'font-v3',
    fontProfile: VIDEO_FONT_PROFILE,
    weight,
  };
  return { bytes, plan };
}
export function assertFixedText(text: string, manifest: ExportFontProfile) {
  if (
    !text ||
    text.length > 4096 ||
    Array.from(text).some((c) => {
      const n = c.codePointAt(0)!;
      return (n < 32 && n !== 10) || n === 127;
    })
  )
    throw Error('Unsupported title/caption text');
  const missing = missingFontGlyphs(text, manifest);
  if (missing.length)
    throw Error(
      'Fixed font missing glyph: ' +
        missing
          .slice(0, 8)
          .map((n) => 'U+' + n.toString(16).toUpperCase())
          .join(', '),
    );
}
