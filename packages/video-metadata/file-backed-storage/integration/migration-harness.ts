/** Functional browser regression: actual Host/coordinator/journal; generated metadata, no codec/performance claim. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { videoCommandV2 } from '@editor-platform/video-core';
import { mountV2Host } from '../../host-media/m2/host-v2';
import { createMigrationPersistence } from './persistence-migration';
import { BrowserJournal } from '../browser/journal';
import { blobReader, createProfileBrowserVerifier } from '../browser-verifier/adapter';
import { openPortableFile } from '../browser-verifier/external-file';
import { createPortableProjects } from '../portable/versioned';
import { migrationFixture, fixtureArchive } from '../portable/migration-fixture';
import { v1Profile } from '../portable/v1';
import { emptyV2Fixture } from '../portable/v2-fixture';
import { createScanner, type DigestFactory } from '../portable/io';
import { migrationProfile, type ResolveMigrationSource } from '../portable/migration';
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
const need = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
const budget = 2 * 1024 * 1024;
async function run() {
  const f = await migrationFixture(scan);
  const sourceBlob = new Blob([f.sourceBytes]);
  const sourceNamespace = 'migration-source-' + crypto.randomUUID();
  let sourceJournal = await BrowserJournal.open(
    sourceNamespace,
    budget,
    createProfileBrowserVerifier(digest, v1Profile).verify,
    () => true,
  );
  const pin = {
    operationId: f.source.operationId,
    capture: f.source.capture,
    sha256: f.project.provenance.sourceArchiveHash,
    bytes: sourceBlob.size,
  };
  const stored = await sourceJournal.save(
    pin,
    0,
    (async function* () {
      yield f.sourceBytes;
    })(),
    signal(),
  );
  need(stored.state === 'saved', 'Source journal commit');
  sourceJournal.close();
  sourceJournal = await BrowserJournal.open(
    sourceNamespace,
    budget,
    createProfileBrowserVerifier(digest, v1Profile).verify,
    () => true,
  );
  let allowed = true,
    available = true,
    acquired = 0,
    released = 0;
  const resolve: ResolveMigrationSource = async (ref, abort) => {
    if (!available || !allowed) throw Error('Original unavailable');
    const operation = (await sourceJournal.snapshot()).operations.find(
      (op) => op.phase === 'committed' && op.pin.sha256 === ref.sourceArchiveHash,
    );
    if (!operation) throw Error('Missing retained original');
    const lease = await sourceJournal.lease(operation.pin.operationId, abort);
    acquired++;
    return {
      reader: blobReader(lease.file()),
      assertReadable() {
        need(allowed && available, 'Original permission revoked');
      },
      release() {
        released++;
        lease.release();
      },
    };
  };
  let targetNamespace = '';
  const factory = createMigrationPersistence({
    digest,
    resolveMigrationSource: resolve,
    namespace: () => (targetNamespace = 'migration-target-' + crypto.randomUUID()),
    newArtifactId: () => crypto.randomUUID(),
    empty: emptyV2Fixture,
    now: () => new Date().toISOString(),
    journalBytes: budget,
    scratchBytes: budget,
    externalBytes: budget,
    authorize: () => true,
  });
  let persistence: Awaited<ReturnType<typeof factory>> | undefined;
  const wrapped: typeof factory = async (...args) => {
    persistence = await factory(...args);
    return persistence;
  };
  const wire = new Blob([
    await fixtureArchive(
      scan,
      await createPortableProjects(scan).migration.prepareProject(f.project, signal()),
    ),
  ]);
  let host: Awaited<ReturnType<typeof mountV2Host>> | undefined;
  const codec = {
    preview: async () => {
      throw Error('Synthetic media; codec not run');
    },
  };
  const results = [];
  try {
    host = await mountV2Host(document.querySelector('#host')!, wrapped, codec, wire);
    const changed = host.editor.execute({
      baseRevision: host.read().revision,
      command: videoCommandV2({ type: 'gain', clipId: 'source:a', gain: 0.25 }),
    });
    need(changed.state === 'applied', 'Normal Host edit');
    const hash = await contentHash(host.read().content);
    const saved = await host.editor.save();
    need(
      saved.state === 'outcome' && saved.outcome.state === 'committed',
      'Coordinator save: ' + JSON.stringify(saved),
    );
    const output = await persistence!.portable(signal());
    const file = output.bytes;
    output.release();
    const opened = await openPortableFile(file, digest, signal(), budget);
    need(
      opened.kind === 'migration-v1' &&
        canonicalJson(opened.project.provenance) === canonicalJson(f.project.provenance),
      'Saved origin lost',
    );
    need(
      opened.project.capture.contentHash === hash && opened.project.versions.length === 2,
      'Saved draft/history',
    );
    opened.release();
    await host.close();
    host = undefined;
    need(acquired === released, 'Source lease leak after close');
    host = await mountV2Host(document.querySelector('#host')!, wrapped, codec, file);
    need((await contentHash(host.read().content)) === hash, 'Fresh Host reopen');
    need(host.live.originals.size === 1, 'Fresh media closure');
    const again = await host.editor.save();
    need(again.state === 'outcome' && again.outcome.state === 'committed', 'Fresh save');
    results.push({
      id: 'MIG-B01',
      state: 'PASS',
      details:
        'Actual Host edit/save/close/reopen/resave preserves origin, history and media closure',
    });
    if (again.state !== 'outcome' || again.outcome.state !== 'committed')
      throw Error('Save required');
    const restoreId = again.outcome.operationId;
    const restored = await persistence!.storage.restore(restoreId, signal());
    need(
      canonicalJson(restored.project.provenance) === canonicalJson(f.project.provenance),
      'Restored provenance',
    );
    restored.release();
    allowed = false;
    let restoreDenied = false;
    try {
      await persistence!.storage.restore(restoreId, signal());
    } catch {
      restoreDenied = true;
    }
    need(restoreDenied, 'Storage restore bypassed original read authorization');
    const denied = await host.editor.save();
    need(
      !(denied.state === 'outcome' && denied.outcome.state === 'committed'),
      'Permission loss falsely committed',
    );
    let refused = false;
    try {
      await persistence!.portable(signal());
    } catch {
      refused = true;
    }
    need(refused, 'Portable output ignored source permission');
    await host.close();
    host = undefined;
    allowed = true;
    available = false;
    const live = { originals: new Map(), plans: new Map() };
    refused = false;
    try {
      await factory(live, file);
    } catch {
      refused = true;
    }
    need(
      refused && live.originals.size === 0 && live.plans.size === 0,
      'Missing source mutated live state',
    );
    available = true;
    const original = await sourceJournal.lease(pin.operationId, signal());
    need(
      (await scan(blobReader(original.file()), signal())).sha256 === pin.sha256,
      'Original bytes changed',
    );
    original.release();
    need(acquired === released, 'Source lease leak on refusal');
    results.push({
      id: 'MIG-B02',
      state: 'PASS',
      details:
        'Source read revocation blocks save/output; unavailable origin refuses reopen; source archive unchanged',
    });
    return {
      results,
      retained: { sourceNamespace, targetNamespace, hash, sourceHash: pin.sha256 },
    };
  } finally {
    await host?.close();
    sourceJournal.close();
  }
}
async function reopen(retained: {
  sourceNamespace: string;
  targetNamespace: string;
  hash: string;
  sourceHash: string;
}) {
  const source = await BrowserJournal.open(
    retained.sourceNamespace,
    budget,
    createProfileBrowserVerifier(digest, v1Profile).verify,
    () => true,
  );
  const target = await BrowserJournal.open(
    retained.targetNamespace,
    budget,
    createProfileBrowserVerifier(digest, migrationProfile).verify,
    () => true,
  );
  let host: Awaited<ReturnType<typeof mountV2Host>> | undefined;
  const current = (await target.snapshot()).current;
  need(current, 'Durable target missing');
  const targetLease = await target.lease(current!, signal());
  try {
    const factory = createMigrationPersistence({
      digest,
      resolveMigrationSource: async (ref, abort) => {
        need(ref.sourceArchiveHash === retained.sourceHash, 'Durable source identity');
        const op = (await source.snapshot()).operations.find(
          (op) => op.phase === 'committed' && op.pin.sha256 === ref.sourceArchiveHash,
        );
        need(op, 'Durable original missing');
        const lease = await source.lease(op!.pin.operationId, abort);
        return {
          reader: blobReader(lease.file()),
          assertReadable() {},
          release: () => lease.release(),
        };
      },
      namespace: () => 'migration-restored-' + crypto.randomUUID(),
      newArtifactId: () => crypto.randomUUID(),
      empty: emptyV2Fixture,
      now: () => new Date().toISOString(),
      journalBytes: budget,
      scratchBytes: budget,
      externalBytes: budget,
      authorize: () => true,
    });
    host = await mountV2Host(
      document.querySelector('#host')!,
      factory,
      {
        preview: async () => {
          throw Error('Synthetic media');
        },
      },
      targetLease.file(),
    );
    need(
      (await contentHash(host.read().content)) === retained.hash && host.live.originals.size === 1,
      'Durable edit/media mismatch',
    );
    return {
      id: 'MIG-B03',
      state: 'PASS',
      details: 'Browser process restart restores target and separately retained source from OPFS',
    };
  } finally {
    await host?.close();
    targetLease.release();
    target.close();
    source.close();
  }
}
(
  globalThis as typeof globalThis & { migrationQA: { run: typeof run; reopen: typeof reopen } }
).migrationQA = { run, reopen };
