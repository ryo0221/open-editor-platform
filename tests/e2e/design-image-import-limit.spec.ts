import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createArtifact } from '@editor-platform/artifact-core';
import { createDesign, type DesignContent } from '@editor-platform/design/model';
import { test, expect, nativeArtifact, save } from './fixtures';

const imageImportLimits = { bytes: 64 * 1024 * 1024 }; // packages/canvas-ui/src/export.ts

// #22: page art and reference images of tens of MiB import into a design.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
/** A valid PNG of about `mib` MiB (stored without compression so the size is predictable). */
function png(mib: number) {
  const side = Math.ceil(Math.sqrt((mib * 1024 * 1024) / 4));
  const head = Buffer.alloc(13);
  head.writeUInt32BE(side, 0);
  head.writeUInt32BE(side, 4);
  head.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(side * (side * 4 + 1));
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  for (let y = 0; y < side; y++) raw[y * (side * 4 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a 40 MiB image imports into a design; an image over the limit is refused with the limit named', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'art.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(createArtifact('design', 'Page art', createDesign()))),
  });
  await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue('Page art');
  const art = png(40);
  expect(art.length).toBeGreaterThan(40 * 1024 * 1024);
  expect(art.length).toBeLessThanOrEqual(imageImportLimits.bytes);
  await page
    .getByLabel('Insert image file', { exact: true })
    .setInputFiles({ name: 'page-art.png', mimeType: 'image/png', buffer: art });
  await expect
    .poll(
      async () =>
        ((await nativeArtifact(page)).draft.content as DesignContent).elements.filter(
          (e) => e.type === 'image',
        ).length,
      { timeout: 60_000 },
    )
    .toBe(1);
  const image = ((await nativeArtifact(page)).draft.content as DesignContent).elements.find(
    (e) => e.type === 'image',
  )!;
  expect((image as { src: string }).src.length).toBeGreaterThan((art.length * 4) / 3);
  // The design with the image saves as a version (the Playground keeps designs up to its large-file limit)
  await save(page, 1);
  // Over 50 MB Playwright takes a file path, not a buffer
  const tooBig = info.outputPath('too-big.png');
  writeFileSync(
    tooBig,
    Buffer.concat([art, Buffer.alloc(imageImportLimits.bytes - art.length + 1)]),
  );
  await page.getByLabel('Insert image file', { exact: true }).setInputFiles(tooBig);
  await expect(page.getByText(/Image exceeds 64 MiB \(this one is 64\.0 MiB\)/)).toBeVisible();
});
