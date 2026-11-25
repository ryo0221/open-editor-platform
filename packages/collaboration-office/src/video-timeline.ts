import {
  assertVideoContentV3,
  isTime,
  time,
  videoCommandV3,
  type ClipV3,
  type Time,
  type VideoContentV3,
  type VideoEditV3,
} from '@editor-platform/video-core';
import {
  canonical,
  copy,
  fail,
  type Action,
  type DomainCodec,
} from '@editor-platform/collaboration-core';

export type SharedVideoEdit =
  | Extract<VideoEditV3, { type: 'move' | 'trim' | 'split' }>
  | { type: 'caption-text'; clipId: string; text: string };

/** Generated timeline inputs. The IDs and hashes declare synthetic sources, with no media files. */
export function videoTimelineFixture(): VideoContentV3 {
  const timing = { start: time(1), duration: time(2), sourceIn: time(0), sourceOut: time(2) };
  return {
    schema: 'video-core-prototype-v3',
    sources: [
      {
        id: 'sample-av',
        asset: { assetId: 'synthetic-av', sha256: '1'.repeat(64), byteLength: 1 },
        streams: [
          {
            id: 'picture',
            kind: 'video',
            timebase: time(1, 25),
            startPts: 0,
            endPts: 250,
            presentationOrigin: time(0),
          },
          {
            id: 'sound',
            kind: 'audio',
            sampleRate: 48000,
            sampleCount: 480000,
            presentationOrigin: time(0),
            sampleOrigin: time(0),
            validity: { start: time(0), end: time(10) },
          },
        ],
      },
      {
        id: 'sample-font',
        kind: 'font',
        fontProfile: 'noto-cjk-jp-2.004',
        weight: 'regular',
        asset: { assetId: 'synthetic-font', sha256: '2'.repeat(64), byteLength: 1 },
      },
    ],
    sequence: {
      id: 'sample-sequence',
      duration: time(10),
      frameRate: time(25),
      tracks: [
        { id: 'picture-track', kind: 'visual', enabled: true, locked: false },
        { id: 'sound-track', kind: 'audio', enabled: true, locked: false },
        { id: 'caption-track', kind: 'visual', enabled: true, locked: false },
        { id: 'locked-track', kind: 'visual', enabled: true, locked: true },
      ],
      clips: [
        {
          ...timing,
          id: 'sample-picture',
          kind: 'video',
          trackId: 'picture-track',
          sourceId: 'sample-av',
          streamId: 'picture',
          rate: time(1),
          linkGroupId: 'sample-pair',
        },
        {
          ...timing,
          id: 'sample-sound',
          kind: 'audio',
          trackId: 'sound-track',
          sourceId: 'sample-av',
          streamId: 'sound',
          gain: 1,
          fade: { start: time(0), end: time(2), in: time(0), out: time(0) },
          linkGroupId: 'sample-pair',
        },
        {
          ...timing,
          id: 'sample-caption',
          kind: 'caption',
          trackId: 'caption-track',
          sourceId: 'sample-font',
          rate: time(1),
          text: '共同編集のサンプル',
          style: {
            x: 0.05,
            y: 0.75,
            width: 0.9,
            height: 0.2,
            size: 0.08,
            color: '#ffffff',
            align: 'center',
          },
        },
        {
          ...timing,
          id: 'locked-caption',
          kind: 'caption',
          trackId: 'locked-track',
          sourceId: 'sample-font',
          rate: time(1),
          text: '固定した字幕',
          style: {
            x: 0.05,
            y: 0.05,
            width: 0.9,
            height: 0.1,
            size: 0.04,
            color: '#ffffff',
            align: 'center',
          },
        },
      ],
    },
  };
}

const isID = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const clipResource = (id: string) => `clip:${id}`;
const groupResource = (id: string) => `linked:${id}`;

