import { expect, it } from 'vitest';
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { audioGainAtV2, subtract, time, type VideoContentV2 } from '@editor-platform/video-core';
import { scan, memory } from '../io';
import { createProfileProject } from './project';
import { createPortableProjects } from './versioned';
import { createVersionedProject } from './v1';
import { v2Profile } from './v2';
import { v2Fixture, v0EmptyFixture } from './v2-fixture';
import { v1Fixture } from './v1-fixture';
import { createZip, type Entry } from './zip64';
const signal = () => new AbortController().signal;
async function archive(entries: Entry[]) {
  const chunks: Uint8Array[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return memory(Uint8Array.from(Buffer.concat(chunks)));
}
async function json(entry: Entry) {
  return JSON.parse(
    new TextDecoder().decode(await entry.reader.read(0n, Number(entry.size), signal())),
  );
}
async function entry(name: string, value: unknown) {
  const reader = memory(new TextEncoder().encode(canonicalJson(value)));
  return { name, reader, size: reader.size, ...(await scan(reader, signal())) };
}
async function manifest(entries: Entry[], mutate: (m: Record<string, unknown>) => void) {
  const value = await json(entries[0]);
  mutate(value);
  return [await entry('manifest.json', value), ...entries.slice(1)];
}
async function proveHashes(wire: ReturnType<typeof memory>) {
  const decoded = await createZip(scan).readZip(wire, signal());
  const m = await json(decoded[0]);
  let selectedHash: string | undefined;
  for (const e of decoded) {
    const actual = await scan(e.reader, signal());
    expect(actual.crc).toBe(e.crc);
    if (e.name !== 'manifest.json') expect(e.name.split('/')[1].split('.')[0]).toBe(actual.sha256);
    if (e.name.startsWith('native/')) {
      const v = await json(e);
      expect(v.contentHash).toBe(await contentHash(v.content));
      if (v.versionId === m.selectedVersionId) selectedHash = v.contentHash;
    }
  }
  expect(m.capture.contentHash).toBe(selectedHash);
  expect((await scan(wire, signal())).sha256).toMatch(/^[a-f0-9]{64}$/);
}
it.each([false, true])(
  'V2-01 selectedEmpty=%s: exact v2 native/history/plans and original bytes roundtrip',
  async (selectedEmpty) => {
    const p = await v2Fixture(scan, selectedEmpty);
    const before = structuredClone(p.versions);
    const wire = await archive(await createPortableProjects(scan).v2.prepareProject(p, signal()));
    const opened = await createPortableProjects(scan).open(wire, signal());
    expect(opened.kind).toBe('v2');
    expect(opened.project.versions).toEqual(before);
    expect(opened.project.plans).toEqual(p.plans);
    expect(opened.project.capture).toEqual(p.capture);
    for (const [hash, raw] of opened.project.originals) {
      expect((await scan(raw, signal())).sha256).toBe(hash);
      expect(raw.size).toBe(p.originals.get(hash)!.size);
    }
    expect(p.versions).toEqual(before);
    await expect(createVersionedProject(scan).open(wire, signal())).rejects.toThrow();
  },
);
it('V2-02 legacy writers/readers preserve exact v0/v1 archive bytes, content, and history', async () => {
  const legacy = createVersionedProject(scan),
    all = createPortableProjects(scan);
  for (const [kind, p] of [
    ['v0', await v0EmptyFixture()],
    ['v1', await v1Fixture(scan, true)],
  ] as const) {
    // Separate typed branches preserve each legacy contract without casting a mixed project.
    const e =
      kind === 'v0'
        ? await legacy.v0.prepareProject(p, signal())
        : await legacy.v1.prepareProject(p, signal());
    const wire = await archive(e),
      opened = await all.open(wire, signal());
    expect(opened.kind).toBe(kind);
    expect((await scan(wire, signal())).sha256).toBe(
      kind === 'v0'
        ? '8931aff5109c063640fd368f60ce1e4870aeaf2cb2c77daeadb0bd390863f1ad'
        : '434e18d36167e4ccd9d9ffb5c9b96e484da1ef1d5e6e928a6f9d8cc248b2896b',
    );
    expect(opened.project.versions).toEqual(p.versions);
    expect(opened.project.capture).toEqual(p.capture);
    const oldRead = await legacy.open(wire, signal());
    expect(opened.project.versions).toEqual(oldRead.project.versions);
    const rewritten =
      opened.kind === 'v0'
        ? await all.v0.prepareProject(opened.project, signal())
        : opened.kind === 'v1'
          ? await all.v1.prepareProject(opened.project, signal())
          : [];
    expect(await scan(await archive(rewritten), signal())).toEqual(await scan(wire, signal()));
  }
});
it.each([
  'unknown-format',
  'v1-label',
  'v1-plan',
  'unknown-profile',
  'extra-plan',
  'stereo-claim',
  'native-mismatch',
  'missing-retained-original',
])('V2-03 rejects %s after rebuilding manifest and ZIP checksums', async (fault) => {
  const p = await v2Fixture(scan, true);
  let entries = await createPortableProjects(scan).v2.prepareProject(p, signal());
  if (fault === 'missing-retained-original')
    entries = entries.filter((e) => !e.name.startsWith('originals/'));
  else
    entries = await manifest(entries, (m) => {
      const plans = m.plans as { plan: Record<string, unknown> }[];
      const audio = plans[1].plan;
      if (fault === 'unknown-format') m.format = 'video-file-zip64-candidate-v99';
      if (fault === 'v1-label') m.format = 'video-file-zip64-candidate-v1';
      if (fault === 'v1-plan') {
        delete audio.profile;
        audio.format = 'video-media-interpretation-v1';
      }
      if (fault === 'unknown-profile') audio.profile = 'aac-stereo-v2';
      if (fault === 'extra-plan') audio.extra = 1;
      const stream = (audio.streams as Record<string, unknown>[])[0];
      if (fault === 'stereo-claim') stream.channels = 2;
      if (fault === 'native-mismatch') stream.sampleCount = 89225;
    });
  const wire = await archive(entries);
  await proveHashes(wire);
  await expect(createPortableProjects(scan).open(wire, signal())).rejects.toThrow();
});
it.each(['selected', 'retained'] as const)(
  'V2-04 %s semantics rejected with every hash refreshed',
  async (part) => {
    for (const fault of ['unknown-native', 'mixed-v1', 'gain', 'fade', 'rational']) {
      const p = await v2Fixture(scan),
        entries = await createPortableProjects(scan).v2.prepareProject(p, signal());
      const previous = entries.filter((e) => e.name.startsWith('native/'))[
        part === 'selected' ? 1 : 0
      ];
      const v = (await json(previous)) as ArtifactVersion<VideoContentV2>;
      const clip = v.content.sequence.clips.find((c) => c.kind === 'audio')!;
      if (clip.kind !== 'audio') throw Error();
      if (fault === 'unknown-native')
        Object.assign(v.content, { schema: 'video-core-prototype-v99' });
      if (fault === 'mixed-v1') {
        Object.assign(v.content, { schema: 'video-core-prototype-v1' });
        for (const c of v.content.sequence.clips)
          if (c.kind === 'audio') {
            Reflect.deleteProperty(c, 'gain');
            Reflect.deleteProperty(c, 'fade');
          }
      }
      if (fault === 'gain') clip.gain = 1.01;
      if (fault === 'fade') clip.fade.in = time(1000);
      if (fault === 'rational') clip.sourceIn = { value: 2, timescale: 2 };
      v.contentHash = await contentHash(v.content);
      const replacement = await entry('', v);
      replacement.name = 'native/' + replacement.sha256 + '.json';
      entries[entries.indexOf(previous)] = replacement;
      const changed = await manifest(entries, (m) => {
        m.versions = (m.versions as string[]).map((n) =>
          n === previous.name ? replacement.name : n,
        );
        if (part === 'selected') (m.capture as { contentHash: string }).contentHash = v.contentHash;
      });
      const wire = await archive(changed);
      await proveHashes(wire);
      await expect(createPortableProjects(scan).open(wire, signal())).rejects.toThrow(
        fault === 'gain'
          ? 'Audio gain range'
          : fault === 'fade'
            ? 'Audio fade duration'
            : fault === 'rational'
              ? 'Invalid canonical time'
              : 'Unsupported video v2 schema',
      );
    }
  },
);
it('V2-05 valid high-denominator fade anchors survive archive and exact corrected evaluation', async () => {
  const p = await v2Fixture(scan);
  // Keep only independent audio and reconstruct a one-second stream/plan, without codec claims.
  const v = p.versions[0];
  v.parentVersionId = null;
  v.content.sources = v.content.sources.filter((s) => s.id === 'audio-only');
  v.content.sequence.clips = v.content.sequence.clips.filter((c) => c.id === 'audio-only:a');
  const stream = v.content.sources[0].streams[0],
    clip = v.content.sequence.clips[0];
  if (stream.kind !== 'audio' || clip.kind !== 'audio') throw Error();
  stream.presentationOrigin = time(0);
  stream.sampleCount = 44100;
  stream.validity.start = time(0);
  stream.validity.end = time(1);
  clip.start = time(0);
  clip.sourceIn = time(1, 100000003);
  clip.sourceOut = time(1, 2);
  clip.duration = subtract(clip.sourceOut, clip.sourceIn);
  clip.gain = 1;
  clip.fade = { start: time(1, 100000007), end: time(1), in: time(1, 2), out: time(0) };
  v.content.sequence.duration = clip.duration;
  p.plans = p.plans.filter((x) => x.sourceId === 'audio-only');
  const s = p.plans[0].plan.streams[0];
  if (s.kind !== 'audio') throw Error();
  s.mediaStart = time(0);
  s.mediaEnd = time(1);
  s.sampleCount = 44100;
  p.originals = new Map(
    [...p.originals].filter(([hash]) => hash === v.content.sources[0].asset.sha256),
  );
  v.contentHash = await contentHash(v.content);
  p.versions = [v];
  p.selectedVersionId = v.versionId;
  p.capture = { ...p.capture, contentHash: v.contentHash };
  const wire = await archive(
    await createProfileProject(scan, v2Profile).prepareProject(p, signal()),
  );
  const opened = await createPortableProjects(scan).open(wire, signal());
  expect(opened.project.versions).toEqual(p.versions);
  if (opened.kind !== 'v2') throw Error();
  const restored = opened.project.versions[0].content.sequence.clips[0];
  if (restored.kind !== 'audio') throw Error();
  expect(audioGainAtV2(restored, time(0))).toBe(Number(8n) / Number(10000001000000021n));
  expect(Number.isFinite(audioGainAtV2(restored, time(1, 48000)))).toBe(true);
});

it.each(['v0', 'v1', 'v2'] as const)(
  'rejects unsupported provenance at the %s writer before scanning or returning save entries',
  async (kind) => {
    const provenance = {
      source: 'imported',
      migration: {
        converter: 'video-v1-to-v2-1',
        sourceArtifactId: 'original-document',
        sourceBaseVersionId: 'original-version',
        sourceContentHash: 'a'.repeat(64),
        targetContentHash: 'b'.repeat(64),
        sourceSchema: 'video-core-prototype-v1',
        targetSchema: 'video-core-prototype-v2',
      },
    };
    let scans = 0;
    const all = createPortableProjects(async (...args) => {
      scans++;
      return scan(...args);
    });
    const prepare = async () => {
      if (kind === 'v0')
        return all.v0.prepareProject(
          Object.assign(await v0EmptyFixture(), { provenance }),
          signal(),
        );
      if (kind === 'v1')
        return all.v1.prepareProject(
          Object.assign(await v1Fixture(scan, true), { provenance }),
          signal(),
        );
      return all.v2.prepareProject(
        Object.assign(await v2Fixture(scan, true), { provenance }),
        signal(),
      );
    };
    await expect(prepare()).rejects.toThrow('Record fields');
    expect(scans).toBe(0);
  },
);
it('refuses provenance smuggled into an old manifest even with rebuilt ZIP checksums', async () => {
  const entries = await createPortableProjects(scan).v2.prepareProject(
    await v2Fixture(scan, true),
    signal(),
  );
  const wire = await archive(
    await manifest(entries, (m) => {
      m.provenance = { source: 'imported' };
    }),
  );
  await expect(createPortableProjects(scan).open(wire, signal())).rejects.toThrow('Record fields');
});
it.each([1, 22, 98])(
  'refuses a v2 archive whose final %s bytes were not saved',
  async (missing) => {
    const entries = await createPortableProjects(scan).v2.prepareProject(
      await v2Fixture(scan, true),
      signal(),
    );
    const wire = await archive(entries);
    const partial = memory(await wire.read(0n, Number(wire.size) - missing, signal()));
    await expect(createPortableProjects(scan).open(partial, signal())).rejects.toThrow();
  },
);
