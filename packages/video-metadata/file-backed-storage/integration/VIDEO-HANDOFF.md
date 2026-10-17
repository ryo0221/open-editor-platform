# Private Video integration handoff

**Video owns final ordinary Host wiring.** This directory is an independent test
Host plus proposed private Storage adapter, not an edit to browser-host.ts,
bundle.ts, import.ts, codec or public package exports. Combined candidate contains
reviewed #172 Node corrections, #178 journal ownership corrections and #179 shared
verifier; none are replaced with #176's earlier implementation.

## Minimal interface change for the owning Host

Current `host-media/browser-host.ts` activation constructs VideoBundleStorage and
passes it as `installed.open({ storage: nextStorage, ... })`. Keep that existing
scoped binding/save API. The new candidate replaces that Storage object only after
Host setup has acquired its journal and original catalog:

```ts
// Host-owned asynchronous setup; use namespace and budgets from an explicit policy.
const verifier = createBrowserVerifier(digestFactory);
const journal = await BrowserJournal.open(
  namespace,
  journalBudget,
  verifier.verify,
  authorizePinnedOperation,
);
const nextStorage = new JournalVideoStorage(
  artifactId,
  journal,
  digestFactory,
  scratchNamespace,
  scratchBudget,
  history,
  () => new Date().toISOString(),
  {
    // Borrow from the Host's live OriginalStore, including current/Undo resources.
    getOriginal: (sha256) => originalStore.get(sha256),
    getPlan: (sourceId) => originalStore.getPlan(sourceId),
  },
);
nextStorage.markSaved = onCurrentCaptureSaved; // Host dirty/status callback
// Configure callback identities BEFORE installed.open: admission snapshots/binds them.
const opened = installed.open({ ...existingBinding, storage: nextStorage });
```

These identifiers represent Host-owned policy/ports, not new public APIs.
`history` is `{ journalHead, versions, selectedVersionId, originals: Map<sha256, Blob>,
plans: Map<sourceId, ImportSet> }`, representing the verified saved branch only.
Its journalHead must correspond to those versions; capture pins that head, and
dispatch CAS rejects a stale owner instead of sampling/relabeling the newest head.
Restore derives the head from the verified committed operation; an external portable
import starts at head0 only in an empty journal.

The required eighth constructor argument, LiveCatalog, borrows from the separate
Host-owned `originalStore` shown above. It must not point at `history.originals` or
`history.plans`, which represent the saved branch. The ninth scratch observation
argument is optional and omitted in this Host example.
Register accepted imports there; retain current-draft and Undo/Redo resources until
their Host owners release them. Never put new live imports in saved history maps.
Adopting an old captured archive replaces only saved catalogs and never removes
independent live/Undo resources. Never use preview-only resources as committed originals. Capture makes owned
metadata/map copies and retains immutable Blob/File references from the captured
content **and every retained version**. Live catalog changes cannot replace those
captured bytes. There is no alternate EditorSession or Undo.

The owning Host must coordinate activation/revoke/dispose and fresh authorization.
The adapter needs authority both at scoped dispatch and at journal commit/resume;
old stored scopes are correlation data, not grants. Do not pass untrusted content
or arbitrary extension evidence to this trusted adapter.

For a live unknown job, use the actual owner registry:

```ts
const evidence = await nextStorage.reconcile(operationId, signal);
owner.saves.reconcile(operationId, evidence);
```

Unknown retains the existing coordinator claim and original capture. Verified
committed/no-write evidence is matched to exact pins. The coordinator calls
markSaved only for its still-current scoped revision. A foreign capture receipt
cannot release a claim; repeated final reconciliation cannot mark another draft
or republish an older selection.

For a **new process**, there is no old in-memory SaveCoordinator job to settle.
Inspect the durable journal and explicitly restore a verified committed operation:

```ts
const restored = await nextStorage.restore(operationId, signal);
const selected = restored.project.versions.find(
  (version) => version.versionId === restored.project.selectedVersionId,
)!;
// Build a fresh EditorSession(selected.content), fresh binding/grants and Storage
// initialized with restored.history. Do not manufacture the old coordinator job.
// Register restored.release with the new lifecycle, retaining blobs until consumers finish.
```

`restore` yields original Blob slices of the immutable completed File and all native
versions. The strict shared ZIP reader now exposes its validated `dataOffset` in
its private return value solely to form those slices. On-wire bytes/profile/schema
are unchanged; no public entrypoint changed. The lease's release guard cannot
revoke a Blob already handed out; the Host owns disposal of its consumers.

## Preparation, scratch and unknown boundaries

