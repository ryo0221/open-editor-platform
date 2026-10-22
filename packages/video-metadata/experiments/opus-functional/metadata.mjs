import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function parse(bytes) {
  assert.ok(bytes.length <= 2 * 1024 * 1024);
  let visited = 0;
  function vint(at, id = false) {
    assert.ok(at < bytes.length && bytes[at] !== 0, 'Invalid vint');
    let width = 1,
      mask = 128;
    while (!(bytes[at] & mask)) {
      width++;
      mask >>= 1;
    }
    assert.ok(width <= (id ? 4 : 8) && at + width <= bytes.length);
    let value = BigInt(id ? bytes[at] : bytes[at] & (mask - 1));
    for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(bytes[at + i]);
    return { width, value, unknown: !id && value === (1n << BigInt(7 * width)) - 1n };
  }
  function children(start, end) {
    const entries = [];
    for (let at = start; at < end; ) {
      assert.ok(++visited <= 4096, 'Element budget');
      const id = vint(at, true),
        size = vint(at + id.width);
      const data = at + id.width + size.width;
      // The only unknown-size container admitted in these fixture files is Segment.
      assert.ok(!size.unknown || id.value === 0x18538067n, 'Unsupported unknown-size element');
      const stop = size.unknown ? end : data + Number(size.value);
      assert.ok(Number.isSafeInteger(stop) && stop <= end && stop >= data);
      entries.push({ id: Number(id.value), at, data, stop });
      at = stop;
    }
    return entries;
  }
  const inside = (e) => children(e.data, e.stop);
  function integer(e, signed = false) {
    assert.ok(e.stop > e.data && e.stop - e.data <= 8);
    let result = 0n;
    for (let i = e.data; i < e.stop; i++) result = (result << 8n) | BigInt(bytes[i]);
    if (signed && bytes[e.data] & 128) result -= 1n << BigInt(8 * (e.stop - e.data));
    return result;
  }
  function one(entries, id, required = true) {
    const all = entries.filter((e) => e.id === id);
    assert.ok(
      all.length <= 1 && (!required || all.length === 1),
      `Missing/duplicate ${id.toString(16)}`,
    );
    return all[0];
  }
  const segment = one(children(0, bytes.length), 0x18538067);
  const level = inside(segment);
  const info = inside(one(level, 0x1549a966));
  const scaleElement = one(info, 0x2ad7b1, false);
  const scale = scaleElement ? integer(scaleElement) : 1000000n;
  const entries = inside(one(level, 0x1654ae6b)).filter((e) => e.id === 0xae);
  const tracks = entries.map((entry) => {
    const fields = inside(entry);
    const text = (id) => {
      const e = one(fields, id);
      return bytes.subarray(e.data, e.stop).toString('utf8');
    };
    const optional = (id) => {
      const e = one(fields, id, false);
      return e ? { offset: e.at, value: integer(e) } : null;
    };
    assert.equal(
      one(fields, 0x23314f, false),
      undefined,
      'TrackTimestampScale unsupported; no implicit float conversion',
    );
    const privateElement = one(fields, 0x63a2, false);
    const privateBytes = privateElement && bytes.subarray(privateElement.data, privateElement.stop);
    const codec = text(0x86);
    let opus = null;
    if (codec === 'A_OPUS') {
      assert.equal(privateBytes?.subarray(0, 8).toString(), 'OpusHead');
      assert.equal(privateBytes.length, 19);
      assert.equal(privateBytes[18], 0, 'Only mapping family 0 fixture');
      opus = {
        offset: privateElement.data,
        bytesHex: privateBytes.toString('hex'),
        version: privateBytes[8],
        channels: privateBytes[9],
        preSkip: BigInt(privateBytes.readUInt16LE(10)),
        inputRate: privateBytes.readUInt32LE(12),
      };
    }
    return {
      number: integer(one(fields, 0xd7)),
      codec,
      codecDelay: optional(0x56aa),
      seekPreRoll: optional(0x56bb),
      opus,
    };
  });
  const blocks = [];
  for (const cluster of level.filter((e) => e.id === 0x1f43b675)) {
    const fields = inside(cluster),
      clusterTime = integer(one(fields, 0xe7));
    for (const item of fields.filter((e) => e.id === 0xa3 || e.id === 0xa0)) {
      const group = item.id === 0xa0 ? inside(item) : null;
      const block = group ? one(group, 0xa1) : item;
      const track = vint(block.data),
        at = block.data + track.width;
      assert.ok(at + 3 < block.stop);
      const relative = BigInt(bytes.readInt16BE(at));
      assert.equal(bytes[at + 2] & 6, 0, 'Lacing unsupported in diagnostic');
      const payload = bytes.subarray(at + 3, block.stop);
      const discard = group && one(group, 0x75a2, false);
      const duration = group && one(group, 0x9b, false);
      blocks.push({
        offset: block.at,
        kind: group ? 'BlockGroup' : 'SimpleBlock',
        track: track.value,
        clusterTicks: clusterTime,
        relativeTicks: relative,
        rawNs: (clusterTime + relative) * scale,
        discardPadding: discard
          ? { offset: discard.at, nanoseconds: integer(discard, true) }
          : null,
        blockDurationTicks: duration ? integer(duration) : null,
        toc: payload[0],
        payloadSha256: sha(payload),
      });
    }
  }
  return { timestampScaleNs: scale, scaleExplicit: !!scaleElement, tracks, blocks };
}
