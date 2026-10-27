import { assertDissolves } from './dissolve';
import { inspectPlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import type { VideoContentV2 } from '../v2/model';
import { assertVideoContentV2 } from '../v2/validation';
import { add, compare, multiply, subtract, time } from '../time';
import {
  fields,
  id,
  list,
  rational,
  integer,
  assertMediaAssetFields,
  requireValue as need,
} from '../validation-core';
import type { VideoContentV3 } from './model';
/** Internal media projection for existing v2 media validators/adapters, never a saved downgrade. */
export function mediaContentV3(content: VideoContentV3): VideoContentV2 {
  const { transitions, ...sequence } = content.sequence;
  void transitions;
  return {
    ...content,
    schema: 'video-core-prototype-v2',
    sources: content.sources.filter((s): s is VideoContentV2['sources'][number] => !('kind' in s)),
    sequence: {
      ...sequence,
      clips: content.sequence.clips
        .filter((c) => c.kind === 'video' || c.kind === 'audio')
        .map((c) => {
          const { linkGroupId, ...base } = c;
          void linkGroupId;
          if (base.kind !== 'video') return base;
          const { visualFade, ...plain } = base;
          void visualFade;
          return plain;
        }),
    },
  };
}
export function assertVideoContentV3(
  value: unknown,
  identities = new Map<string, string>(),
): asserts value is VideoContentV3 {
  const v = fields(value, ['schema', 'sequence', 'sources']);
  need(v.schema === 'video-core-prototype-v3', 'Unsupported video v3 schema');
  const q = fields(v.sequence, ['id', 'duration', 'frameRate', 'tracks', 'clips'], ['transitions']);
  const clips = list(q.clips, 1000);
  for (const raw of list(v.sources, 1000)) {
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) continue;
    if (raw.kind === 'font') {
      const source = fields(raw, ['id', 'kind', 'asset', 'fontProfile', 'weight']);
      id(source.id);
      assertMediaAssetFields(source.asset);
      need(
        (source.asset as { byteLength: number }).byteLength <= 18 * 1024 * 1024,
        'Font asset bytes',
      );
      need(
        source.fontProfile === 'noto-cjk-jp-2.004' &&
          ['regular', 'bold'].includes(source.weight as string),
        'Unsupported fixed font source',
      );
      continue;
    }
    const source = fields(raw, ['id', 'kind', 'asset', 'mime', 'width', 'height', 'orientation']);
    need(source.kind === 'image', 'Unknown v3 source kind');
    id(source.id);
    assertMediaAssetFields(source.asset);
    need(
      (source.asset as { byteLength: number }).byteLength <= 16 * 1024 * 1024,
      'Image encoded bytes',
    );
    need(source.mime === 'image/png' || source.mime === 'image/jpeg', 'Image MIME');
    integer(source.width, 1, 8192);
    integer(source.height, 1, 8192);
    need((source.width as number) * (source.height as number) <= 16 * 1024 * 1024, 'Image pixels');
    integer(source.orientation, 1, 8);
    need(source.mime !== 'image/png' || source.orientation === 1, 'PNG orientation');
  }
  for (const raw of clips) {
    need(raw && typeof raw === 'object', 'Invalid v3 clip');
    const kind = (raw as { kind?: unknown }).kind;
    need(
      ['video', 'audio', 'animation', 'image', 'title', 'caption'].includes(kind as string),
      'Unsupported v3 clip kind',
    );
    if (kind !== 'animation' && kind !== 'image' && kind !== 'title' && kind !== 'caption')
      continue;
    const c = fields(
      raw,
      [
        'id',
        'kind',
        'trackId',
        'start',
        'duration',
        'sourceIn',
        'sourceOut',
        'rate',
        kind === 'animation' ? 'embed' : 'sourceId',
        ...(kind === 'title' || kind === 'caption' ? ['text', 'style'] : []),
      ],
      ['visualFade', 'linkGroupId'],
    );
    id(c.id);
    id(c.trackId);
    rational(c.start);
    rational(c.duration, true);
    rational(c.sourceIn);
    rational(c.sourceOut);
    rational(c.rate, true);
  }
  const content = value as VideoContentV3,
    media = mediaContentV3(content);
  assertVideoContentV2(media);
  for (const clip of content.sequence.clips) {
    if (clip.kind === 'audio' || !Object.hasOwn(clip, 'visualFade')) continue;
    const f = fields(clip.visualFade, ['start', 'end', 'in', 'out']);
    for (const t of [f.start, f.end, f.in, f.out]) rational(t);
    const fade = clip.visualFade!;
    need(
      compare(fade.start, fade.end) < 0 &&
        compare(fade.in, time(0)) >= 0 &&
        compare(fade.out, time(0)) >= 0 &&
        compare(add(fade.in, fade.out), subtract(fade.end, fade.start)) <= 0,
      'Visual fade duration',
    );
  }
  const fixedIds = [
    content.sequence.id,
    ...content.sequence.tracks.map((t) => t.id),
    // Stream IDs are scoped to each source, not globally unique.
    ...content.sources.map((s) => s.id),
    ...media.sequence.clips.map((c) => c.id),
  ];
  const ids = new Set(fixedIds);
  need(ids.size === fixedIds.length, 'Duplicate source/stream/track ID');
  for (const clip of content.sequence.clips) {
    if (
      clip.kind !== 'animation' &&
      clip.kind !== 'image' &&
      clip.kind !== 'title' &&
      clip.kind !== 'caption'
    )
      continue;
    need(!ids.has(clip.id), 'Duplicate animation clip ID');
    ids.add(clip.id);
    const track = content.sequence.tracks.find((t) => t.id === clip.trackId);
    need(track?.kind === 'visual', 'Animation requires visual track');
    need(
      compare(clip.start, time(0)) >= 0 &&
        compare(add(clip.start, clip.duration), content.sequence.duration) <= 0,
      'Animation placement outside sequence',
    );
    if (clip.kind === 'title' || clip.kind === 'caption') {
      id(clip.sourceId);
      need(
        content.sources.some((s) => s.id === clip.sourceId && 'kind' in s && s.kind === 'font'),
        'Missing title font',
      );
      need(
        typeof clip.text === 'string' &&
          clip.text.length > 0 &&
          clip.text.length <= 4096 &&
          !Array.from(clip.text).some((c) => {
            const n = c.codePointAt(0)!;
            return (n < 32 && n !== 10) || n === 127;
          }),
        'Unsupported title text',
      );
      const style = fields(clip.style, ['x', 'y', 'width', 'height', 'size', 'color', 'align']);
      for (const key of ['x', 'y', 'width', 'height', 'size'])
        need(
          typeof style[key] === 'number' &&
            Number.isFinite(style[key]) &&
            (style[key] as number) >= 0 &&
            (style[key] as number) <= 1,
          'Title geometry',
        );
      need(
        clip.style.width > 0 &&
          clip.style.height > 0 &&
          clip.style.size > 0 &&
          clip.style.x + clip.style.width <= 1 &&
          clip.style.y + clip.style.height <= 1,
        'Title box',
      );
      need(
        /^#[0-9a-f]{6}$/i.test(clip.style.color) &&
          ['left', 'center', 'right'].includes(clip.style.align),
        'Title style',
      );
      need(
        compare(clip.rate, time(1)) === 0 &&
          compare(clip.sourceIn, time(0)) >= 0 &&
          compare(subtract(clip.sourceOut, clip.sourceIn), clip.duration) === 0,
        'Title interval',
      );
      continue;
    }
    if (clip.kind === 'image') {
      id(clip.sourceId);
      need(
        content.sources.some((s) => s.id === clip.sourceId && 'kind' in s && s.kind === 'image'),
        'Missing image source',
      );
      need(
        compare(clip.rate, time(1)) === 0 &&
          compare(clip.sourceIn, time(0)) >= 0 &&
          compare(subtract(clip.sourceOut, clip.sourceIn), clip.duration) === 0,
        'Image source interval',
      );
      continue;
    }
    const inspected = inspectPlayableAnimationEmbed(clip.embed, identities);
    need(inspected.kind === 'scene2', 'Native Animation schema 2 required');
    need(
      !inspected.embed.loop &&
        inspected.embed.fit === 'contain' &&
        inspected.embed.inputs.length === 0,
      'Video owns Animation playback',
    );
    const composition = inspected.embed.snapshot.compositions.find(
      (c) => c.id === inspected.embed.source.compositionId,
    )!;
    need(
      compare(clip.sourceIn, time(0)) >= 0 &&
        compare(clip.sourceIn, clip.sourceOut) < 0 &&
        compare(
          clip.sourceOut,
          time(composition.duration, inspected.embed.snapshot.ticksPerSecond),
        ) <= 0 &&
        compare(subtract(clip.sourceOut, clip.sourceIn), multiply(clip.duration, clip.rate)) === 0,
      'Animation source range',
    );
    for (const at of [clip.sourceIn, clip.sourceOut])
      need(
        multiply(at, time(inspected.embed.snapshot.ticksPerSecond)).timescale === 1,
        'Fractional Animation tick',
      );
  }
  assertDissolves(content, ids);
  const groups = new Map<string, number>();
  for (const clip of content.sequence.clips) {
    if (!Object.hasOwn(clip, 'linkGroupId')) continue;
    id(clip.linkGroupId);
    groups.set(clip.linkGroupId!, (groups.get(clip.linkGroupId!) ?? 0) + 1);
  }
  for (const [group, count] of groups) need(count >= 2 && !ids.has(group), 'Invalid link group');
  // The current visual track has one active clip. Animation does not silently change stacking policy.
  for (const track of content.sequence.tracks.filter((t) => t.kind === 'visual')) {
    const visual = content.sequence.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => compare(a.start, b.start));
    for (let i = 1; i < visual.length; i++)
      need(
        compare(add(visual[i - 1].start, visual[i - 1].duration), visual[i].start) <= 0,
        'Overlapping visual clips',
      );
  }
}
