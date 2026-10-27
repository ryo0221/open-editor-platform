import { add, compare, time, type Time, type TextClipV3 } from '@editor-platform/video-core';
export interface CaptionCue {
  start: Time;
  end: Time;
  text: string;
}
export type CaptionFormat = 'srt' | 'vtt';
function plain(text: string) {
  if (
    !text ||
    text.startsWith('\n') ||
    text.endsWith('\n') ||
    text.includes('\n\n') ||
    text.length > 4096 ||
    /[<>&]/u.test(text) ||
    Array.from(text).some((c) => {
      const n = c.codePointAt(0)!;
      return (n < 32 && n !== 10) || n === 127;
    })
  )
    throw Error('Unsupported plain caption text/markup');
  return text;
}
function stamp(value: string, format: CaptionFormat): Time {
  const match = (
    format === 'srt'
      ? /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/
      : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/
  ).exec(value);
  if (!match) throw Error('Unsupported caption timestamp');
  const ms =
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 +
    Number(match[4]);
  if (!Number.isSafeInteger(ms)) throw Error('Caption timestamp overflow');
  return time(ms, 1000);
}
/** Strict plain-cue subset: reject unsupported semantics, never silently strip them. */
export function parseCaptions(bytes: Uint8Array, format: CaptionFormat): CaptionCue[] {
  if (!['srt', 'vtt'].includes(format) || bytes.length > 1024 * 1024)
    throw Error('Caption format/byte limit');
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
  if (text.includes('\r')) throw Error('Unsupported caption line ending');
  if (format === 'vtt') {
    if (!text.startsWith('WEBVTT\n\n')) throw Error('Unsupported WebVTT header/metadata');
    text = text.slice(8);
  }
  // A terminal LF/blank separator is syntax; text inside a cue is otherwise preserved.
  const blocks = text.replace(/\n+$/, '').split('\n\n');
  if (!blocks.length || blocks.length > 1000) throw Error('Caption cue limit');
  return blocks.map((block, index) => {
    const lines = block.split('\n');
    if (format === 'srt' && lines.shift() !== String(index + 1))
      throw Error('Unsupported SRT cue index');
    const interval = /^(\S+) --> (\S+)$/.exec(lines.shift() ?? '');
    if (!interval) throw Error('Unsupported caption cue/settings');
    const start = stamp(interval[1], format),
      end = stamp(interval[2], format);
    if (compare(start, end) >= 0) throw Error('Empty/reversed caption cue');
    return { start, end, text: plain(lines.join('\n')) };
  });
}
function formatTime(value: Time, format: CaptionFormat) {
  const scaled = BigInt(value.value) * 1000n,
    denominator = BigInt(value.timescale);
  if (scaled < 0 || scaled % denominator)
    throw Error('Caption sidecar requires exact milliseconds');
  const ms = scaled / denominator;
  const pad = (n: bigint, size = 2) => String(n).padStart(size, '0');
  return `${pad(ms / 3600000n)}:${pad((ms / 60000n) % 60n)}:${pad((ms / 1000n) % 60n)}${format === 'srt' ? ',' : '.'}${pad(ms % 1000n, 3)}`;
}
export function serializeCaptions(clips: TextClipV3[], format: CaptionFormat): string {
  if (!['srt', 'vtt'].includes(format)) throw Error('Caption format');
  const cues = clips
    .filter((c) => c.kind === 'caption')
    .sort((a, b) => compare(a.start, b.start) || a.id.localeCompare(b.id));
  if (!cues.length || cues.length > 1000) throw Error('Caption cue limit');
  const body = cues
    .map(
      (c, i) =>
        `${format === 'srt' ? `${i + 1}\n` : ''}${formatTime(c.start, format)} --> ${formatTime(add(c.start, c.duration), format)}\n${plain(c.text)}\n`,
    )
    .join('\n');
  if (new TextEncoder().encode(body).length > 1024 * 1024) throw Error('Caption byte limit');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + body;
}