/** Capture only the parts of the admitted project which timeline edits cannot replace. */
function pinnedTimelineValidator(project: VideoContentV3) {
  assertVideoContentV3(project);
  const { clips, ...sequence } = project.sequence;
  const sources = canonical(project.sources);
  const settings = canonical(sequence);
  const locked = new Set(sequence.tracks.filter((track) => track.locked).map((track) => track.id));
  const kinds = new Set(clips.map((clip) => clip.kind));
  const lockedClips = canonical(clips.filter((clip) => locked.has(clip.trackId)));
  // An Animation clip contains a full native snapshot. A split may reuse an admitted
  // snapshot, but a restore must never introduce a new source through its clip payload.
  const embeds = new Set(
    clips.flatMap((clip) => (clip.kind === 'animation' ? [canonical(clip.embed)] : [])),
  );
  return (value: unknown): value is VideoContentV3 => {
    try {
      assertVideoContentV3(value);
      const { clips: current, ...currentSettings } = value.sequence;
      return (
        canonical(value.sources) === sources &&
        canonical(currentSettings) === settings &&
        canonical(current.filter((clip) => locked.has(clip.trackId))) === lockedClips &&
        current.every(
          (clip) =>
            kinds.has(clip.kind) &&
            isID(clip.id) &&
            (!clip.linkGroupId || isID(clip.linkGroupId)) &&
            (clip.kind !== 'animation' || embeds.has(canonical(clip.embed))),
        )
      );
    } catch {
      return false;
    }
  };
}

function exact(value: Record<string, unknown>, ...fields: string[]) {
  return (
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key))
  );
}

function parseEdit(action: Action): SharedVideoEdit {
  const raw = action.payload.edit as Record<string, unknown> | undefined;
  if (!raw || !isID(raw.clipId) || action.target !== raw.clipId || !exact(action.payload, 'edit'))
    fail('schema-mismatch', 'Invalid Video clip operation');
  const clipId = raw.clipId;
  if (raw.type === 'move' && exact(raw, 'type', 'clipId', 'delta') && isTime(raw.delta))
    return { type: 'move', clipId, delta: raw.delta };
  if (
    raw.type === 'trim' &&
    exact(raw, 'type', 'clipId', 'start', 'end', 'independent') &&
    raw.independent === true &&
    isTime(raw.start) &&
    isTime(raw.end)
  )
    return { type: 'trim', clipId, start: raw.start, end: raw.end, independent: true };
  if (
    raw.type === 'split' &&
    exact(
      raw,
      'type',
      'clipId',
      'at',
      'rightIds',
      ...(Object.hasOwn(raw, 'rightLinkGroupId') ? ['rightLinkGroupId'] : []),
    ) &&
    isTime(raw.at) &&
    raw.rightIds &&
    typeof raw.rightIds === 'object' &&
    !Array.isArray(raw.rightIds) &&
    (raw.rightLinkGroupId === undefined || isID(raw.rightLinkGroupId))
  ) {
    const pairs = Object.entries(raw.rightIds);
    if (pairs.length && pairs.every(([left, right]) => isID(left) && isID(right)))
      return {
        type: 'split',
        clipId,
        at: raw.at,
        rightIds: Object.fromEntries(pairs),
        ...(raw.rightLinkGroupId ? { rightLinkGroupId: raw.rightLinkGroupId } : {}),
      };
  }
  if (
    raw.type === 'caption-text' &&
    exact(raw, 'type', 'clipId', 'text') &&
    typeof raw.text === 'string'
  )
    return { type: 'caption-text', clipId, text: raw.text };
  fail('schema-mismatch', 'Unsupported Video timeline operation');
}

export function videoTimelineAction(edit: SharedVideoEdit): Action {
  return { type: 'video.timeline', target: edit.clipId, payload: { edit } };
}

/** Assign stable split identities once, at submission time, for every linked member. */
export function splitVideoTimeline(
  content: VideoContentV3,
  selected: ClipV3,
  at: Time,
): SharedVideoEdit {
  const cohort = content.sequence.clips.filter(
    (clip) =>
      clip.id === selected.id ||
      (!!selected.linkGroupId && clip.linkGroupId === selected.linkGroupId),
  );
  return {
    type: 'split',
    clipId: selected.id,
    at,
    rightIds: Object.fromEntries(cohort.map((clip) => [clip.id, `clip-${crypto.randomUUID()}`])),
    ...(cohort.length > 1 ? { rightLinkGroupId: `group-${crypto.randomUUID()}` } : {}),
  };
}

