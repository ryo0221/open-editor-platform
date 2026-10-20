/** Shared bounded MP4 box reader for the private SDR AVC + optional AAC probe profiles. */
import { add, compare, time, type Time } from '@editor-platform/video-core';
export interface Box {
  type: string;
  data: number;
  end: number;
}
export type TrackKind = 'video' | 'audio';
export interface Mp4Track {
  id: number;
  kind: TrackKind;
  scale: number;
  duration: number;
  mediaStart: Time;
  mediaEnd: Time;
  presentationStart: Time;
  channels?: number;
}
/** Version-specific admission differences; everything else is one bounded parser. */
export interface Mp4Profile {
  transforms(kind: TrackKind): readonly (readonly number[])[];
  reference(refs: Box[]): Box;
  quickTimePadding: boolean;
  colorType(r: Mp4Reader, color: Box): boolean;
  audioVersions: readonly number[];
}
interface Run {
  count: number;
  ticks: number;
}
interface Span {
  intervals: { start: bigint; end: bigint }[];
  low: bigint;
  high: bigint;
}
interface EditWindow {
  mediaStart: Time;
  mediaEnd: Time;
  presentationStart: Time;
}
export const IDENTITY = [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824];
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
export class Mp4Reader {
  readonly view: DataView;
  private count = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer);
  }
  boxes(start: number, end: number): Box[] {
    const found: Box[] = [];
    while (start < end) {
      if (++this.count > 10000 || start + 8 > end) throw Error('MP4 box bounds/count');
      const size = this.view.getUint32(start),
        type = this.fourcc(start + 4);
      if (size < 8 || start + size > end)
        throw Error('MP4 large/zero/truncated box outside profile');
      found.push({ type, data: start + 8, end: start + size });
      start += size;
    }
    return found;
  }
  children(b: Box) {
    return this.boxes(b.data, b.end);
  }
  fourcc(at: number) {
    return String.fromCharCode(...this.bytes.slice(at, at + 4));
  }
  u32(b: Box, at: number) {
    if (at < b.data || at + 4 > b.end) throw Error('MP4 field bounds');
    return this.view.getUint32(at);
  }
  full0(b: Box) {
    if (this.u32(b, b.data) >>> 24 !== 0) throw Error('MP4 version outside profile');
  }
}
export function one(list: Box[], type: string) {
  const matches = list.filter((b) => b.type === type);
  if (matches.length !== 1) throw Error('MP4 requires one ' + type);
  return matches[0];
}
/** Reads the bounded movie and returns one mapped stream per admitted track, in file order. */
export async function inspectMp4<S extends { kind: TrackKind }>(
  original: Blob,
  signal: AbortSignal,
  profile: Mp4Profile,
  toStream: (track: Mp4Track) => S,
): Promise<S[]> {
  signal.throwIfAborted();
  if (original.size > 16 * 1024 * 1024) throw Error('MP4 probe quota');
  const r = new Mp4Reader(new Uint8Array(await original.arrayBuffer()));
  signal.throwIfAborted();
  const roots = r.boxes(0, r.bytes.length);
  if (roots.some((b) => b.type === 'moof')) throw Error('Fragmented MP4 outside profile');
  const moov = r.children(one(roots, 'moov')),
    mvhd = one(moov, 'mvhd');
  r.full0(mvhd);
  const movieScale = r.u32(mvhd, mvhd.data + 12);
  if (!movieScale) throw Error('MP4 movie clock');
  const streams: S[] = [];
  for (const trak of moov.filter((b) => b.type === 'trak'))
    streams.push(toStream(readTrack(r, trak, movieScale, profile, streams)));
  return streams;
}
function readTrack(
  r: Mp4Reader,
  trak: Box,
  movieScale: number,
  profile: Mp4Profile,
  seen: { kind: TrackKind }[],
): Mp4Track {
  const track = r.children(trak),
    mdia = r.children(one(track, 'mdia')),
    kind = trackKind(r, one(mdia, 'hdlr'));
  if (seen.some((s) => s.kind === kind)) throw Error('Explicit alternate-track selection required');
  const { scale, duration, id } = trackClock(r, track, mdia, profile.transforms(kind));
  const stbl = r.children(one(r.children(one(mdia, 'minf')), 'stbl'));
  checkReference(r, mdia, profile);
  const entry = sampleEntry(r, stbl, kind);
  const { durations, sampleCount } = sampleDurations(r, stbl, duration);
  const span = presentationSpan(durations, compositionOffsets(r, stbl, sampleCount));
  const edit = editWindow(r, track, movieScale, scale, duration);
  checkCoverage(span, edit, scale);
  if (kind === 'video') {
    checkAvc(r, entry, profile);
    return { id, kind, scale, duration, ...edit };
  }
  return { id, kind, scale, duration, ...edit, channels: checkAac(r, entry, scale, profile) };
}
function trackKind(r: Mp4Reader, hdlr: Box): TrackKind {
  const handler = r.fourcc(hdlr.data + 8);
  if (handler !== 'vide' && handler !== 'soun') throw Error('MP4 non-A/V track outside profile');
  return handler === 'vide' ? 'video' : 'audio';
}
function trackClock(
  r: Mp4Reader,
  track: Box[],
  mdia: Box[],
  transforms: readonly (readonly number[])[],
) {
  const mdhd = one(mdia, 'mdhd'),
    tkhd = one(track, 'tkhd');
  r.full0(mdhd);
  r.full0(tkhd);
  const scale = r.u32(mdhd, mdhd.data + 12),
    duration = r.u32(mdhd, mdhd.data + 16),
    id = r.u32(tkhd, tkhd.data + 12);
  if (!scale || !duration || !id) throw Error('MP4 track clock/id');
  const matches = (matrix: readonly number[]) =>
    matrix.every((v, i) => r.u32(tkhd, tkhd.data + 40 + i * 4) === v);
  if (!transforms.some(matches)) throw Error('Rotation/transform outside preview profile');
  return { scale, duration, id };
}
function checkReference(r: Mp4Reader, mdia: Box[], profile: Mp4Profile) {
  const dref = one(r.children(one(r.children(one(mdia, 'minf')), 'dinf')), 'dref');
  r.full0(dref);
  if (r.u32(dref, dref.data + 4) !== 1) throw Error('External media references');
  const url = profile.reference(r.boxes(dref.data + 8, dref.end));
  if (r.u32(url, url.data) !== 1 || url.end !== url.data + 4)
    throw Error('External media references');
}
function sampleEntry(r: Mp4Reader, stbl: Box[], kind: TrackKind) {
  const stsd = one(stbl, 'stsd');
  r.full0(stsd);
  if (r.u32(stsd, stsd.data + 4) !== 1) throw Error('Multiple codec descriptions');
  const descriptions = r.boxes(stsd.data + 8, stsd.end),
    entry = one(descriptions, kind === 'video' ? 'avc1' : 'mp4a');
  if (descriptions.length !== 1) throw Error('Codec profile');
  return entry;
}
function sampleDurations(r: Mp4Reader, stbl: Box[], duration: number) {
  const stts = one(stbl, 'stts');
  r.full0(stts);
  const runs = r.u32(stts, stts.data + 4);
  if (runs < 1 || runs > 10000 || stts.data + 8 + runs * 8 !== stts.end)
    throw Error('Sample table quota');
  let ticks = 0n,
    sampleCount = 0;
  const durations: Run[] = [];
  for (let i = 0; i < runs; i++) {
    const n = r.u32(stts, stts.data + 8 + i * 8),
      d = r.u32(stts, stts.data + 12 + i * 8);
    if (!n || !d || sampleCount + n > 100000) throw Error('Sample duration/count quota');
    sampleCount += n;
    ticks += BigInt(n) * BigInt(d);
    durations.push({ count: n, ticks: d });
  }
  if (ticks !== BigInt(duration)) throw Error('Media/sample duration mismatch');
  return { durations, sampleCount };
}
function compositionOffsets(r: Mp4Reader, stbl: Box[], sampleCount: number): Run[] {
  const composition = stbl.filter((b) => b.type === 'ctts');
  if (composition.length > 1) throw Error('Duplicate composition table');
  if (!composition.length) return [{ count: sampleCount, ticks: 0 }];
  const ctts = composition[0],
    version = r.u32(ctts, ctts.data) >>> 24,
    n = r.u32(ctts, ctts.data + 4);
  if (version > 1 || n < 1 || n > 10000 || ctts.data + 8 + n * 8 !== ctts.end)
    throw Error('Composition table quota');
  const offsets: Run[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const count = r.u32(ctts, ctts.data + 8 + i * 8),
      raw = r.u32(ctts, ctts.data + 12 + i * 8);
    if (!count || total + count > sampleCount) throw Error('Composition count');
    total += count;
    offsets.push({ count, ticks: version === 1 ? raw | 0 : raw });
  }
  if (total !== sampleCount) throw Error('Composition count mismatch');
  return offsets;
}
function presentationSpan(durations: Run[], offsets: Run[]): Span {
  const intervals: Span['intervals'] = [];
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
  return { intervals, low, high };
}
function editWindow(
  r: Mp4Reader,
  track: Box[],
  movieScale: number,
  scale: number,
  duration: number,
): EditWindow {
  let mediaStart: Time = time(0),
    presentationStart: Time = time(0),
    validDuration = time(duration, scale);
  const edits = track.filter((b) => b.type === 'edts');
  if (edits.length > 1) throw Error('Duplicate edits');
  if (edits.length) {
    const elst = one(r.children(edits[0]), 'elst');
    r.full0(elst);
    const n = r.u32(elst, elst.data + 4);
    if (n < 1 || n > 2 || elst.data + 8 + n * 12 !== elst.end)
      throw Error('Complex edits outside profile');
    for (let i = 0; i < n; i++) {
      const at = elst.data + 8 + i * 12,
        span = r.u32(elst, at),
        raw = r.u32(elst, at + 4);
      if (r.u32(elst, at + 8) !== 65536 || !span) throw Error('Non-unit/empty edit');
      if (raw === 0xffffffff && i === 0 && n === 2) presentationStart = time(span, movieScale);
      else if (i === n - 1 && raw <= 0x7fffffff) {
        mediaStart = time(raw, scale);
        validDuration = time(span, movieScale);
      } else throw Error('Unsupported edit list');
    }
  }
  return { mediaStart, mediaEnd: add(mediaStart, validDuration), presentationStart };
}
function checkCoverage({ intervals, low, high }: Span, edit: EditWindow, scale: number) {
  const { mediaStart, mediaEnd } = edit;
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
}
function videoDescription(r: Mp4Reader, entry: Box, quickTimePadding: boolean) {
  if (!quickTimePadding) return r.boxes(entry.data + 78, entry.end);
  // Parse complete child boxes first: a valid final field may itself be zero.
  // Only the already-supported four-byte QuickTime padding needs the fallback.
  try {
    return r.boxes(entry.data + 78, entry.end);
  } catch (error) {
    if (entry.end < entry.data + 82 || r.view.getUint32(entry.end - 4) !== 0) throw error;
    return r.boxes(entry.data + 78, entry.end - 4);
  }
}
function checkAvc(r: Mp4Reader, entry: Box, profile: Mp4Profile) {
  const description = videoDescription(r, entry, profile.quickTimePadding),
    color = one(description, 'colr');
  if (
    !profile.colorType(r, color) ||
    r.view.getUint16(color.data + 4) !== 1 ||
    r.view.getUint16(color.data + 6) !== 1 ||
    r.view.getUint16(color.data + 8) !== 1
  )
    throw Error('Only explicit BT.709 SDR preview profile');
  const avcc = one(description, 'avcC');
  if (avcc.end < avcc.data + 7 || r.bytes[avcc.data] !== 1) throw Error('AVC configuration');
}
function descriptor(bytes: Uint8Array, at: number, limit: number, tag: number) {
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
}
function audioEsds(r: Mp4Reader, entry: Box, scale: number, versions: readonly number[]) {
  if (
    entry.data + 28 > entry.end ||
    !versions.includes(r.view.getUint16(entry.data + 8)) ||
    r.u32(entry, entry.data + 24) !== scale * 65536
  )
    throw Error('Audio sample entry clock/version');
  const version = r.view.getUint16(entry.data + 8);
  const description = r.boxes(entry.data + (version === 1 ? 44 : 28), entry.end);
  return version === 1
    ? one(r.children(one(description, 'wave')), 'esds')
    : one(description, 'esds');
}
/** Returns the AAC-LC channel count. */
function checkAac(r: Mp4Reader, entry: Box, scale: number, profile: Mp4Profile) {
  const esds = audioEsds(r, entry, scale, profile.audioVersions),
    bytes = r.bytes;
  r.full0(esds);
  const es = descriptor(bytes, esds.data + 4, esds.end, 3);
  if (es.start + 3 > es.end || bytes[es.start + 2] !== 0)
    throw Error('AAC external/optional ES references');
  const config = descriptor(bytes, es.start + 3, es.end, 4);
  if (
    config.start + 13 > config.end ||
    bytes[config.start] !== 0x40 ||
    bytes[config.start + 1] !== 0x15
  )
    throw Error('AAC decoder config');
  const asc = descriptor(bytes, config.start + 13, config.end, 5);
  if (asc.end - asc.start < 2) throw Error('AAC ASC');
  const b0 = bytes[asc.start],
    b1 = bytes[asc.start + 1],
    objectType = b0 >> 3,
    rateIndex = ((b0 & 7) << 1) | (b1 >> 7),
    channels = (b1 >> 3) & 15;
  if (objectType !== 2 || AAC_RATES[rateIndex] !== scale || ![1, 2].includes(channels))
    throw Error('AAC-LC mono/stereo profile');
  return channels;
}
