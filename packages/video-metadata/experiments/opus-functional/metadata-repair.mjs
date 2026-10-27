/** Finite candidate: metadata-preserving linear remux of the fixed VP8/Opus fixtures. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { parse } from './metadata.mjs';
import { discardNanoseconds } from './discard-timing.mjs';
import { elements, encode, integer } from './ebml-rewrite.mjs';
export function repairMetadata(bytes, sourceFrames48k) {
  assert(Number.isSafeInteger(sourceFrames48k) && sourceFrames48k > 0, 'Source frame count');
  const before = parse(bytes),
    audio = before.tracks.filter((t) => t.codec === 'A_OPUS');
  assert.equal(audio.length, 1, 'One Opus track');
  assert.equal(audio[0].opus.channels, 2, 'Stereo fixture');
  assert.equal(before.timestampScaleNs, 1000000n, 'Fixed fixture scale');
  const blocks = before.blocks.filter((b) => b.track === audio[0].number);
  assert(
    blocks.length &&
      blocks.every((b) => b.kind === 'SimpleBlock' && b.toc === 252 && b.discardPadding === null),
    'Fixed 20ms single-frame Opus packets only',
  );
  const preSkip = audio[0].opus.preSkip,
    decoded = BigInt(blocks.length) * 960n - preSkip;
  const discard = decoded - BigInt(sourceFrames48k);
  assert(discard >= 0n, 'Encoder coverage deficit; cannot repair with padding');
  assert(discard < 960n, 'Invalid end discard');
  assert.equal((preSkip * 1000000000n) % 48000n, 0n, 'Fractional CodecDelay not adopted');
  const top = elements(Buffer.from(bytes)),
    segments = top.filter((e) => e.id === 0x18538067);
  assert.equal(segments.length, 1);
  const segment = segments[0];
  // Offset-bearing indices cannot survive rewriting. This candidate supports linear decode only.
  const children = elements(segment.data).filter((e) => ![0x114d9b74, 0x1c53bb6b].includes(e.id));
  const trackEntry = children.find((e) => e.id === 0x1654ae6b),
    tracks = elements(trackEntry.data);
  for (const t of tracks)
    if (t.id === 0xae) {
      let fields = elements(t.data);
      if (fields.find((e) => e.id === 0x86)?.data.toString() !== 'A_OPUS') continue;
      fields = fields.filter((e) => ![0x56aa, 0x56bb].includes(e.id));
      fields.push(
        { id: 0x56aa, data: integer((preSkip * 1000000000n) / 48000n) },
        { id: 0x56bb, data: integer(80000000n) },
      );
      t.data = encode(fields);
    }
  trackEntry.data = encode(tracks);
  const clusters = children
    .filter((e) => e.id === 0x1f43b675)
    .map((e) => ({ e, fields: elements(e.data) }));
  const audioBlocks = [];
  for (const c of clusters)
    for (const e of c.fields)
      if (e.id === 0xa3) {
        assert(e.data.length >= 5 && e.data[0] & 128, 'Single-byte track only');
        assert.equal(e.data[3] & 6, 0, 'No lacing');
        if (BigInt(e.data[0] & 127) === audio[0].number) audioBlocks.push(e);
      }
  assert.equal(audioBlocks.length, blocks.length);
  if (discard) {
    const last = audioBlocks.at(-1),
      block = Buffer.from(last.data);
    block[3] &= ~128;
    last.id = 0xa0;
    last.data = encode([
      { id: 0xa1, data: block },
      { id: 0x75a2, data: integer(discardNanoseconds(discard), true) },
    ]);
  }
  for (const c of clusters) c.e.data = encode(c.fields);
  segment.data = encode(children);
  const output = encode(top),
    after = parse(output);
  assert.deepEqual(
    after.blocks.map((b) => b.payloadSha256),
    before.blocks.map((b) => b.payloadSha256),
    'Encoded payload changed',
  );
  assert.deepEqual(
    after.blocks.map((b) => b.rawNs),
    before.blocks.map((b) => b.rawNs),
    'Block timestamp changed',
  );
  return { bytes: output, decodedFrames: Number(decoded), discardFrames: Number(discard) };
}
