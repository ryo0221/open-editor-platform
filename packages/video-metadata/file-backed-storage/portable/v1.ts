/** Explicit private profile dispatch. No migration or relabeling of v0 native content. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { assertVideoContentV1, type VideoContentV1 } from '@editor-platform/video-core';
import { prepareImportSetV1, type ImportSetV1 } from '../../host-media/file-source/import-v1';
import { createProject, createProfileProject, type ProjectProfile } from './project';
import { need, read, type Scanner, type Reader } from './io';
import { createZip } from './zip64';
function fields(value: unknown, keys: string[]) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Interpretation record');
  const actual = Object.keys(value).sort(),
    expected = keys.slice().sort();
  need(
    actual.length === expected.length && actual.every((k, i) => k === expected[i]),
    'Interpretation exact fields',
  );
}
export const v1Profile: ProjectProfile<VideoContentV1, ImportSetV1> = {
  format: 'video-file-zip64-candidate-v1',
  assertContent: assertVideoContentV1,
  validatePlan(plan) {
    fields(plan, ['format', 'streams']);
    need(
      plan.format === 'video-media-interpretation-v1' &&
        Array.isArray(plan.streams) &&
        plan.streams.length >= 1 &&
        plan.streams.length <= 2,
      'Interpretation v1',
    );
    for (const s of plan.streams) {
      need(s.kind === 'audio' || s.kind === 'video', 'Stream kind');
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
    const empty: VideoContentV1 = {
      schema: 'video-core-prototype-v1',
      sources: [],
      sequence: {
        id: 'verify',
        duration: { value: 0, timescale: 1 },
        frameRate: { value: 25, timescale: 1 },
        clips: [],
        tracks: plan.streams.map((s) => ({
          id: s.destination,
          kind: s.kind === 'video' ? 'visual' : 'audio',
          enabled: true,
          locked: false,
        })),
      },
    };
    const verified = prepareImportSetV1(empty, plan, source.asset, source.id);
    need(
      canonicalJson(verified.sources[0]) === canonicalJson(source),
      'Interpretation/native mismatch',
    );
  },
};
export function createVersionedProject(scan: Scanner) {
  const v0 = createProject(scan),
    v1 = createProfileProject(scan, v1Profile);
  return {
    v0,
    v1,
    async open(reader: Reader, signal: AbortSignal) {
      const entries = await createZip(scan).readZip(reader, signal);
      need(entries[0]?.name === 'manifest.json' && entries[0].size <= 65536n, 'Manifest budget');
      const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await read(entries[0].reader, 0n, Number(entries[0].size), signal),
        ),
      );
      need(raw && typeof raw === 'object' && 'format' in raw, 'Manifest profile');
      // Each branch repeats canonical/closure/hash validation using the one shared engine.
      if (raw.format === 'video-file-zip64-candidate-v0')
        return { kind: 'v0' as const, project: await v0.openProject(reader, signal) };
      if (raw.format === v1Profile.format)
        return { kind: 'v1' as const, project: await v1.openProject(reader, signal) };
      throw Error('Unsupported portable profile');
    },
  };
}
