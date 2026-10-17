/** Node-only synthetic archive generation; no browser/backend service. */
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import type { VideoContent } from '@editor-platform/video-core';
import { prepareImportSet, type ImportSet } from '../../host-media/import';
import { CHUNK, fileReader, memory, scan, type Reader } from '../io';
import { prepareProject, openProject, type Project } from '../project';
import { writeZip, type Entry } from '../zip64';
const signal = () => new AbortController().signal;
const empty = (): VideoContent => ({
  schema: 'video-core-prototype-v0',
  sources: [],
  sequence: {
    id: 's',
    duration: { value: 0, timescale: 1 },
    frameRate: { value: 25, timescale: 1 },
    clips: [],
    tracks: [{ id: 'visual', kind: 'visual', enabled: true, locked: false }],
  },
});
const plan: ImportSet = {
  streams: [
    {
      id: 'video',
      kind: 'video',
      destination: 'visual',
      mediaStart: { value: 0, timescale: 1 },
      mediaEnd: { value: 1, timescale: 1 },
      presentationStart: { value: 0, timescale: 1 },
    },
  ],
};
async function version(
  content: VideoContent,
  versionId: string,
  parentVersionId: string | null,
): Promise<ArtifactVersion<VideoContent>> {
  return {
    artifactId: 'synthetic',
    versionId,
    parentVersionId,
    schemaVersion: 1,
    content,
    contentHash: await contentHash(content),
    createdAt: '2026-10-13',
    createdBy: null,
    reason: null,
  };
}
async function project(original: Reader): Promise<Project> {
  const hash = await scan(original, signal());
  const content = prepareImportSet(
    empty(),
    plan,
    { assetId: 'original', sha256: hash.sha256, byteLength: Number(original.size) },
    'source',
  );
  const versions = [
    await version(content, 'parent', null),
    await version(empty(), 'selected', 'parent'),
  ];
  return {
    operationId: 'archive',
    capture: {
      scope: { artifactId: 'synthetic', sessionId: 'session', generation: 'g1' },
      revision: { kind: 'local-draft', sessionId: 'session', sequence: 1 },
      contentHash: versions[1].contentHash,
    },
    selectedVersionId: 'selected',
    versions,
    plans: [{ sourceId: 'source', plan }],
    originals: new Map([[hash.sha256, original]]),
  };
}
async function jsonEntry(name: string, value: unknown): Promise<Entry> {
  const reader = memory(new TextEncoder().encode(canonicalJson(value)));
  return { name, reader, size: reader.size, ...(await scan(reader, signal())) };
}
const decode = async (e: Entry) =>
  JSON.parse(new TextDecoder().decode(await e.reader.read(0n, Number(e.size), signal())));
async function zip(path: string, entries: Entry[]) {
  const h = await open(path, 'wx');
  try {
    await writeZip(
      entries,
      {
        async write(bytes) {
          let at = 0;
          while (at < bytes.length) {
            const n = await h.write(bytes, at, bytes.length - at);
            if (!n.bytesWritten) throw Error('Short fixture write');
            at += n.bytesWritten;
          }
        },
      },
      signal(),
    );
  } finally {
    await h.close();
  }
}
export async function generate(directory: string) {
  const originalPath = join(directory, 'source.bin'),
    handle = await open(originalPath, 'wx');
  try {
    for (let i = 0; i < 640; i++) await handle.write(new Uint8Array(CHUNK).fill(90));
  } finally {
    await handle.close();
  }
  const original = await fileReader(originalPath),
    records: Record<string, unknown> = {};
  try {
    const p = await project(original),
      path = join(directory, 'large.zip');
    await zip(path, await prepareProject(p, signal()));
    const r = await fileReader(path);
    try {
      records.large = {
        bytes: Number(r.size),
        sha256: (await scan(r, signal())).sha256,
        operationId: p.operationId,
        capture: p.capture,
        versions: p.versions,
        originalHash: [...p.originals.keys()][0],
      };
      await openProject(r, signal());
    } finally {
      await r.close();
    }
  } finally {
    await original.close();
  }
  const small = await project(memory(new Uint8Array([1, 2, 3, 4])));
  const variants = [
    'valid',
    'comma-key',
    'session-mismatch',
    'missing-original',
    'missing-parent',
    'cycle',
    'native-hash',
    'interpretation',
    'unknown-schema',
  ];
  for (const kind of variants) {
    let entries = await prepareProject(small, signal());
    const manifest = await decode(entries[0]);
    if (kind === 'comma-key')
      manifest.capture.scope = { artifactId: 'synthetic', 'generation,sessionId': 'g' };
    if (kind === 'session-mismatch') manifest.capture.revision.sessionId = 'foreign';
    if (kind === 'missing-original')
      entries = entries.filter((e) => !e.name.startsWith('originals/'));
    if (['missing-parent', 'cycle', 'native-hash', 'unknown-schema'].includes(kind)) {
      const native = await decode(entries[1]);
      if (kind === 'missing-parent') native.parentVersionId = 'absent';
      if (kind === 'cycle') native.parentVersionId = 'parent';
      if (kind === 'native-hash') native.contentHash = '0'.repeat(64);
      if (kind === 'unknown-schema') native.schemaVersion = 9;
      const e = await jsonEntry('', native);
      e.name = `native/${e.sha256}.json`;
      entries[1] = e;
      manifest.versions[0] = e.name;
    }
    if (kind === 'interpretation') manifest.plans[0].plan.streams[0].mediaEnd.value = 2;
    entries[0] = await jsonEntry('manifest.json', manifest);
    const path = join(directory, kind + '.zip');
    await zip(path, entries);
    const r = await fileReader(path);
    try {
      let reason = '';
      try {
        await openProject(r, signal());
      } catch (e) {
        reason = String(e);
      }
      if ((kind === 'valid') !== !reason) throw Error(`Unexpected Node verdict ${kind}:${reason}`);
      records[kind] = {
        bytes: Number(r.size),
        sha256: (await scan(r, signal())).sha256,
        nodeReason: reason,
      };
    } finally {
      await r.close();
    }
  }
  await writeFile(join(directory, 'fixtures.json'), JSON.stringify(records, null, 2), {
    flag: 'wx',
  });
  return records;
}
