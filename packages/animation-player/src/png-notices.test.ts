import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { expect, it } from 'vitest';
import { animationPngNotices } from './png-notices';
it('embeds UTF-8 notices in a CRC-valid iTXt chunk without changing existing PNG chunks', async () => {
  const original = readFileSync('tests/fixtures/office/images/quadrants.png'),
    metadata = JSON.stringify({
      attribution: '画像の作者',
      license: 'Retained license 日本語',
      sourceHash: 'source',
    });
  const result = Buffer.from(
    await (await animationPngNotices(new Blob([original]), metadata)).arrayBuffer(),
  );
  let offset = 8,
    textStart = -1,
    textLength = 0;
  while (offset < result.length) {
    const length = result.readUInt32BE(offset),
      type = result.toString('ascii', offset + 4, offset + 8);
    expect(result.readUInt32BE(offset + 8 + length)).toBe(
      crc32(result.subarray(offset + 4, offset + 8 + length)),
    );
    if (type === 'iTXt') {
      textStart = offset;
      textLength = length + 12;
      expect(result.toString('utf8', offset + 8, offset + 8 + length)).toBe(
        'Animation provenance\0\0\0\0\0' + metadata,
      );
    }
    offset += length + 12;
  }
  expect(textStart).toBeGreaterThan(8);
  expect(
    Buffer.concat([result.subarray(0, textStart), result.subarray(textStart + textLength)]),
  ).toEqual(original);
});
it('refuses truncated or non-PNG raster output', async () => {
  await expect(animationPngNotices(new Blob(['not png']), '{}')).rejects.toThrow('PNG');
  await expect(
    animationPngNotices(
      new Blob([readFileSync('tests/fixtures/office/images/quadrants.png').subarray(0, 25)]),
      '{}',
    ),
  ).rejects.toThrow('PNG');
});
