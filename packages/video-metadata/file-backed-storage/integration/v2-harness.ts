/** Small generated metadata fixture; real private Host/SaveCoordinator/OPFS, no codec claim. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { videoCommandV2 } from '@editor-platform/video-core';
import { mountV2Host, type PersistenceV2 } from '../../host-media/m2/host-v2';
import { createPersistenceFactoryV2 } from './persistence-v2';
import { createPersistenceFactoryV1 } from './persistence-v1';
import { emptyV1Fixture, v1Fixture } from '../portable/v1-fixture';
import { emptyV2Fixture, v2Fixture, v0EmptyFixture } from '../portable/v2-fixture';
import { createPortableProjects } from '../portable/versioned';
import { createZip, type Entry } from '../portable/zip64';
import { createScanner, type DigestFactory } from '../portable/io';
import { openPortableFile } from '../browser-verifier/external-file';
import { blobReader } from '../browser-verifier/adapter';
import { TotalCapacity } from './capacity';
const digest: DigestFactory = () => {
  const h = sha256.create();
  return {
    update: (b) => {
      h.update(b);
    },
    hex: () => bytesToHex(h.digest()),
    dispose: () => h.destroy(),
  };
};
const scan = createScanner(digest),
  signal = () => new AbortController().signal;
const need = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
async function archive(entries: Entry[]) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await createZip(scan).writeZip(
    entries,
    {
      write: async (b) => {
        chunks.push(Uint8Array.from(b));
      },
    },
    signal(),
  );
  return new Blob(chunks);
}
async function files(
  directory?: FileSystemDirectoryHandle,
  prefix = '',
): Promise<{ path: string; hash: string; bytes: number }[]> {
  const root = directory ?? (await navigator.storage.getDirectory());
  const result: { path: string; hash: string; bytes: number }[] = [];
  for await (const [name, handle] of (
    root as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }
  ).entries()) {
    const path = prefix + name;
    if (handle.kind === 'directory')
      result.push(...(await files(handle as FileSystemDirectoryHandle, path + '/')));
    else {
      const file = await (handle as FileSystemFileHandle).getFile();
      result.push({
        path,
        hash: (await scan(blobReader(file), signal())).sha256,
        bytes: file.size,
      });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
async function run() {
  const results: { id: string; state: string; details: unknown }[] = [];
  const limits = {
    journalBytes: 1024 ** 3,
    scratchBytes: 256 * 1024 ** 2,
    externalBytes: 256 * 1024 ** 2,
  };
  const capacity = await TotalCapacity.open({
    totalBytes: 4 * 1024 ** 2,
    managementBytes: 1024,
    maxEntries: 1000,
    maxDepth: 10,
    maxReservations: 20,
  });
  const common = {
    digest,
    capacity,
    ...limits,
    namespace: () => 'v2-fixture-' + crypto.randomUUID(),
    newArtifactId: () => crypto.randomUUID(),
    now: () => '2026-10-13T00:00:00Z',
    authorize: () => true,
  };
  const factory = createPersistenceFactoryV2({ ...common, empty: emptyV2Fixture });
  let persistence: PersistenceV2 | undefined;
  const wrapped: typeof factory = async (live, file) => {
    persistence = await factory(live, file);
    return persistence;
  };
  let host: Awaited<ReturnType<typeof mountV2Host>> | undefined;
  const portable = createPortableProjects(scan),
    fixture = await v2Fixture(scan);
  const wire = await archive(await portable.v2.prepareProject(fixture, signal()));
  // Old saved bytes are real legacy archives in an otherwise closed namespace.
  const old = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle('closed-legacy', { create: true });
  for (const [name, entries] of [
    ['v0.zip', await portable.v0.prepareProject(await v0EmptyFixture(), signal())],
    ['v1.zip', await portable.v1.prepareProject(await v1Fixture(scan, true), signal())],
  ] as const) {
    const stream = await (await old.getFileHandle(name, { create: true })).createWritable();
    await stream.write(await archive(entries));
    await stream.close();
  }
  const legacyFiles = await files();
  const live = { originals: new Map(), plans: new Map() };
  try {
    const v1 = createPersistenceFactoryV1({ ...common, empty: emptyV1Fixture });
    let rejected = false;
    try {
      await v1(live, wire);
    } catch {
      rejected = true;
    }
    need(
      rejected &&
        live.originals.size === 0 &&
        live.plans.size === 0 &&
        same(await files(), legacyFiles),
      'V1 rejection mutated live/files',
    );
    results.push({
      id: 'V2-B01',
      state: 'PASS',
      details: 'v1 Host refuses v2 before target journal/catalog publication',
    });
    host = await mountV2Host(
      document.querySelector('#host')!,
      wrapped,
      {
        preview: async () => {
          throw Error('Synthetic bytes: codec NOT RUN');
        },
      },
      wire,
    );
    const initial = await contentHash(host.read().content);
    need(initial === fixture.capture.contentHash, 'Initial native changed');
    const edit = host.editor.execute({
      baseRevision: host.read().revision,
      command: videoCommandV2({ type: 'gain', clipId: 'audio-only:a', gain: 0.25 }),
    });
    need(edit.state === 'applied', 'v2 edit refused');
    const changed = await contentHash(host.read().content);
    need(changed !== initial, 'Edit absent');
    const saved = await host.editor.save();
    need(
      saved.state === 'outcome' && saved.outcome.state === 'committed',
      'Actual coordinator save failed: ' + JSON.stringify(saved),
    );
    const lease = await persistence!.portable(signal());
    const savedBytes = lease.bytes;
    lease.release();
    const opened = await openPortableFile(savedBytes, digest, signal(), limits.externalBytes);
    need(opened.kind === 'v2', 'Saved wrong format');
    need(
      opened.project.versions.length === 3 &&
        same(opened.project.versions.slice(0, 2), fixture.versions),
      'Old versions changed',
    );
    need(
      opened.project.capture.contentHash === changed && opened.originals.size === 2,
      'Saved closure/capture',
    );
    opened.release();
    const afterSave = await files();
    need(
      legacyFiles.every((f) => afterSave.some((a) => same(a, f))),
      'Old archives changed',
    );
    need((await capacity.inspect()).reservations.length === 0, 'Capacity not settled');
    results.push({
      id: 'V2-B02',
      state: 'PASS',
      details: {
        saved,
        originalBytes: [4, 7],
        archiveBytes: savedBytes.size,
        versions: 3,
        changed,
        limits,
      },
    });
    await host.close();
    host = undefined;
    host = await mountV2Host(
      document.querySelector('#host')!,
      wrapped,
      {
        preview: async () => {
          throw Error('Synthetic bytes: codec NOT RUN');
        },
      },
      savedBytes,
    );
    need((await contentHash(host.read().content)) === changed, 'Reopen changed native');
    need(host.live.originals.size === 2 && host.live.plans.size === 2, 'Reopen selected closure');
    const again = await host.editor.save();
    need(
      again.state === 'outcome' && again.outcome.state === 'committed',
      'Fresh owner save failed',
    );
    const next = await persistence!.portable(signal());
    const reopened = await openPortableFile(next.bytes, digest, signal(), limits.externalBytes);
    next.release();
    need(
      reopened.project.versions.length === 4 &&
        same(reopened.project.versions.slice(0, 2), fixture.versions),
      'Fresh save rewrote ancestry',
    );
    reopened.release();
    const afterReopen = await files();
    need(
      afterSave.every((f) => afterReopen.some((a) => same(a, f))),
      'Old namespace/archive changed after fresh owner',
    );
    const usage = await capacity.inspect();
    need(usage.reservations.length === 0, 'Fresh capacity reservation leaked');
    results.push({
      id: 'V2-B03',
      state: 'PASS',
      details: { versions: 4, files: afterReopen, usage },
    });
    await host.close();
    host = undefined;
    const retained = await v2Fixture(scan, true),
      retainedWire = await archive(await portable.v2.prepareProject(retained, signal()));
    const retainedLive = { originals: new Map(), plans: new Map() };
    const p = await factory(retainedLive, retainedWire);
    need(
      retainedLive.originals.size === 0 && retainedLive.plans.size === 0,
      'Retained-only source became selected',
    );
    need(p.content.sources.length === 0, 'Empty selected version changed');
    await p.close();
    results.push({
      id: 'V2-B04',
      state: 'PASS',
      details: 'Retained-only source closure verified while live selected catalog stays empty',
    });
    return { results, limits, legacyFiles };
  } finally {
    await host?.close();
    capacity.close();
  }
}
Object.assign(window, { v2QA: { run } });
// Shared test utilities only; not a production entrypoint.
export { digest, scan, signal, archive, files, same, need };
