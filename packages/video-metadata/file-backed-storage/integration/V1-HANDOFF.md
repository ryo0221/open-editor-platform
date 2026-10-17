# Private portable v1 / external File handoff

This storage-owned successor is based on Video #194 tested
`5007face5e00863231291b0de66cb80475561d76`, which includes Core #193 tested
`ef9a9fe39c19a33680d71f32366b61f299eb7ddc` and accepted storage #188 HEAD
`eee789625dc698ba1cd226090feb97d1ba936383`. No Video Host, codec, Core, shared Time,
manifest/lock or workflow files are changed by this successor. Their independent
review/acceptance is separate from these storage tests.

## Exact ports

- `portable/v1.ts`: `createVersionedProject(scan).open(reader, signal)` returns a
  discriminated `{ kind: 'v0' | 'v1', project }` union after complete validation.
  Explicit v1 writer: `createProfileProject(scan, v1Profile).prepareProject(...)`.
  Legacy `createProject(scan)` and Node bindings remain v0-only with unchanged
  serialized field names, canonical encoding and ZIP profile.
- `browser-verifier/external-file.ts`: `openPortableFile(file, digest, signal,
maxBytes)` verifies the entire archive and every retained native/original before
  returning a version-discriminated project, archive receipt and original leases.
  A lease has `size`, `read(offset,length,signal)` (at most65536 bytes) and `blob()`.
  Release clears original maps and prevents later/late reads. Already-returned
  immutable Blob slices cannot be revoked: the receiving Host/codec must drain and
  release those consumers. No whole-original ArrayBuffer is required by storage.
- `integration/persistence-v1.ts`: `createPersistenceFactoryV1(options)` implements
  #194's exact `PersistenceFactoryV1(live,file?)` type and returns
  `{storage, content, portable, close}`. Video passes this factory to its existing
  `mountV1Host`. Digest, namespace allocation, fresh artifact identity, empty native,
  current operation authorization, timestamps and explicit budgets are Host ports.

```ts
const factory = createPersistenceFactoryV1({
  digest: digestFactory,
  namespace: allocateFreshPrivateNamespace,
  newArtifactId: allocateArtifactId,
  empty: emptyV1,
  now: timestamp,
  journalBytes: policy.journalBytes,
  scratchBytes: policy.scratchBytes,
  externalBytes: policy.externalBytes,
  authorize: authorizePinnedOperation,
  signal: candidateSetupSignal,
});
await mountV1Host(root, factory, codecV1, optionalPortableFile);
```

Namespaces must be fresh and distinct per candidate Host (short enough to append
`-scratch` within64 characters); an occupied journal is refused, never reset.
External import retains the stored artifact identity and all historical versions,
but starts a fresh local journal head0 and fresh Host scope. The old portable
operation/capture is provenance, never an authorization grant. Save creates a new
immutable version whose parent is the old selected version. No history is relabeled.
The adapter's `portable()` exposes only a verified committed journal file. Close
aborts/drains active storage jobs and releases owned leases; the Host remains owner
of independent current/Undo catalogs. An already-closing call shares its drain.

Fresh candidate live maps must be empty. Full file/profile/native/hash/parent and
original closure verification happens before any live-map mutation. The selected
sources seed the live maps; the saved history separately retains parent-only sources.
An indeterminate save is still owned by the current live coordinator. The Host must
retain that owner/authority until the pending claim is definitively settled; it must
not close/replace the old persistence first. Current `close()` aborts its lifetime,
so later `reconcile()` on that closed storage returns unknown. Reopening a portable
file cannot settle a dead owner's job. Unknown-save replacement/close UX remains
Video-owned coordination, not a new lifecycle contract in this adapter.

A failed candidate open therefore leaves the old Host/draft/live/Undo untouched.
The #194 caller already mounts a candidate before releasing its previous Host.

## Version and compatibility rules

| Portable format                 | Native contents in every retained version | Interpretation                               |
| ------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `video-file-zip64-candidate-v0` | `video-core-prototype-v0`                 | Existing unversioned `{streams}` v0 contract |
| `video-file-zip64-candidate-v1` | `video-core-prototype-v1`                 | Exact `video-media-interpretation-v1` fields |

Artifact envelope schemaVersion remains1, separately from native content and
portable profile versions. Unknown profile/native/envelope/interpretation versions,
mixed histories, native/interpretation inconsistency, bad hashes, missing parents,
missing originals including parent-only ones, and unexpected closure entries reject.
There is no native upgrade, no v0 hash rewrite, and no inference from media file type.
A v0 archive can be read by the dispatcher/external opener; the v1 Host factory
explicitly refuses it and requires the v0 Host. The source reconstruction check uses
Video's pinned `prepareImportSetV1`, including the corrected rational/sample mapping
validator; storage does not create another rational conversion policy. This proves
stored interpretation-to-native consistency, not independent demux/codec validation
of the original compressed bytes; original admission remains Video-owned.

The one shared project engine still performs canonical JSON, strict ZIP/CRC/SHA,
bounded metadata and full retained closure validation. Browser/Node readers share
that engine; v1 does not introduce a shadow verifier or a second native history.
#188's journal/capture/receipt/scratch protocols are parameterized by profile but
retain their existing v0 constructor and runtime behavior.

## Capacity and remaining integration

No production limit was raised or newly adopted. The existing private profile caps
(8 retained versions,100 originals/plans,64KiB metadata records,4GiB aggregate
originals,8GiB archive,64 journal/scratch/refusal records) remain proposal limits.
The synthetic browser test uses explicit16MiB journal,4MiB scratch/external budgets
and a131089-byte original. These are not146MB acceptance or performance guarantees.
Scratch/external caps do not bound the total live/Undo catalogs, captures and
retained journal archives. Video must choose its reviewed total-resource policy.

The approved actual original referenced by #194 was not present in this selected
environment at `/workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov`.
Its reference is146163851 bytes/SHA256
`69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`.
Storage's exact synthetic #194 Host save/external-empty-Host reopen is not a media
playback/export or actual-original acceptance claim. Video can wire these ports
without an alternative verifier/history; real146MB end-to-end remains their next
gate. No external upload, CI, performance, main merge or release is authorized here.

## #198 guarded Host / same-owner reconciliation follow-up

For Host runtime `eed4975ccda15c2168f24f974124d95ece1d5340`, the factory also exposes
`reconcile(operationId, signal): Promise<WriteEvidence>` by delegating to the SAME
live storage instance. Host `reconcileSave()` passes evidence only to its existing
coordinator; no new owner is created, and no persistence drain precedes settlement.
Use `host.editor.save()` (result.state `outcome` → result.outcome), not removed
`host.handle`. The Host now keeps pending-close unknown saves recoverable and blocks
Save/Open/disposal until definitive reconciliation. The existing adapter close
lifetime remains unchanged: late reconcile on already-closed storage stays unknown.

See [exact follow-up failures and verification](OWNER-RECONCILE-VERIFICATION.md).
The caller interface is implemented, not merely proposed. Actual146MB save/reopen
verification remains Video-owned in its environment; no wider completion is claimed.
