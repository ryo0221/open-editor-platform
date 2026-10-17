import { expect, it } from 'vitest';
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import type { VideoContentV1 } from '@editor-platform/video-core';
import { scan, memory } from '../io';
import { createProject, createProfileProject } from './project';
import { createVersionedProject, v1Profile } from './v1';
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
async function alteredManifest(entries: Entry[], change: (m: Record<string, unknown>) => void) {
  const r = entries[0].reader;
  const m = JSON.parse(new TextDecoder().decode(await r.read(0n, Number(r.size), signal())));
  change(m);
  const reader = memory(new TextEncoder().encode(canonicalJson(m)));
  return [
    { name: 'manifest.json', reader, size: reader.size, ...(await scan(reader, signal())) },
    ...entries.slice(1),
  ];
}
it('v1 fractional endpoints and retained-only source/interpretation roundtrip without changing native hash/history', async () => {
  const original = await v1Fixture(scan, true);
  const e = await createProfileProject(scan, v1Profile).prepareProject(original, signal());
  const read = await createVersionedProject(scan).open(await archive(e), signal());
  expect(read.kind).toBe('v1');
  expect(read.project.versions).toEqual(original.versions);
  expect(read.project.capture).toEqual(original.capture);
  expect(read.project.plans).toEqual(original.plans);
  expect(read.project.originals.size).toBe(1);
  expect(original.versions[0].content.sequence.clips[1]).toMatchObject({
    sourceOut: { value: 42251, timescale: 600 },
  });
});
it('v0-specific API refuses v1 without relabeling or automatic conversion', async () => {
  const p = await v1Fixture(scan);
  const e = await createProfileProject(scan, v1Profile).prepareProject(p, signal());
  await expect(createProject(scan).openProject(await archive(e), signal())).rejects.toThrow(
    'Manifest profile',
  );
});
it.each([
  'unknown',
  'v0-label',
  'interpretation-format',
  'interpretation-native',
  'extra-plan-field',
  'missing-parent-original',
])('rejects %s even with rebuilt ZIP CRC/SHA entries', async (fault) => {
  const p = await v1Fixture(scan, true),
    e = await createProfileProject(scan, v1Profile).prepareProject(p, signal());
  let changed = e;
  if (fault === 'missing-parent-original')
    changed = e.filter((x) => !x.name.startsWith('originals/'));
  else
    changed = await alteredManifest(e, (m) => {
      if (fault === 'unknown') m.format = 'video-file-zip64-candidate-v99';
      else if (fault === 'v0-label') m.format = 'video-file-zip64-candidate-v0';
      else {
        const plans = m.plans as {
          plan: {
            format: string;
            streams: { presentationStart: { value: number; timescale: number } }[];
          };
        }[];
        if (fault === 'interpretation-format')
          plans[0].plan.format = 'video-media-interpretation-v99';
        if (fault === 'interpretation-native')
          plans[0].plan.streams[0].presentationStart = { value: 1, timescale: 25 };
        if (fault === 'extra-plan-field')
          Object.assign(plans[0].plan, { 'format,streams': 'collision' });
      }
    });
  await expect(
    createVersionedProject(scan).open(await archive(changed), signal()),
  ).rejects.toThrow();
});
it('mixed native versions are rejected before serialization, retaining caller history', async () => {
  const p = await v1Fixture(scan);
  const before = structuredClone(p.versions);
  Object.assign(p.versions[0].content, { schema: 'video-core-prototype-v0' });
  await expect(createProfileProject(scan, v1Profile).prepareProject(p, signal())).rejects.toThrow();
  expect(p.versions[1]).toEqual(before[1]);
});

