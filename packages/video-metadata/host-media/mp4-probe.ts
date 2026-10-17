/** Bounded private feasibility profile: unfragmented SDR AVC + optional AAC, unit-rate edit. */
import { add, compare, time, type Time } from '@editor-platform/video-core';
import type { ImportSet, ProbePort, SelectedStream } from './import';
interface Box {
  type: string;
  data: number;
  end: number;
}
export const mp4Probe: ProbePort = {
  async inspect(original, signal): Promise<ImportSet> {
    signal.throwIfAborted();
    if (original.size > 16 * 1024 * 1024) throw Error('MP4 probe quota');
    const bytes = new Uint8Array(await original.arrayBuffer()),
      view = new DataView(bytes.buffer);
    signal.throwIfAborted();
    let count = 0;
    const boxes = (start: number, end: number): Box[] => {
      const found: Box[] = [];
      while (start < end) {
        if (++count > 10000 || start + 8 > end) throw Error('MP4 box bounds/count');
        const size = view.getUint32(start),
          type = String.fromCharCode(...bytes.slice(start + 4, start + 8));
        if (size < 8 || start + size > end)
          throw Error('MP4 large/zero/truncated box outside profile');
        found.push({ type, data: start + 8, end: start + size });
        start += size;
      }
      return found;
    };
    const one = (list: Box[], type: string) => {
      const matches = list.filter((b) => b.type === type);
      if (matches.length !== 1) throw Error('MP4 requires one ' + type);
      return matches[0];
    };
    const children = (b: Box) => boxes(b.data, b.end);
    const u32 = (b: Box, at: number) => {
      if (at < b.data || at + 4 > b.end) throw Error('MP4 field bounds');
      return view.getUint32(at);
    };
    const full0 = (b: Box) => {
      if (u32(b, b.data) >>> 24 !== 0) throw Error('MP4 version outside profile');
    };
    const roots = boxes(0, bytes.length);
    if (roots.some((b) => b.type === 'moof')) throw Error('Fragmented MP4 outside profile');
    const moov = children(one(roots, 'moov')),
      mvhd = one(moov, 'mvhd');
    full0(mvhd);
    const movieScale = u32(mvhd, mvhd.data + 12);
    if (!movieScale) throw Error('MP4 movie clock');
    const streams: SelectedStream[] = [];
    for (const trak of moov.filter((b) => b.type === 'trak')) {
      const track = children(trak),
        mdia = children(one(track, 'mdia')),
        hdlr = one(mdia, 'hdlr');
      const handler = String.fromCharCode(...bytes.slice(hdlr.data + 8, hdlr.data + 12));
      if (handler !== 'vide' && handler !== 'soun')
        throw Error('MP4 non-A/V track outside profile');
      const kind = handler === 'vide' ? 'video' : 'audio';
      if (streams.some((s) => s.kind === kind))
        throw Error('Explicit alternate-track selection required');
      const mdhd = one(mdia, 'mdhd'),
        tkhd = one(track, 'tkhd');
      full0(mdhd);
      full0(tkhd);
      const scale = u32(mdhd, mdhd.data + 12),
        duration = u32(mdhd, mdhd.data + 16),
        id = u32(tkhd, tkhd.data + 12);
      if (!scale || !duration || !id) throw Error('MP4 track clock/id');
      const matrix = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
      if (matrix.some((v, i) => u32(tkhd, tkhd.data + 40 + i * 4) !== v))
        throw Error('Rotation/transform outside preview profile');
      const stbl = children(one(children(one(mdia, 'minf')), 'stbl'));
      const dref = one(children(one(children(one(mdia, 'minf')), 'dinf')), 'dref');
      full0(dref);
      if (u32(dref, dref.data + 4) !== 1) throw Error('External media references');
      const url = one(boxes(dref.data + 8, dref.end), 'url ');
      if (u32(url, url.data) !== 1 || url.end !== url.data + 4)
        throw Error('External media references');
      const stsd = one(stbl, 'stsd');
      full0(stsd);
      if (u32(stsd, stsd.data + 4) !== 1) throw Error('Multiple codec descriptions');
      const descriptions = boxes(stsd.data + 8, stsd.end),
        entry = one(descriptions, kind === 'video' ? 'avc1' : 'mp4a');
      if (descriptions.length !== 1) throw Error('Codec profile');
      const stts = one(stbl, 'stts');
      full0(stts);
      const runs = u32(stts, stts.data + 4);
      if (runs < 1 || runs > 10000 || stts.data + 8 + runs * 8 !== stts.end)
        throw Error('Sample table quota');
      let ticks = 0n,
        sampleCount = 0;
      const durations: { count: number; ticks: number }[] = [];
      for (let i = 0; i < runs; i++) {
        const n = u32(stts, stts.data + 8 + i * 8),
          d = u32(stts, stts.data + 12 + i * 8);
        if (!n || !d || sampleCount + n > 100000) throw Error('Sample duration/count quota');
        sampleCount += n;
        ticks += BigInt(n) * BigInt(d);
        durations.push({ count: n, ticks: d });
      }
      if (ticks !== BigInt(duration)) throw Error('Media/sample duration mismatch');
      const composition = stbl.filter((b) => b.type === 'ctts');
      if (composition.length > 1) throw Error('Duplicate composition table');
      const offsets: { count: number; ticks: number }[] = [];
      if (composition.length) {
        const ctts = composition[0],
          version = u32(ctts, ctts.data) >>> 24,
          n = u32(ctts, ctts.data + 4);
        if (version > 1 || n < 1 || n > 10000 || ctts.data + 8 + n * 8 !== ctts.end)
          throw Error('Composition table quota');
        let total = 0;
        for (let i = 0; i < n; i++) {
          const count = u32(ctts, ctts.data + 8 + i * 8),
            raw = u32(ctts, ctts.data + 12 + i * 8);
          if (!count || total + count > sampleCount) throw Error('Composition count');
          total += count;
          offsets.push({ count, ticks: version === 1 ? raw | 0 : raw });
        }
        if (total !== sampleCount) throw Error('Composition count mismatch');
      } else offsets.push({ count: sampleCount, ticks: 0 });
      const intervals: { start: bigint; end: bigint }[] = [];
      let decode = 0n,
        low: bigint | undefined,
        high = 0n,
        offsetRun = 0,
        offsetRemaining = offsets[0].count;
      for (const run of durations)
        for (let i = 0; i < run.count; i++) {
          const pts = decode + BigInt(offsets[offsetRun].ticks),
            end = pts + BigInt(run.ticks);
          intervals.push({ start: pts, end });
          if (low === undefined || pts < low) low = pts;
          if (end > high) high = end;
          decode += BigInt(run.ticks);
          if (--offsetRemaining === 0 && ++offsetRun < offsets.length)
            offsetRemaining = offsets[offsetRun].count;
        }
      if (
        low === undefined ||
        high > BigInt(Number.MAX_SAFE_INTEGER) ||
        low < BigInt(Number.MIN_SAFE_INTEGER)
      )
        throw Error('Presentation clock overflow');
      let mediaStart: Time = time(0),
        presentationStart: Time = time(0),
        validDuration = time(duration, scale);
      const edits = track.filter((b) => b.type === 'edts');
      if (edits.length > 1) throw Error('Duplicate edits');
      if (edits.length) {
        const elst = one(children(edits[0]), 'elst');
        full0(elst);
        const n = u32(elst, elst.data + 4);
        if (n < 1 || n > 2 || elst.data + 8 + n * 12 !== elst.end)
          throw Error('Complex edits outside profile');
        for (let i = 0; i < n; i++) {
          const at = elst.data + 8 + i * 12,
            span = u32(elst, at),
            raw = u32(elst, at + 4);
          if (u32(elst, at + 8) !== 65536 || !span) throw Error('Non-unit/empty edit');
          if (raw === 0xffffffff && i === 0 && n === 2) presentationStart = time(span, movieScale);
          else if (i === n - 1 && raw <= 0x7fffffff) {
            mediaStart = time(raw, scale);
            validDuration = time(span, movieScale);
          } else throw Error('Unsupported edit list');
        }
      }
      const mediaEnd = add(mediaStart, validDuration);
      if (
        compare(mediaEnd, time(Number(high), scale)) > 0 ||
        compare(mediaStart, time(Number(low), scale)) < 0
      )
        throw Error('Edit exceeds media');
      // Envelope bounds alone do not establish coverage. B-frame packet order
      // is irrelevant: merge the actual presentation intervals in PTS order.
      intervals.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      let cursorN = BigInt(mediaStart.value) * BigInt(scale),
        cursorD = BigInt(mediaStart.timescale);
      const endN = BigInt(mediaEnd.value) * BigInt(scale),
        endD = BigInt(mediaEnd.timescale);
      for (const interval of intervals) {
        if (cursorN * endD >= endN * cursorD) break;
        if (interval.end * cursorD <= cursorN) continue;
        if (interval.start * cursorD > cursorN) throw Error('Selected media presentation gap');
        cursorN = interval.end;
        cursorD = 1n;
      }
      if (cursorN * endD < endN * cursorD) throw Error('Selected media presentation gap');
      if (kind === 'video') {
        const description = boxes(entry.data + 78, entry.end),
          color = one(description, 'colr');
        if (
          color.end !== color.data + 11 ||
          String.fromCharCode(...bytes.slice(color.data, color.data + 4)) !== 'nclx' ||
          view.getUint16(color.data + 4) !== 1 ||
          view.getUint16(color.data + 6) !== 1 ||
          view.getUint16(color.data + 8) !== 1
        )
          throw Error('Only explicit BT.709 SDR preview profile');
        const avcc = one(description, 'avcC');
        if (avcc.end < avcc.data + 7 || bytes[avcc.data] !== 1) throw Error('AVC configuration');
      }
      if (kind === 'audio') {
        if (
          entry.data + 28 > entry.end ||
          view.getUint16(entry.data + 8) !== 0 ||
          u32(entry, entry.data + 24) !== scale * 65536
        )
          throw Error('Audio sample entry clock/version');
        const esds = one(boxes(entry.data + 28, entry.end), 'esds');
        full0(esds);
        const descriptor = (at: number, limit: number, tag: number) => {
          if (at >= limit || bytes[at++] !== tag) throw Error('AAC descriptor tag');
          let length = 0,
            octet = 0,
            n = 0;
          do {
            if (at >= limit || ++n > 4) throw Error('AAC descriptor bounds');
            octet = bytes[at++];
            length = length * 128 + (octet & 127);
          } while (octet & 128);
          if (at + length > limit) throw Error('AAC descriptor length');
          return { start: at, end: at + length };
        };
        const es = descriptor(esds.data + 4, esds.end, 3);
        if (es.start + 3 > es.end || bytes[es.start + 2] !== 0)
          throw Error('AAC external/optional ES references');
        const config = descriptor(es.start + 3, es.end, 4);
        if (
          config.start + 13 > config.end ||
          bytes[config.start] !== 0x40 ||
          bytes[config.start + 1] !== 0x15
        )
          throw Error('AAC decoder config');
        const asc = descriptor(config.start + 13, config.end, 5);
        if (asc.end - asc.start < 2) throw Error('AAC ASC');
        const b0 = bytes[asc.start],
          b1 = bytes[asc.start + 1],
          objectType = b0 >> 3,
          rateIndex = ((b0 & 7) << 1) | (b1 >> 7),
          channels = (b1 >> 3) & 15;
        const rates = [
          96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
        ];
        if (objectType !== 2 || rates[rateIndex] !== scale || ![1, 2].includes(channels))
          throw Error('AAC-LC mono/stereo profile');
      }
      streams.push({
        id: String(id),
        kind,
        destination: kind === 'video' ? 'visual' : 'audio',
        mediaStart,
        mediaEnd,
        presentationStart,
        ...(kind === 'audio' ? { sampleRate: scale } : {}),
      });
    }
    if (streams.filter((s) => s.kind === 'video').length !== 1)
      throw Error('One video track required');
    signal.throwIfAborted();
    return { streams };
  },
};
