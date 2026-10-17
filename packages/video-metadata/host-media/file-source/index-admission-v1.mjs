import { mp4Index } from '../mp4-index.mjs';
/** Pre-import proof: every declared packet is disjoint and inside an actual mdat. */
export async function checkIndexV1(original, metadata, signal) {
  const index = mp4Index(await metadata.arrayBuffer(), {
    sourceProfile: 'iphone-sdr-v1',
    maximumSampleBytes: 1024 * 1024,
    fileBytes: original.size,
  });
  const ranges = [];
  let at = 0,
    boxes = 0;
  while (at < original.size) {
    signal.throwIfAborted();
    if (++boxes > 10000) throw Error('v1 root budget');
    const bytes = new Uint8Array(await original.slice(at, at + 16).arrayBuffer()),
      view = new DataView(bytes.buffer);
    if (bytes.length < 8) throw Error('v1 root header');
    let n = view.getUint32(0),
      head = 8;
    if (n === 1) {
      if (bytes.length < 16) throw Error('v1 extended header');
      const large = view.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('v1 root overflow');
      n = Number(large);
      head = 16;
    }
    if (n === 0) n = original.size - at;
    if (n < head || at + n > original.size) throw Error('v1 root range');
    if (String.fromCharCode(...bytes.subarray(4, 8)) === 'mdat')
      ranges.push({ start: at + head, end: at + n });
    at += n;
  }
  const samples = index.tracks.flatMap((t) => t.samples).sort((a, b) => a.offset - b.offset);
  let end = 0;
  for (const sample of samples) {
    if (
      sample.offset < end ||
      !ranges.some((r) => sample.offset >= r.start && sample.offset + sample.size <= r.end)
    )
      throw Error('v1 packet outside disjoint mdat coverage');
    end = sample.offset + sample.size;
  }
  signal.throwIfAborted();
  return { tracks: index.tracks.length, samples: samples.length };
}
