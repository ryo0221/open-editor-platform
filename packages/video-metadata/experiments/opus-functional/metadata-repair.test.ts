import { Buffer } from 'node:buffer';
import { expect, it } from 'vitest';
import { encode, elements, integer } from './ebml-rewrite.mjs';
import { discardNanoseconds, discardSamples } from './discard-timing.mjs';
import { repairMetadata } from './metadata-repair.mjs';
import { presentationTail } from './presentation-tail.mjs';
function fixture() {
  const header = Buffer.alloc(19);
  header.write('OpusHead');
  header[8] = 1;
  header[9] = 2;
  header.writeUInt16LE(312, 10);
  header.writeUInt32LE(48000, 12);
  return encode([
    {
      id: 0x18538067,
      data: encode([
        { id: 0x1549a966, data: encode([{ id: 0x2ad7b1, data: integer(1000000n) }]) },
        {
          id: 0x1654ae6b,
          data: encode([
            {
              id: 0xae,
              data: encode([
                { id: 0xd7, data: integer(1n) },
                { id: 0x86, data: Buffer.from('A_OPUS') },
                { id: 0x63a2, data: header },
                { id: 0x56bb, data: integer(6500000n) },
              ]),
            },
          ]),
        },
        {
          id: 0x1f43b675,
          data: encode([
            { id: 0xe7, data: integer(0n) },
            { id: 0xa3, data: Buffer.from([129, 0, 0, 128, 252, 1, 2]) },
            { id: 0xa3, data: Buffer.from([129, 0, 20, 128, 252, 3, 4]) },
          ]),
        },
      ]),
    },
  ]);
}
it('rewrites metadata without changing encoded payload or block timestamps', () => {
  const input = fixture(),
    before = Buffer.from(input),
    fixed = repairMetadata(input, 960);
  expect(input).toEqual(before);
  expect(fixed.decodedFrames).toBe(1608);
  expect(fixed.discardFrames).toBe(648);
  const segment = elements(fixed.bytes)[0],
    children = elements(segment.data);
  const track = elements(elements(children.find((e) => e.id === 0x1654ae6b)!.data)[0].data);
  expect(track.find((e) => e.id === 0x56aa)!.data).toEqual(integer(6500000n));
  expect(track.find((e) => e.id === 0x56bb)!.data).toEqual(integer(80000000n));
  const cluster = elements(children.find((e) => e.id === 0x1f43b675)!.data),
    group = elements(cluster.at(-1)!.data);
  expect(group.find((e) => e.id === 0xa1)!.data).toEqual(Buffer.from([129, 0, 20, 0, 252, 3, 4]));
  expect(group.find((e) => e.id === 0x75a2)!.data).toEqual(integer(13500000n, true));
});
it.each([
  [961, 13479167n],
  [977, 13145833n],
])('serializes approved nearest ns for %s samples', (n, ns) => {
  const fixed = repairMetadata(fixture(), Number(n));
  const children = elements(elements(fixed.bytes)[0].data);
  const group = elements(elements(children.find((e) => e.id === 0x1f43b675)!.data).at(-1)!.data);
  expect(group.find((e) => e.id === 0x75a2)!.data).toEqual(integer(BigInt(ns), true));
  expect(discardSamples(BigInt(ns))).toBe(1608 - Number(n));
});
it('round trips every supported whole-sample discard within half a nanosecond', () => {
  for (let frames = 0n; frames < 960n; frames++) {
    const ns = discardNanoseconds(frames);
    const error = ns * 48000n - frames * 1000000000n;
    expect(error >= -24000n && error <= 24000n).toBe(true);
    expect(discardSamples(ns)).toBe(Number(frames));
    if (frames % 3n === 0n) expect(ns).toBe((frames * 1000000000n) / 48000n);
  }
  expect(() => discardSamples(13479166n)).toThrow('Noncanonical');
  expect(() => discardSamples(-1n)).toThrow();
  expect(() => discardSamples(20000000n)).toThrow();
});
it('refuses insufficient encoder coverage instead of fabricating samples', () => {
  expect(() => repairMetadata(fixture(), 2000)).toThrow('coverage deficit');
});
it('rejects truncated/oversized EBML and invalid integer input', () => {
  expect(() => repairMetadata(fixture().subarray(0, -1), 960)).toThrow();
  expect(() => elements(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow();
  expect(() => elements(Buffer.from([0]))).toThrow();
  expect(() => integer(-1n)).toThrow();
});
it('applies only declared container tail to verified raw decoder coverage', () => {
  const pcm = Float32Array.from({ length: 3216 }, (_, i) => i);
  const actual = presentationTail(pcm, { decodedFrames: 1608, discardFrames: 648 });
  expect(actual).toEqual(pcm.subarray(0, 1920));
  expect(pcm.length).toBe(3216);
  expect(presentationTail(pcm, { decodedFrames: 1608, discardFrames: 0 })).toEqual(pcm);
});
it.each([
  { decodedFrames: 1607, discardFrames: 648 },
  { decodedFrames: 1608, discardFrames: -1 },
  { decodedFrames: 1608, discardFrames: 960 },
  { decodedFrames: 1608, discardFrames: 0.5 },
])('rejects malformed coverage or discard %j', (timing) => {
  expect(() => presentationTail(new Float32Array(3216), timing)).toThrow();
});
