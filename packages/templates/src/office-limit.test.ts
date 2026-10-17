import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { it, expect } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { prepareSlideImport } from '@editor-platform/slide-import';
import { prepareDocumentImport } from '@editor-platform/document-import';
import { sourceKey, materializeOfficeImport } from '@editor-platform/office-import-core';
import { decodeNodeOfficeImage } from '@editor-platform/office-adapters/node';
import { saveAsTemplate, templateLimits, type NativeContent } from './index';

// Valid deterministic PNG noise: ~6 MiB compressed image bytes, >8 MiB data URI.
// It is within Office's 16 MiB / 32 MP picture limits, but exceeds template reuse.
function largePng() {
  const width = 2048,
    height = 1024,
    pixels = Buffer.alloc((width * 3 + 1) * height);
  let seed = 412;
  for (let row = 0; row < height; row++)
    for (let x = 1; x <= width * 3; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[row * (width * 3 + 1) + x] = seed & 255;
    }
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    crcTable[i] = c;
  }
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    let crc = 0xffffffff;
    for (const b of body) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255];
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const domain of ['slide', 'document'] as const)
  it(`T05 ${domain}: a real in-budget Office picture is rejected by the smaller fixed-template limit`, async () => {
    const image = largePng();
    expect(image.length).toBeLessThan(16 * 1024 * 1024);
    expect(image.toString('base64').length).toBeGreaterThan(templateLimits.assetCharacters);
    const file = domain === 'slide' ? 'external.pptx' : 'document/external.docx';
    const parts = unzipSync(new Uint8Array(await readFile(`tests/fixtures/office/import/${file}`)));
    const pictures = Object.keys(parts).filter((name) => /\/media\/.*\.png$/.test(name));
    expect(pictures.length).toBeGreaterThan(0);
    for (const name of pictures) parts[name] = image;
    const bytes = zipSync(parts),
      options = {
        unsupported: 'review-conversions' as const,
        fontProfileId: 'noto-cjk-jp-2.004' as const,
      },
      adapters = { version: 'office-image-validator-1', decodeImage: decodeNodeOfficeImage };
    const first =
      domain === 'slide'
        ? await prepareSlideImport(
            { bytes, format: 'pptx' },
            { ...options, pages: 'all', notes: 'exclude', includeHidden: false },
            'large-slide',
            adapters,
          )
        : await prepareDocumentImport(
            { bytes, format: 'docx' },
            options,
            'large-document',
            adapters,
          );
    const blocked = first.report.diagnostics.filter((d) => d.disposition === 'blocked');
    const plan =
      domain === 'slide' && blocked.length
        ? await prepareSlideImport(
            { bytes, format: 'pptx' },
            {
              ...options,
              pages: 'all',
              notes: 'exclude',
              includeHidden: false,
              exclude: blocked.map((d) => sourceKey(d.address)),
            },
            'large-slide',
            adapters,
          )
        : first;
    const artifact = materializeOfficeImport<NativeContent>(plan, {
      planHash: plan.report.planHash,
      acceptedDiagnosticIds: plan.report.diagnostics
        .filter((d) => d.requiresConsent)
        .map((d) => d.id),
    });
    await expect(
      saveAsTemplate({
        domain,
        content: artifact.draft.content,
        kind: 'whole',
        name: 'large',
        purpose: 'large',
        category: 'test',
        slots: [],
      }),
    ).rejects.toMatchObject({ code: 'template-limit' });
  }, 30000);
