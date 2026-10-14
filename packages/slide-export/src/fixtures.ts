import { createDeck, type SlideObject } from '@editor-platform/slide/model';
import type { ExportFontProfile } from '@editor-platform/export-core';
import type { SlidePptxOptions } from './types';
import { zlibSync } from 'fflate';

/** Synthetic manifest only for contract tests; product glyph claims require actual font hashes. */
export const contractFont: ExportFontProfile = {
  id: 'contract',
  family: 'Noto Sans CJK JP',
  version: 'test-only',
  license: 'OFL-1.1',
  verified: true,
  faces: [
    { weight: 'regular', sha256: 'a'.repeat(64) },
    { weight: 'bold', sha256: 'b'.repeat(64) },
  ],
  glyphRanges: [[0, 0x10ffff]],
};
export const contractOptions: SlidePptxOptions = {
  pageIds: 'all',
  includeHiddenSlides: false,
  includeNotes: false,
  fontProfileId: 'contract',
  fallback: 'reject',
};
export function contractDeck(objects?: SlideObject[]) {
  const deck = createDeck();
  deck.slides[0].id = 'page-1';
  deck.slides[0].objects = objects ?? [
    {
      id: 'text-1',
      type: 'text',
      text: '日本語 ABC 123\n次の段落',
      fill: '#253044',
      bounds: { x: 40, y: 50, width: 500, height: 140 },
      typography: { fontFamily: contractFont.family, fontSize: 24, padding: 8 },
      runs: [{ text: '日本語', style: { bold: true } }, { text: ' ABC 123\n次の段落' }],
    },
  ];
  return deck;
}
export function contractPng(width = 1, height = 1) {
  const chunk = (name: string, data: Uint8Array) => {
    const bytes = new Uint8Array(data.length + 12),
      view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(name), 4);
    bytes.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  };
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const pixels = new Uint8Array((width * 4 + 1) * height).fill(255);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(pixels)),
    chunk('IEND', new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return { bytes, mime: 'image/png' as const, width, height };
}
