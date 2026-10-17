import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  open,
  readFile,
  rm,
  rename,
  writeFile,
  copyFile,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { type VideoContent } from '@editor-platform/video-core';
import { prepareImportSet, type ImportSet } from '../host-media/import';
import { CHUNK, MAX_ARCHIVE, fileReader, memory, scan, type Reader } from './io';
import { openProject, prepareProject, type Project } from './project';
import { FileTarget } from './target';
import { readZip, writeZip, type Entry } from './zip64';
const signal = () => new AbortController().signal;
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir() {
  const d = await mkdtemp(join(tmpdir(), 'video-file-'));
  dirs.push(d);
  return d;
}
const empty = (): VideoContent => ({
  schema: 'video-core-prototype-v0',
  sources: [],
  sequence: {
    id: 'sequence',
    duration: { value: 0, timescale: 1 },
    frameRate: { value: 25, timescale: 1 },
    tracks: [{ id: 'visual', kind: 'visual', locked: false, enabled: true }],
    clips: [],
  },
});
const plan = (): ImportSet => ({
  streams: [
    {
      id: 'v',
      kind: 'video',
      destination: 'visual',
      mediaStart: { value: 0, timescale: 1 },
      mediaEnd: { value: 1, timescale: 1 },
      presentationStart: { value: 0, timescale: 1 },
    },
  ],
});
async function version(
  content: VideoContent,
  id: string,
  parentVersionId: string | null,
): Promise<ArtifactVersion<VideoContent>> {
  return {
    artifactId: 'video',
    versionId: id,
    parentVersionId,
    schemaVersion: 1,
    content,
    contentHash: await contentHash(content),
    createdAt: '2026-10-13T00:00:00Z',
    createdBy: 'synthetic',
    reason: 'fixture',
  };
}
async function fixture(original = memory(new Uint8Array([1, 2, 3, 4]))): Promise<Project> {
  const digest = await scan(original, signal());
  const content = prepareImportSet(
    empty(),
    plan(),
    { assetId: 'original', sha256: digest.sha256, byteLength: Number(original.size) },
    'source',
  );
  const v = await version(content, 'v1', null);
  return {
    operationId: 'save1',
    capture: {
      scope: { artifactId: 'video', sessionId: 'session', generation: 'g1' },
      revision: { kind: 'local-draft', sessionId: 'session', sequence: 1 },
      contentHash: v.contentHash,
    },
    selectedVersionId: v.versionId,
    versions: [v],
    plans: [{ sourceId: 'source', plan: plan() }],
    originals: new Map([[digest.sha256, original]]),
  };
}
async function zip(entries: Entry[]) {
  const parts: Uint8Array[] = [];
  await writeZip(
    entries,
    {
      async write(b) {
        parts.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return Buffer.concat(parts); // Small malformed fixtures only; large fixture below is file-only.
}
async function small() {
  return zip(await prepareProject(await fixture(), signal()));
}
function offsets(b: Buffer) {
  const start = Number(b.readBigUInt64LE(b.length - 50));
  const nameLength = b.readUInt16LE(start + 28);
  return { start, nameLength, extra: start + 46 + nameLength };
}
it('F01 >32MiB file-only ZIP64 reconstructs an empty Host with retained-only original closure', async () => {
  const d = await dir(),
    originalPath = join(d, 'original.bin'),
    destination = join(d, 'project.zip');
  const handle = await open(originalPath, 'wx');
  const chunk = Buffer.alloc(CHUNK, 0x5a);
  for (let n = 0; n < 640; n++) await handle.write(chunk); // 40 MiB actual bytes, no sparse file.
  await handle.close();
  const original = await fileReader(originalPath);
  let largestRead = 0;
  const bounded: Reader = {
    size: original.size,
    read: async (at, length, abort) => {
      largestRead = Math.max(largestRead, length);
      expect(length).toBeLessThanOrEqual(CHUNK);
      return original.read(at, length, abort);
    },
  };
  const p = await fixture(bounded);
  const child = await version(empty(), 'v2', 'v1');
  p.versions.push(child);
  p.selectedVersionId = 'v2';
  p.capture = { ...p.capture, contentHash: child.contentHash };
  const target = new FileTarget(destination, MAX_ARCHIVE * 2n);
  const result = await target.save(p, signal());
  expect(result.state).toBe('saved');
  expect(largestRead).toBe(CHUNK);
  await original.close();
  await rm(originalPath); // Empty Host: only the portable file remains.
  const archived = await fileReader(destination);
  try {
    expect(archived.size).toBeGreaterThan(32n * 1024n ** 2n);
    const restored = await openProject(archived, signal());
    expect(restored.versions).toEqual(p.versions);
    expect(restored.selectedVersionId).toBe('v2');
    expect(restored.plans).toEqual(p.plans);
    expect([...restored.originals.keys()]).toEqual([...p.originals.keys()]);
    expect((await scan([...restored.originals.values()][0], signal())).sha256).toBe(
      [...p.originals.keys()][0],
    );
    if (result.state === 'saved')
      expect((await scan(archived, signal())).sha256).toBe(result.receipt.sha256);
  } finally {
    await archived.close();
  }
  // Independent standard-library ZIP reader checks STORE/CRC/member lengths in bounded reads.
  const evidence = execFileSync(
    'python3',
    [
      '-c',
      'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert all(i.compress_type==0 for i in z.infolist())\n for i in z.infolist():\n  with z.open(i) as f:\n   while f.read(65536): pass\n print(len(z.infolist()))',
      destination,
    ],
    { encoding: 'utf8' },
  );
  expect(evidence.trim()).toBe('4');
});
it.each([
  'tamper',
  'missing',
  'path',
  'offset',
  'overlap',
  'descriptor',
  'symlink',
  'extra',
  'trailing',
  'footer',
  'size',
])('F02 untrusted %s archive rejected', async (kind) => {
  let b = await small();
  const { start, extra } = offsets(b);
  if (kind === 'tamper') b[50 + b.readUInt16LE(26)] ^= 1;
  if (kind === 'missing') b = b.subarray(0, b.length - 1);
  if (kind === 'path') b.write('../nifest.json', start + 46, 'ascii');
  if (kind === 'offset' || kind === 'overlap')
    b.writeBigUInt64LE(kind === 'offset' ? 2n ** 63n : 1n, extra + 20);
  if (kind === 'descriptor') b.writeUInt16LE(0x808, start + 8);
  if (kind === 'symlink') b.writeUInt32LE(0xa1800000, start + 38);
  if (kind === 'extra') b.writeUInt16LE(2, extra);
  if (kind === 'trailing') b = Buffer.concat([b, Buffer.from([0])]);
  if (kind === 'footer') b.writeUInt32LE(2, b.length - 26);
  if (kind === 'size') b.writeBigUInt64LE(2n ** 63n, extra + 4);
  await expect(openProject(memory(b), signal())).rejects.toThrow();
});
it('F03 duplicate local and central paths rejected even when both headers agree', async () => {
  const p = await fixture();
  p.versions.push(await version(empty(), 'v2', 'v1'));
  const b = await zip(await prepareProject(p, signal()));
  const { start } = offsets(b);
  let at = start;
  const records: { at: number; name: Buffer; local: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const length = b.readUInt16LE(at + 28);
    records.push({
      at,
      name: Buffer.from(b.subarray(at + 46, at + 46 + length)),
      local: Number(b.readBigUInt64LE(at + 46 + length + 20)),
    });
    at += 46 + length + 28;
  }
  expect(records[1].name.length).toBe(records[2].name.length);
  records[1].name.copy(b, records[2].at + 46);
  records[1].name.copy(b, records[2].local + 30);
  await expect(openProject(memory(b), signal())).rejects.toThrow('Path/duplicate');
  const entries = await prepareProject(await fixture(), signal());
  await expect(zip([entries[0], entries[0]])).rejects.toThrow('duplicate');
});
it.each([
  'missing-original',
  'extra-original',
  'missing-plan',
  'missing-parent',
  'cycle',
  'native-hash',
  'capture',
  'unknown-schema',
])('F04 independently derived closure refuses %s', async (kind) => {
  const p = await fixture();
  if (kind === 'missing-original') p.originals.clear();
  if (kind === 'extra-original') p.originals.set('a'.repeat(64), memory(new Uint8Array([2])));
  if (kind === 'missing-plan') p.plans = [];
  if (kind === 'missing-parent') p.versions[0].parentVersionId = 'absent';
  if (kind === 'cycle') p.versions[0].parentVersionId = 'v1';
  if (kind === 'native-hash') p.versions[0].contentHash = '0'.repeat(64);
  if (kind === 'capture') p.capture = { ...p.capture, contentHash: '0'.repeat(64) };
  if (kind === 'unknown-schema') p.versions[0].schemaVersion = 9;
  await expect(prepareProject(p, signal())).rejects.toThrow();
});
it('F05 quota and cancellation preserve previous complete file; subsequent operation succeeds', async () => {
  const d = await dir(),
    destination = join(d, 'saved.zip'),
    p = await fixture();
  const target = new FileTarget(destination, MAX_ARCHIVE);
  expect((await target.save(p, signal())).state).toBe('saved');
  const before = await readFile(destination),
    size = (await stat(destination)).size;
  p.operationId = 'quota';
  const smallTarget = new FileTarget(destination, BigInt(size * 2 - 1));
  expect((await smallTarget.save(p, signal())).state).toBe('not-written');
  expect(await readFile(destination)).toEqual(before);
  const abort = new AbortController();
  let reads = 0;
  const [id, reader] = [...p.originals][0];
  p.originals.set(id, {
    size: reader.size,
    async read(at, length, s) {
      if (++reads === 2) abort.abort();
      return reader.read(at, length, s);
    },
  });
  p.operationId = 'cancel';
  expect((await target.save(p, abort.signal)).state).toBe('not-written');
  expect(reads).toBe(2);
  expect(await readFile(destination)).toEqual(before);
  p.originals.set(id, reader);
  p.operationId = 'retry';
  expect((await target.save(p, signal())).state).toBe('saved');
});
it('F06 source changes between passes refuse before commit', async () => {
  const d = await dir(),
    p = await fixture();
  let reads = 0;
  const [id, r] = [...p.originals][0];
  p.originals.set(id, {
    size: r.size,
    async read(at, n, s) {
      const b = await r.read(at, n, s);
      if (++reads > 1) b[0] ^= 1;
      return b;
    },
  });
  expect((await new FileTarget(join(d, 'target'), MAX_ARCHIVE).save(p, signal())).state).toBe(
    'not-written',
  );
});
it('F07 lost commit acknowledgement locks saves; correlated readback settles once, next save stays newest', async () => {
  const d = await dir(),
    destination = join(d, 'saved.zip'),
    p = await fixture();
  let lose = true;
  const target = new FileTarget(destination, MAX_ARCHIVE, async (a, b) => {
    await rename(a, b);
    if (lose) {
      lose = false;
      throw Error('lost ack');
    }
  });
  const outcome = await target.save(p, signal());
  expect(outcome.state).toBe('unknown');
  const next = { ...p, operationId: 'save2' };
  await expect(target.save(next, signal())).rejects.toThrow('Busy');
  const first = target.reconcile('save1'),
    second = target.reconcile('save1');
  expect(first).toBe(second);
  expect((await first).state).toBe('saved');
  expect((await target.save(next, signal())).state).toBe('saved');
  expect((await second).state).toBe('saved');
  const r = await fileReader(destination);
  try {
    expect((await openProject(r, signal())).operationId).toBe('save2');
  } finally {
    await r.close();
  }
});
it('F08 missing/foreign/tampered destination after attempted commit remains unknown', async () => {
  const d = await dir(),
    destination = join(d, 'saved.zip'),
    p = await fixture();
  const target = new FileTarget(destination, MAX_ARCHIVE, async () => {
    throw Error('unobservable failure');
  });
  expect((await target.save(p, signal())).state).toBe('unknown');
  expect((await target.reconcile('save1')).state).toBe('unknown');
  const other = join(d, 'other');
  expect(
    (await new FileTarget(other, MAX_ARCHIVE).save({ ...p, operationId: 'foreign' }, signal()))
      .state,
  ).toBe('saved');
  await copyFile(other, destination);
  expect((await target.reconcile('save1')).state).toBe('unknown');
  await writeFile(destination, Buffer.from('tampered'));
  expect((await target.reconcile('save1')).state).toBe('unknown');
  await expect(target.save({ ...p, operationId: 'new' }, signal())).rejects.toThrow('Busy');
});
it('F09 streamed reader checks range and metadata budgets before payload allocation', async () => {
  const b = await small();
  const entries = await readZip(memory(b), signal());
  expect(entries).toHaveLength(3);
  await expect(
    openProject(
      {
        size: MAX_ARCHIVE + 1n,
        read: async () => {
          throw Error('must not read');
        },
      },
      signal(),
    ),
  ).rejects.toThrow('Archive budget');
  const p = await fixture();
  p.versions[0].reason = 'x'.repeat(65537);
  await expect(prepareProject(p, signal())).rejects.toThrow('Metadata');
});

async function jsonEntry(name: string, value: unknown): Promise<Entry> {
  const r = memory(new TextEncoder().encode(canonicalJson(value)));
  return { name, reader: r, size: r.size, ...(await scan(r, signal())) };
}
it('F10 reader rejects missing/extra closure even with internally consistent ZIP hashes', async () => {
  const entries = await prepareProject(await fixture(), signal());
  await expect(openProject(memory(await zip(entries.slice(0, -1))), signal())).rejects.toThrow(
    'Missing original',
  );
  const r = memory(new Uint8Array([99]));
  const digest = await scan(r, signal());
  const extra: Entry = {
    name: `originals/${digest.sha256}.bin`,
    reader: r,
    size: r.size,
    ...digest,
  };
  await expect(openProject(memory(await zip([...entries, extra])), signal())).rejects.toThrow(
    'Unexpected closure',
  );
});
it('F11 reader verifies canonical native hash independently of exact-entry SHA and CRC', async () => {
  const entries = await prepareProject(await fixture(), signal());
  const decode = async (e: Entry) =>
    JSON.parse(new TextDecoder().decode(await e.reader.read(0n, Number(e.size), signal())));
  const native = await decode(entries[1]);
  native.contentHash = '0'.repeat(64);
  const changed = await jsonEntry(entries[1].name, native);
  changed.name = `native/${changed.sha256}.json`;
  entries[1] = changed;
  const manifest = await decode(entries[0]);
  manifest.versions = [changed.name];
  entries[0] = await jsonEntry('manifest.json', manifest);
  await expect(openProject(memory(await zip(entries)), signal())).rejects.toThrow(
    'Native envelope/hash',
  );
});
it('F12 malformed JSON depth and record count refuse before original read', async () => {
  const p = await fixture();
  p.versions = Array.from({ length: 9 }, () => p.versions[0]);
  await expect(prepareProject(p, signal())).rejects.toThrow('Project bounds');
  let deep: unknown = null;
  for (let i = 0; i < 25; i++) deep = { x: deep };
  const entries = await prepareProject(await fixture(), signal());
  entries[0] = await jsonEntry('manifest.json', deep);
  await expect(openProject(memory(await zip(entries)), signal())).rejects.toThrow('JSON depth');
});

it('F13 actual staged-file tampering fails readback before publish and preserves previous file', async () => {
  const d = await dir(),
    destination = join(d, 'complete.zip'),
    p = await fixture();
  expect((await new FileTarget(destination, MAX_ARCHIVE).save(p, signal())).state).toBe('saved');
  const before = await readFile(destination);
  let reads = 0,
    publishes = 0;
  const [id, original] = [...p.originals][0];
  p.originals.set(id, {
    size: original.size,
    async read(at, length, abort) {
      if (++reads === 2) {
        const stages = (await readdir(d)).filter((n) => n.startsWith('.video-stage-'));
        expect(stages).toHaveLength(1);
        const stage = await open(join(d, stages[0]), 'r+');
        try {
          await stage.write(Buffer.from([0]), 0, 1, 0);
        } finally {
          await stage.close();
        }
      }
      return original.read(at, length, abort);
    },
  });
  p.operationId = 'corrupt-stage';
  const target = new FileTarget(destination, MAX_ARCHIVE, async () => {
    publishes++;
  });
  const outcome = await target.save(p, signal());
  expect(outcome.state).toBe('not-written');
  expect(publishes).toBe(0);
  expect(await readFile(destination)).toEqual(before);
  expect((await readdir(d)).filter((n) => n.startsWith('.video-stage-'))).toEqual([]);
});