The adapter writes a bounded portable ZIP to an exclusively owned OPFS scratch
file, closes/hashes it, then streams it into the journal's immutable candidate.
Scratch is **not** the portable project or the journal-selected output. The Host
can download the verified lease File as the portable project, separately from its
scratch/journal implementation. Older selected files are never overwritten here.

A separate origin Web Lock serializes scratch users. The durable scratch ledger
owns the filename and exact capture before file creation; unfinished preparation
blocks a new one. Explicit recovery can now establish a pre-journal operation-wide
capture refusal fence without inventing an archive hash. It discards unpublished
preparation or fully verifies a completed journal candidate before removing only
the owned scratch file. It never automatically publishes interrupted work.

For an explicitly selected interrupted record, inspect, check current Host authority,
and recover before reconciling a still-live job with its actual owner:

```ts
const records = await nextStorage.inspectScratch();
const selectedRecord = records.find((record) => record.operationId === selectedOperationId);
if (!selectedRecord) throw new Error('Unknown scratch operation');
const evidence = await nextStorage.recoverScratch(
  selectedRecord.operationId,
  signal,
  (record) => authorizeRecoveryNow(record), // Fresh authority, not the stored capture as a grant.
);
// Only if this exact job still belongs to this in-memory owner:
owner.saves.reconcile(selectedRecord.operationId, evidence);
```

A new process must not run that last line for a dead owner's job; restore a verified
saved history and create fresh binding/grants instead. Unknown evidence retains the
live coordinator claim and may require further recovery. Missing/corrupt metadata,
foreign scratch and legacy untracked #181 files are not guessed or silently deleted.
Automatic GC remains unimplemented. See [the scratch recovery contract](SCRATCH-RECOVERY.md)
for exact phases, bounds and controlled-restart limits; no OS-crash/power-loss
certification is implied.

Journal rejection returns no-write only after #178's durable rejected-ID fence.
Failed fence/verification/commit observations remain unknown. Native history is
adopted on verified commit even if the current draft has advanced; current-draft
saved marking stays with the coordinator. Reconciliation of old completions cannot
select old history over the journal's current version.

## Approved 146MB iPhone original coordination

The adapter accepts the actual original File/Blob; it introduces no proxy,
transcode, duration reduction or codec decision. Video owns original admission and
exact native/ImportSet interpretation, including its approved146MB iPhone fixture.
Do not reuse the older16MiB import guard/32MiB MediaStore as a claimed large-file
path; those Host-owned changes remain separate.

The local integration fixture uses40MiB original,48MiB scratch and512MiB journal
budgets. These are functional fixture configuration, not capacity guarantees or
appropriate defaults for146MB. Video must supply the real fixture path/hash and
native+ImportSet pin, set an explicit scratch budget exceeding the complete archive,
and account for cumulative retained journal archives, temporary scratch, captured
resources and the independently Host-owned live/Undo catalogs. The scratch cap
alone does not bound that total retained storage or memory. That actual
original's codec/source-integrity acceptance is NOT RUN here until that evidence
is available. The private adapter interface is ready for the owning Host to wire.

## Dependency and notice handoff

Parent approved exact @noble/hashes1.8.0 in video-metadata. Only its owning manifest
and matching `package-lock.json` workspace dependency entry add that exact version.
The already existing resolved package/integrity record is unchanged. Root manifest,
repository license, package version/exports and other dependency entries remain
unchanged. `npm ls --workspace @editor-platform/video-metadata @noble/hashes` checks
resolution. See the literal diff in this PR; no install or lock regeneration.

`NOBLE-HASHES-LICENSE.txt` contains the complete copyright and MIT permission/
disclaimer text. Both general-verifier and integration runners put this full text
in bundle banners and `THIRD-PARTY-NOTICES.txt`. The final product bundler must do
the same; serving a source file alone is not sufficient distribution compliance.
`digest-provenance.json` maps lock record, exact installed included source hashes,
notice hash and generated bundle hash. It is **locked installed input-to-artifact
provenance**, not registry tarball byte attestation. No registry bytes were fetched
or independently attested in these checks.

## Capture ownership correction

Final adapter receipts keep only pin/evidence metadata (bounded64); unresolved
writes keep their Project/History/Blob references. `resourceOwnership` distinguishes
captures, unresolved writes, saved originals and externally Host-owned live data.
`retainedCaptures === 0` alone is not proof of complete resource release. The Host
may call `forgetSettled` for definitive receipt metadata; durable journal identity
fences remain. Live resources are released by the current/Undo owner, and retained
native originals by an explicit retained-version policy, never by an older save's
capture adoption. No cross-owner history merge or permanent public API is added.