it.each(['unknown-native', 'wrong-envelope', 'content-hash'])(
  'wire archive refuses %s in a retained parent despite correct ZIP checksums',
  async (fault) => {
    const p = await v1Fixture(scan, true);
    const entries = await createProfileProject(scan, v1Profile).prepareProject(p, signal());
    const index = entries.findIndex((e) => e.name.startsWith('native/'));
    const previous = entries[index];
    const value = JSON.parse(
      new TextDecoder().decode(await previous.reader.read(0n, Number(previous.size), signal())),
    );
    if (fault === 'unknown-native') value.content.schema = 'video-core-prototype-v99';
    if (fault === 'wrong-envelope') value.schemaVersion = 99;
    if (fault === 'content-hash') value.content.sequence.id = 'tampered';
    const reader = memory(new TextEncoder().encode(canonicalJson(value)));
    const digest = await scan(reader, signal());
    const replacement = {
      name: 'native/' + digest.sha256 + '.json',
      reader,
      size: reader.size,
      ...digest,
    };
    entries[index] = replacement;
    const changed = await alteredManifest(entries, (m) => {
      m.versions = (m.versions as string[]).map((n) =>
        n === previous.name ? replacement.name : n,
      );
    });
    await expect(
      createVersionedProject(scan).open(await archive(changed), signal()),
    ).rejects.toThrow();
  },
);

it.each([
  { part: 'selected', fault: 'rational', reason: 'Invalid canonical time' },
  { part: 'retained', fault: 'rational', reason: 'Invalid canonical time' },
  { part: 'selected', fault: 'window', reason: 'Invalid audio presentation window' },
  { part: 'retained', fault: 'window', reason: 'Invalid audio presentation window' },
])(
  'rejects $part $fault semantics with fresh native/capture/ZIP hashes',
  async ({ part, fault, reason }) => {
    const p = await v1Fixture(scan);
    const entries = await createProfileProject(scan, v1Profile).prepareProject(p, signal());
    const nativeEntries = entries.filter((e) => e.name.startsWith('native/'));
    const previous = nativeEntries[part === 'selected' ? 1 : 0];
    const value = JSON.parse(
      new TextDecoder().decode(await previous.reader.read(0n, Number(previous.size), signal())),
    ) as ArtifactVersion<VideoContentV1>;
    const audio = value.content.sequence.clips.find((c) => c.kind === 'audio')!;
    if (fault === 'rational')
      audio.sourceIn = { value: 2, timescale: 2 }; // Safe but deliberately noncanonical.
    else audio.sourceOut = { value: 71, timescale: 1 }; // Outside original validity / duration.
    value.contentHash = await contentHash(value.content);
    expect(value.contentHash).not.toBe(p.versions[part === 'selected' ? 1 : 0].contentHash);
    const reader = memory(new TextEncoder().encode(canonicalJson(value)));
    const digest = await scan(reader, signal());
    const replacement = {
      name: 'native/' + digest.sha256 + '.json',
      reader,
      size: reader.size,
      ...digest,
    };
    entries[entries.indexOf(previous)] = replacement;
    const changed = await alteredManifest(entries, (m) => {
      m.versions = (m.versions as string[]).map((n) =>
        n === previous.name ? replacement.name : n,
      );
      if (part === 'selected')
        (m.capture as { contentHash: string }).contentHash = value.contentHash;
    });
    const wire = await archive(changed);
    // Independently prove every outer checksum and every native contentHash is current.
    const decoded = await createZip(scan).readZip(wire, signal());
    for (const entry of decoded) {
      const actual = await scan(entry.reader, signal());
      expect(actual.crc).toBe(entry.crc);
      if (entry.name !== 'manifest.json')
        expect(entry.name.split('/')[1].split('.')[0]).toBe(actual.sha256);
      if (entry.name.startsWith('native/')) {
        const native = JSON.parse(
          new TextDecoder().decode(await entry.reader.read(0n, Number(entry.size), signal())),
        );
        expect(native.contentHash).toBe(await contentHash(native.content));
      }
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(await decoded[0].reader.read(0n, Number(decoded[0].size), signal())),
    );
    expect(manifest.capture.contentHash).toBe(
      part === 'selected' ? value.contentHash : p.capture.contentHash,
    );
    await expect(createVersionedProject(scan).open(wire, signal())).rejects.toThrow(
      new Error(reason),
    );
  },
);