type ClipChange = { id: string; value: ClipV3 | null };
function clipDelta(before: readonly ClipV3[], after: readonly ClipV3[]) {
  const old = new Map(before.map((clip) => [clip.id, clip]));
  const next = new Map(after.map((clip) => [clip.id, clip]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter((id) => canonical(old.get(id)) !== canonical(next.get(id)))
    .map((id) => ({ id, before: old.get(id), after: next.get(id) }));
}

function replaceClips(content: VideoContentV3, changes: readonly ClipChange[]): VideoContentV3 {
  const next = new Map(content.sequence.clips.map((clip) => [clip.id, clip]));
  for (const change of changes) {
    if (change.value) next.set(change.id, change.value);
    else next.delete(change.id);
  }
  return { ...content, sequence: { ...content.sequence, clips: [...next.values()] } };
}

function applyEdit(content: VideoContentV3, edit: SharedVideoEdit) {
  const clip = content.sequence.clips.find((item) => item.id === edit.clipId);
  if (!clip) fail('target-deleted', 'The selected clip no longer exists');
  if (edit.type === 'caption-text') {
    if (clip.kind !== 'caption') fail('invalid-operation', 'Select a caption');
    if (content.sequence.tracks.find((track) => track.id === clip.trackId)?.locked)
      fail('unauthorized', 'Caption track is locked');
    return replaceClips(content, [{ id: clip.id, value: { ...clip, text: edit.text } }]);
  }
  try {
    return videoCommandV3(edit).apply(content);
  } catch (error) {
    fail('invalid-operation', error instanceof Error ? error.message : String(error));
  }
}

/** Bind a timeline to the source declarations and track settings admitted by its Host. */
export function createVideoTimelineCodec(project: VideoContentV3): DomainCodec<VideoContentV3> {
  const validate = pinnedTimelineValidator(project);
  if (!validate(project)) fail('schema-mismatch', 'Unsupported native Video timeline');
  return {
    domain: 'video',
    validate,
    resource(content, key) {
      if (key.startsWith('clip:'))
        return content.sequence.clips.find((clip) => clip.id === key.slice(5));
      if (key.startsWith('linked:'))
        return content.sequence.clips
          .filter((clip) => clip.linkGroupId === key.slice(7))
          .map((clip) => clip.id)
          .sort();
    },
    validateAnchor: () => false,
    apply(content, action) {
      if (action.type === 'domain.restore') {
        const next = action.payload.content;
        if (!validate(next))
          fail(
            'invalid-operation',
            'Saved timeline uses different sources, track settings or locked clips',
          );
        return {
          content: copy(next),
          required: ['*'],
          touched: ['*'],
          targets: ['*'],
          inverse: [{ type: 'domain.restore', target: '*', payload: { content } }],
        };
      }
      const required = new Set<string>();
      let next: VideoContentV3;
      if (action.type === 'video.timeline') {
        const edit = parseEdit(action);
        const selected = content.sequence.clips.find((clip) => clip.id === edit.clipId);
        required.add(clipResource(edit.clipId));
        if (selected?.linkGroupId && (edit.type === 'move' || edit.type === 'split'))
          required.add(groupResource(selected.linkGroupId));
        next = applyEdit(content, edit);
      } else if (action.type === 'history.video-clips') {
        const changes = action.payload.clips as ClipChange[];
        if (
          !Array.isArray(changes) ||
          !changes.length ||
          changes.some(
            (change) =>
              !change ||
              !isID(change.id) ||
              (change.value !== null && change.value?.id !== change.id),
          )
        )
          fail('schema-mismatch', 'Invalid Video history');
        next = replaceClips(content, changes);
      } else fail('unsupported-operation', 'Unsupported Video action');
      if (!validate(next))
        fail('invalid-operation', 'Timeline exceeds the fixed sequence or uses unsupported inputs');
      const changes = clipDelta(content.sequence.clips, next.sequence.clips);
      if (!changes.length) fail('invalid-operation', 'No timeline change');
      const touched = new Set(changes.map((change) => clipResource(change.id)));
      const groups = new Set(
        changes.flatMap(({ before, after }) =>
          before?.linkGroupId === after?.linkGroupId
            ? []
            : [before?.linkGroupId, after?.linkGroupId],
        ),
      );
      for (const group of groups) if (group) touched.add(groupResource(group));
      for (const key of touched) required.add(key);
      return {
        content: copy(next),
        required: [...required],
        touched: [...touched],
        targets: changes.map(({ id }) => id),
        inverse: [
          {
            type: 'history.video-clips',
            target: '*',
            payload: {
              clips: changes.map(({ id, before }) => ({ id, value: before ?? null })),
            },
          },
        ],
      };
    },
  };
}

export const videoTimelineCodec = createVideoTimelineCodec(videoTimelineFixture());
