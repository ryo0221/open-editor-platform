/** Explicit private v2 metadata profile. Original codec admission remains Host-owned. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { assertVideoContentV2, time, type VideoContentV2 } from '@editor-platform/video-core';
import { prepareAvImportV2, type MediaImportSetV2 } from '../../host-media/m2/media-profile-v2';
import { prepareAudioImportV2 } from '../../host-media/m2/audio-import-v2';
import type { ProjectProfile } from './project';
import { need } from './io';
function fields(value: unknown, expected: string[]) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'V2 interpretation record');
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  need(
    keys.length === wanted.length && keys.every((k, i) => k === wanted[i]),
    'V2 interpretation exact fields',
  );
}
export const v2Profile: ProjectProfile<VideoContentV2, MediaImportSetV2> = {
  format: 'video-file-zip64-candidate-v2',
  assertContent: assertVideoContentV2,
  validatePlan(plan) {
    fields(plan, ['format', 'profile', 'streams']);
    need(
      plan.format === 'video-media-interpretation-v2' &&
        (plan.profile === 'av-sdr-v2' || plan.profile === 'aac-mono-v2') &&
        Array.isArray(plan.streams) &&
        plan.streams.length >= 1 &&
        plan.streams.length <= 2,
      'V2 interpretation profile',
    );
    need(
      plan.profile !== 'aac-mono-v2' ||
        (plan.streams.length === 1 && plan.streams[0]?.kind === 'audio'),
      'V2 audio-only interpretation',
    );
    for (const s of plan.streams) {
      need(s && (s.kind === 'video' || s.kind === 'audio'), 'V2 interpretation stream');
      fields(s, [
        'id',
        'kind',
        'destination',
        'mediaStart',
        'mediaEnd',
        'presentationStart',
        ...(s.kind === 'audio' ? ['sampleRate', 'sampleCount', 'sampleOrigin'] : []),
      ]);
      for (const t of [
        s.mediaStart,
        s.mediaEnd,
        s.presentationStart,
        ...(s.kind === 'audio' ? [s.sampleOrigin] : []),
      ])
        fields(t, ['value', 'timescale']);
    }
  },
  validateSource(source, plan) {
    // Reconstruct source interpretation through the exact corrected Video-owned pure import port.
    // This does not probe/decode original bytes or infer mono from a hash.
    const empty: VideoContentV2 = {
      schema: 'video-core-prototype-v2',
      sources: [],
      sequence: {
        id: 'verify',
        duration: time(0),
        frameRate: time(25),
        clips: [],
        tracks: plan.streams.map((s) => ({
          id: s.destination,
          kind: s.kind === 'video' ? 'visual' : 'audio',
          enabled: true,
          locked: false,
        })),
      },
    };
    const verified =
      plan.profile === 'av-sdr-v2'
        ? prepareAvImportV2(empty, plan, source.asset, source.id)
        : prepareAudioImportV2(empty, plan, source.asset, source.id, time(0));
    need(
      canonicalJson(verified.sources[0]) === canonicalJson(source),
      'V2 interpretation/native mismatch',
    );
  },
};
