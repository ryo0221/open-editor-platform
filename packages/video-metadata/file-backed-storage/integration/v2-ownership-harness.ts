/** Fault injection below real Storage, and an explicit concurrent headless test Host. */
import { contentHash } from '@editor-platform/artifact-core';
import { EditorSession, EditorInputs, command } from '@editor-platform/editor-core';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '@editor-platform/extension-runtime/schema-edit-experiment';
import {
  SCHEMA_EDIT_EXPERIMENT_VERSION,
  type SchemaEditDefinition,
} from '@editor-platform/extension-contract/schema-edit-experiment';
import type { SaveCapture } from '@editor-platform/extension-contract/draft2';
import { time, videoCommandV2, type VideoContentV2 } from '@editor-platform/video-core';
import { mountV2Host, type PersistenceV2, type LiveV2 } from '../../host-media/m2/host-v2';
import { validateHostV2 } from '../../host-media/m2/capacity-v2';
import { prepareAudioImportV2 } from '../../host-media/m2/audio-import-v2';
import type { MediaImportSetV2 } from '../../host-media/m2/media-profile-v2';
import { createPersistenceFactoryV2 } from './persistence-v2';
import { ProfileJournalVideoStorage } from './storage';
import { TotalCapacity } from './capacity';
import { createPortableProjects } from '../portable/versioned';
import { v2Fixture, emptyV2Fixture } from '../portable/v2-fixture';
import { openPortableFile } from '../browser-verifier/external-file';
import { blobReader } from '../browser-verifier/adapter';
import { digest, scan, signal, archive, files, same, need } from './v2-harness';
const limits = {
  journalBytes: 1024 ** 3,
  scratchBytes: 256 * 1024 ** 2,
  externalBytes: 256 * 1024 ** 2,
};
const policy = {
  totalBytes: 4 * 1024 ** 2,
  managementBytes: 1024,
  maxEntries: 1000,
  maxDepth: 10,
  maxReservations: 20,
};
type Target = ProfileJournalVideoStorage<VideoContentV2, MediaImportSetV2>;
function actual(p: PersistenceV2): Target {
  if (!(p.storage instanceof ProfileJournalVideoStorage)) throw Error('Real factory required');
  return p.storage as Target;
}
async function inspect(p: PersistenceV2) {
  const lease = await p.portable(signal());
  try {
    const opened = await openPortableFile(lease.bytes, digest, signal(), limits.externalBytes);
    try {
      return {
        versions: structuredClone(opened.project.versions),
        capture: structuredClone(opened.project.capture),
        originals: [...opened.originals.keys()],
      };
    } finally {
      opened.release();
    }
  } finally {
    lease.release();
  }
}
function concurrentHost(p: PersistenceV2) {
  const owner = new ReferenceRegistry(new ManualClock());
  const schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v2' } as const;
  const registry = new SchemaEditExperimentRegistry(owner, [
    { artifactKind: 'video', schemaIdentity },
  ]);
  const definition: SchemaEditDefinition<VideoContentV2> = {
    manifest: {
      id: 'storage-v2-concurrent-test',
      version: '0.0.0-test',
      packageHash: 'a'.repeat(64),
      contractVersion: SCHEMA_EDIT_EXPERIMENT_VERSION,
      artifactKind: 'video',
      schemaIdentity,
      surface: false,
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'],
      addons: {
        lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
        edit: { version: 'local-edit@0-draft', requirement: 'optional' },
        save: { version: 'local-persistence@0-draft', requirement: 'optional' },
        inputs: { version: 'inputs@0-draft', requirement: 'optional' },
      },
      licenseNotices: ['Synthetic test only'],
    },
    validate: validateHostV2,
    schemaOf: (c) => ({ kind: 'literal', value: c.schema }),
  };
  const opened = registry
    .install(definition, {
      trust: 'trusted',
      verifiedPin: {
        id: definition.manifest.id,
        version: definition.manifest.version,
        packageHash: definition.manifest.packageHash,
      },
    })
    .open({
      artifactId: p.storage.key,
      artifactKind: 'video',
      schemaIdentity,
      session: new EditorSession(p.content),
      inputs: new EditorInputs(),
      storage: p.storage,
      allowed: () => true,
      subscribePermissions: () => () => {},
      recovery: {
        codecs: [],
        perBoundaryBytes: 2048,
        totalBytes: 8192,
        ttlMs: 1000,
        onRevoke: 'discard',
      },
    });
  if (opened.state !== 'opened') throw Error(opened.code);
  const handle = opened.handle;
  return {
    handle,
    editor: createSchemaEditController(handle.context, { onError: () => {} }),
    read: () => handle.context.basic.read(),
  };
}
async function run() {
  const capacity = await TotalCapacity.open(policy);
  const factory = createPersistenceFactoryV2({
    digest,
    capacity,
    ...limits,
    namespace: () => 'v2-owner-' + crypto.randomUUID(),
    newArtifactId: () => crypto.randomUUID(),
    empty: emptyV2Fixture,
    now: () => '2026-10-13T00:00:00Z',
    authorize: () => true,
  });
  const fixture = await v2Fixture(scan),
    wire = await archive(await createPortableProjects(scan).v2.prepareProject(fixture, signal()));
  const results: { id: string; state: string; details: unknown }[] = [];
  let host: Awaited<ReturnType<typeof mountV2Host>> | undefined;
  let persistence: PersistenceV2 | undefined;
  let target: Target;
  let closes = 0,
    writes = 0,
    reconciles = 0,
    abortReconcile = false,
    dropAck = true;
  const marks: SaveCapture[] = [];
  const tracked: typeof factory = async (live, file) => {
    const p = await factory(live, file);
    persistence = p;
    target = actual(p);
    target.markSaved = (c) => marks.push(structuredClone(c));
    const write = target.write.bind(target);
    target.write = (r, s) => {
      writes++;
      return write(r, s);
    };
    const save = target.journal.save.bind(target.journal);
    target.journal.save = async (...args) => {
      const result = await save(...args);
      if (dropAck && result.state === 'saved') {
        dropAck = false;
        return { state: 'unknown', pin: result.pin };
      }
      return result;
    };
    const reconcile = target.reconcile.bind(target);
    target.reconcile = (id, s) => {
      reconciles++;
      return reconcile(id, abortReconcile ? AbortSignal.abort() : s);
    };
    const close = p.close.bind(p);
    p.close = async () => {
      closes++;
      await close();
    };
    return p;
  };
  try {
    host = await mountV2Host(
      document.querySelector('#host')!,
      tracked,
      {
        preview: async () => {
          throw Error('No codec claim');
        },
      },
      wire,
    );
    for (const edit of [
      videoCommandV2({ type: 'gain', clipId: 'audio-only:a', gain: 0.2 }),
      videoCommandV2({
        type: 'fade',
        clipId: 'audio-only:a',
        fadeIn: time(1, 4),
        fadeOut: time(3, 4),
      }),
    ])
      need(
        host.editor.execute({ baseRevision: host.read().revision, command: edit }).state ===
          'applied',
        'Initial edit',
      );
    const hash = await contentHash(host.read().content),
      native = structuredClone(host.read().content);
    const lost = await host.editor.save();
    need(
      lost.state === 'outcome' && lost.outcome.state === 'indeterminate',
      'Lost ACK must be unknown',
    );
    if (lost.state !== 'outcome') throw Error();
    const operationId = lost.outcome.operationId;
    const beforeFiles = await files(),
      beforeUsage = await capacity.inspect();
    const ownership = target!.resourceOwnership;
    need(
      ownership.captures === 1 &&
        ownership.unresolvedWrites === 1 &&
        beforeUsage.reservations.length === 1 &&
        marks.length === 0,
      'Unknown prematurely released ownership',
    );
    need(host.live.originals.size === 2 && host.live.plans.size === 2, 'Unknown lost live catalog');
    results.push({
      id: 'V2-O01',
      state: 'PASS',
      details: { lost, ownership, usage: beforeUsage, hash },
    });
    let closeError = '';
    try {
      await host.close();
    } catch (e) {
      closeError = String(e);
    }
    need(closeError.includes('Unresolved') && closes === 0, 'Close disposed unresolved owner');
    const retry = await host.editor.save();
    need(retry.state === 'refused' && writes === 1, 'Unknown save retry dispatched another write');
    const mutation = host.editor.execute({
      baseRevision: host.read().revision,
      command: videoCommandV2({ type: 'gain', clipId: 'audio-only:a', gain: 0.8 }),
    });
    need(
      mutation.state === 'refused' && same(host.read().content, native),
      'Unknown edit mutated native',
    );
    const importElement = document.querySelector<HTMLInputElement>('#import')!;
    need(importElement.disabled, 'Unknown import enabled');
    need(
      same(await files(), beforeFiles) && same(target!.resourceOwnership, ownership),
      'Close/retry changed ownership/files',
    );
    results.push({
      id: 'V2-O02',
      state: 'PASS',
      details: { closeError, retry, mutation, closes, writes },
    });
    abortReconcile = true;
    let abortError = '';
    try {
      await host.reconcileSave();
    } catch (e) {
      abortError = String(e);
    }
    need(abortError.includes('indeterminate'), 'Aborted reconcile incorrectly settled');
    need(
      same(await files(), beforeFiles) &&
        same(await capacity.inspect(), beforeUsage) &&
        same(target!.resourceOwnership, ownership) &&
        marks.length === 0,
      'Aborted reconcile released owner',
    );
    results.push({ id: 'V2-O03', state: 'PASS', details: { abortError, reconciles } });
    abortReconcile = false;
    await host.reconcileSave();
    need(
      target!.retainedCaptures === 0 &&
        target!.resourceOwnership.unresolvedWrites === 0 &&
        (await capacity.inspect()).reservations.length === 0,
      'Same owner did not settle',
    );
    need(
      marks.length === 1 && marks[0].contentHash === hash && same(host.read().content, native),
      'Wrong current capture marked saved',
    );
    const saved = await inspect(persistence!);
    need(same(marks[0], saved.capture), 'Marked scope/revision differs from persisted capture');
    need(
      saved.capture.contentHash === hash &&
        saved.versions.length === 3 &&
        same(saved.versions.slice(0, 2), fixture.versions),
      'Reconciled archive identity/history',
    );
    const repeated = await persistence!.reconcile!(operationId, signal());
    need(
      repeated.state === 'committed' &&
        same(repeated.capture, saved.capture) &&
        marks.length === 1 &&
        same(await files(), beforeFiles),
      'Repeated evidence wrote/released twice',
    );
    const again = await host.editor.save();
    need(
      again.state === 'outcome' && again.outcome.state === 'committed' && writes === 2,
      'Save after reconciliation unavailable',
    );
    const newFiles = await files();
    need(
      beforeFiles.every((f) => newFiles.some((n) => same(f, n))),
      'Retry replaced old archive',
    );
    await host.close();
    need(
      closes === 1 && host.live.originals.size === 0 && host.live.plans.size === 0,
      'Final close leaked ownership',
    );
    host = undefined;
    results.push({
      id: 'V2-O04',
      state: 'PASS',
      details: { reconciles, repeated, again, closes, marks },
    });
    // #210 intentionally blocks concurrent import during Save. This separate test Host permits it.
    for (const undo of [false, true]) {
      const live: LiveV2 = { originals: new Map(), plans: new Map() };
      const p = await factory(live, wire),
        storage = actual(p),
        savedMarks: SaveCapture[] = [];
      let resume = () => {};
      let entered = () => {};
      const gate = new Promise<void>((r) => {
        entered = r;
      });
      storage.markSaved = (c) => savedMarks.push(structuredClone(c));
      let holdCapture = true;
      storage.beforeDispatch = async () => {
        if (!holdCapture) return;
        entered();
        return new Promise<void>((r) => {
          resume = r;
        });
      };
      const concurrent = concurrentHost(p);
      try {
        const oldHash = await contentHash(concurrent.read().content);
        const saving = concurrent.editor.save();
        await gate;
        need(storage.retainedCaptures === 1, 'Capture not held before dispatch');
        const plan = structuredClone(fixture.plans.find((p) => p.sourceId === 'audio-only')!.plan);
        if (plan.profile !== 'aac-mono-v2') throw Error();
        const original = new Blob([Uint8Array.from([31, 41, 59, 26, 53])]);
        const hash = (await scan(blobReader(original), signal())).sha256;
        live.originals.set(hash, original);
        live.plans.set('late-audio', plan);
        const imported = concurrent.editor.execute({
          baseRevision: concurrent.read().revision,
          command: command<VideoContentV2>('test-import', 'Synthetic post-capture import', (v) => {
            let next = prepareAudioImportV2(
              v,
              plan,
              { assetId: 'late-original', sha256: hash, byteLength: original.size },
              'late-audio',
              time(3),
            );
            next = videoCommandV2({ type: 'gain', clipId: 'late-audio:a', gain: 0.3 }).apply(next);
            return videoCommandV2({
              type: 'fade',
              clipId: 'late-audio:a',
              fadeIn: time(1, 4),
              fadeOut: time(1, 4),
            }).apply(next);
          }),
        });
        need(imported.state === 'applied', 'Concurrent synthetic import refused');
        const importedNative = structuredClone(concurrent.read().content);
        if (undo) need(concurrent.editor.undo().state === 'applied', 'Import Undo refused');
        resume();
        const result = await saving;
        need(
          result.state === 'outcome' && result.outcome.state === 'committed',
          'Captured save failed',
        );
        const oldArchive = await inspect(p);
        need(
          oldArchive.capture.contentHash === oldHash && !oldArchive.originals.includes(hash),
          'Late source contaminated old capture',
        );
        need(savedMarks.length === 0, 'Older completion marked newer revision saved');
        need(
          live.originals.get(hash) === original &&
            live.plans.has('late-audio') &&
            !storage.history.originals.has(hash),
          'Save stole late/Undo-owned resource',
        );
        if (undo) need(concurrent.editor.redo().state === 'applied', 'Held import Redo refused');
        need(same(concurrent.read().content, importedNative), 'Undo/Redo lost v2 gain/fade');
        holdCapture = false;
        const nextSave = await concurrent.editor.save();
        need(
          nextSave.state === 'outcome' && nextSave.outcome.state === 'committed',
          'Latest draft could not save held source',
        );
        const latest = await inspect(p);
        need(
          latest.versions.length === 4 &&
            latest.originals.includes(hash) &&
            latest.capture.contentHash === (await contentHash(importedNative)),
          'Latest save missing held source/gain/fade',
        );
        need(
          savedMarks.length === 1 && savedMarks[0].contentHash === latest.capture.contentHash,
          'Latest capture not marked once',
        );
        need(
          storage.retainedCaptures === 0 && (await capacity.inspect()).reservations.length === 0,
          'Post-capture resource hold leaked',
        );
        results.push({
          id: undo ? 'V2-O06' : 'V2-O05',
          state: 'PASS',
          details: {
            undo,
            result,
            hash,
            oldHash,
            savedMarks,
            ownership: storage.resourceOwnership,
          },
        });
      } finally {
        resume();
        concurrent.handle.revoke('host-close');
        const liveCounts = [live.originals.size, live.plans.size];
        await p.close();
        need(
          same([live.originals.size, live.plans.size], liveCounts),
          'Storage close stole Host-owned live resources',
        );
        live.originals.clear();
        live.plans.clear();
      }
    }
    return { results, limits, policy };
  } finally {
    await host?.close();
    capacity.close();
  }
}
Object.assign(window, { v2OwnershipQA: { run } });
