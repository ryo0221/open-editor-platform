# Capacity-enabled actual coordinator verification

Author verification of the accepted #205 ownership correction through the actual
private Video Host, persistence factory and existing SaveCoordinator. This change
adds only independent test fixtures and documentation. No runtime, normalHost,
portable format, budget, retention or shared contract is changed.

- Base #205 docs: `87c810b6b76f8501ddf587fac530e428856a5686`; runtime ownership fix
  `38bdc343e5d2be276b92170e5302229f969d0cc2`, accepted limited GO by parent review.
- Tested clean source: `99bd921f5e17901c55a0cdbbc05643355e553c62`.
- Linux, Node24.19.0, Chromium151.0.7922.173;5 browser launches over4 isolated
  persistent profiles. Final report records empty dirty status and browser errors.
- Synthetic131089-byte original and4096-byte closed-namespace fixture. No actual
  VISION original downloaded, decoded or uploaded by these tests.

## Real integration boundaries

The harness calls `mountV1Host` with `createPersistenceFactoryV1({capacity,...})`.
It invokes the returned Host editor's real Save operation, not a direct primitive
write. Bundle provenance confirms the existing `draft2/save.ts` SaveCoordinator
is included. The factory's actual ProfileJournalVideoStorage, full archive engine,
OPFS journal, scratch ledger and capacity ledger remain in the path.

The fixture installs the existing Host-owned `storage.markSaved` callback before
registry admission, records captures delivered to actual storage.write, and derives
its dirty flag from current native hash versus last saved/imported hash. This tests
saved-marker semantics; it does not add a normal-product dirty indicator. Valid
input flush commits through the real Editor input boundary. A definitive no-write
releases capture lifetime; its immutable identity remains in the outcome and the
edited native remains dirty. Unknown retains both coordinator capture and capacity.

Acknowledgement loss is injected at the actual **journal save return**, after its
verified commit but before Storage receives it. Dropping only the outer Storage
receipt would be insufficient: capacity could already be settled. Abort of a
reconciliation read is injected through the same factory storage's real reconcile
method. No fake successful evidence is supplied.

## Requirement matrix and results

| ID                                                                               | Actual scenario / failure protection                                                                                                                                                                                                                                                                                                        | Result  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| SCAP01                                                                           | Invalid dirty input buffer refuses before dispatch; buffer remains dirty, native unchanged, no storage write                                                                                                                                                                                                                                | PASS    |
| SCAP02                                                                           | Valid input flush -> real capture -> admission -> commit; exact captured hash/revision, capture held while paused, no scratch file before admission, one current markSaved, capture released; usage polling leaves native/revision/marker unchanged                                                                                         | PASS    |
| SCAP03                                                                           | Old namespace plus both archive copies exceed total by1 byte; actual coordinator returns aborted-before-write with adapter-no-write-guarantee before scratch; exact capture identity, dirty native/revision/originals/plans retained, no saved marker, no leaked capture/reservation; old file bytes unchanged                              | PASS    |
| SCAP04                                                                           | Journal lost ack -> actual coordinator indeterminate; one capture and unknown reservation retained; close refused; aborted reconcile keeps them; same-owner successful reconcile marks current once and releases claim/capacity without changing native/files                                                                               | PASS    |
| SCAP05                                                                           | Unknown survives controlled browser-process close; fresh capacity owner sees same reservation; aborted recovery read keeps it; fresh authorized Storage owner verifies evidence and restores archive, then a new actual Host/factory/coordinator imports it under a fresh namespace/scope and saves while preserving all old versions/files | PASS    |
| Usage truthfulness                                                               | Independently enumerate/hash OPFS files; observed bytes equal file sum; accounted=observed+unmaterialized reservation+allowance; logical-opfs/physicalDiskGuaranteed:false; old namespace counted after new-owner save                                                                                                                      | PASS    |
| Non-destructive behavior                                                         | Old fixture and committed archives retain path/size/hash across refusal, reconcile, restoration, next save and settled Host close; no archive deletion or history pruning added                                                                                                                                                             | PASS    |
| Related unit                                                                     | capacity7 + shared SaveCoordinator34 + schema-edit Save19 =60 tests/3 files                                                                                                                                                                                                                                                                 | PASS    |
| Root lint / typecheck / build / check:files                                      | All exit0 on exact tested source                                                                                                                                                                                                                                                                                                            | PASS    |
| Normal capacity product UI, mobile/a11y, real two-original portable, v2 dispatch | Not implemented or certified by this test-only slice                                                                                                                                                                                                                                                                                        | NOT RUN |
| Power loss, OS physical quota, memory guarantees, performance                    | Controlled close/injected faults only; existing holds maintained                                                                                                                                                                                                                                                                            | NOT RUN |

The new usage panel is explicitly test-only JSON. Screenshots of successful Save
and expected capacity refusal were inspected; the existing Host shows its generic
no-write error and retains the edited timeline. Friendly capacity messaging and
normalHost wiring remain integration-owner work.

## Explicit injected test policies, no numerical proposal adoption

The runner supplies journal1GiB, scratch256MiB and external256MiB, preserving the
existing integration limits. The proposed test archive512MiB / total2GiB settings
remain **unapplied pending approval**. No GC is used to make a test pass.

The ample synthetic total policy is4MiB with1024-byte management allowance and
explicit1000-entry/10-depth/20-reservation bounds. These are test inputs, not new
application defaults. The captured synthetic ZIP is A=138814 bytes. A fresh test
profile uses `4096 + 2*A + 1024 - 1 = 282747` total bytes; this is deliberately one
byte short including the old namespace and both proposed copies. It refuses while
keeping only the original4096-byte file. No live policy is changed between attempts.

After a committed-but-unknown save, observed bytes are4096+A and the still-unresolved
additional reservation is A. Verified settlement releases that remaining promise,
not the archive. After recovery and a new-scope save, both old and new archives
remain, with total observed bytes283849. All quantities here are functional fixture
accounting, not performance or physical-backing measurements.

## Fresh-owner limitation made explicit

A fresh factory requires a fresh target journal and cannot fabricate the dead
coordinator's job/grant. The cold fixture first constructs a newly authorized
Storage recovery owner for the existing journal and runs its actual reconcile and
restore. It then hands the verified File into the factory to create a new Host and
scope. The new coordinator has zero old requests, saved callbacks and captures;
only its next save produces its own markSaved. Old capture identity stays in the
archive/evidence. This is an independent trusted recovery workflow, not a newly
shipped recovery UI or resurrection of an old coordinator claim.

## Development failure retained

The first harness queried `inspectScratch()` while deliberately pausing a save
that held the same scratch lock. That test observation deadlocked before the runner
could resume the save. The controlled runner was terminated; its report records
SCAP01 PASS then page/context closure FAIL. The fixture now avoids that lock-taking
inspection during the pause and uses independent file inventory plus actual
ownership/request state. A watchdog closes a stuck test context to retain failure
evidence. No storage runtime or timeout policy was changed. The final5 groups pass.

## Reproduce

```sh
node packages/video-metadata/file-backed-storage/integration/capacity-coordinator-check.mjs /tmp/video-capacity-coordinator-final
./node_modules/.bin/vitest run --no-file-parallelism packages/video-metadata/file-backed-storage/integration/capacity.test.ts packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Use a fresh output directory. Reports/profiles/ZIP bytes/screenshots stay outside
Git. Existing locked @noble/hashes1.8.0 and complete MIT notice are preserved;
`digest-provenance.json` pins installed inputs and served bundle, not a newly
fetched registry archive. Full repository unit/e2e suites were not rerun for this
test-only slice; no initial #205 evidence is relabeled as newly executed.

## M2 handoff, separate gate

Storage inspected #207's earlier tested1464fe3a source only to identify the owned
ports. That pin is **not accepted** for final mono/fade admission: parent review
found relative-arithmetic overflow and stereo admitted under aac-mono-v2. Video has
reported corrected tested `33907d8b38d20f6930734bfa54367fc2ff84f277`, docs
`c0ab0657d784520d398115161b768fb33663ee42`; independent review remains required.
No v2 code is imported by this branch.

Proposed Storage-only follow-up remains: explicit portable-v2 profile and reader
branch, typed external-file dispatch and tiny fixtures; native
`video-core-prototype-v2`, interpretation `video-media-interpretation-v2` with
`av-sdr-v2 | aac-mono-v2`, Artifact envelope1. Exact source reconstruction should use
Video's corrected `prepareAvImportV2` / `prepareAudioImportV2`. Preserve v0/v1 bytes,
hashes and retained history; reject mixed-profile ancestry, never silently convert
or drop it. A v2 Host persistence port must be supplied by its owner before wiring.

Recomputed-hash semantic-negative fixtures are required, not mere checksum damage:
invalid gain/fade/time/native-source/interpretation records must still refuse.
The formerly overflowing but valid time case must follow the corrected Core's
exact semantics, rather than inventing an extra Storage numeric limit. Stereo
must refuse in the corrected original-admission path without downmix: the current
plan/native model has no channel-count field, so pure plan equality plus original
hash cannot independently prove mono codec content. Preserve that Host admission
boundary; do not advertise hash-valid round-trip as codec-profile validation.

## Evidence hashes

| Local evidence                                              | SHA256                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-capacity-coordinator-final/results.json`        | `79f0944ef1d162c2652a7923b2661603c99b20458fc43793446473f7e2ebf6ce` |
| `/tmp/video-capacity-coordinator-final-unit.log`            | `ee14f6150d5d4096bb176ad732eeed777b194213d72547fac41d0c2192beb67f` |
| `/tmp/video-capacity-coordinator-final-lint.log`            | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-capacity-coordinator-final-type.log`            | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-capacity-coordinator-final-build.log`           | `26266d601229f0209e88bd079e1c137ca112bbf7fcda96c67abdb7b7bced9311` |
| `/tmp/video-capacity-coordinator-final-files.log`           | `4d429cd16823674e5027c327c75b20d74303d69c9bcc837671765871456add85` |
| `/tmp/video-capacity-coordinator-dev1/results.json`         | `229ab90c091b161eb23f751c998d43c67aeaf46b738fa8654eebb2925ba7a891` |
| `/tmp/video-capacity-coordinator-dev1/harness-failure.json` | `a2a26ed72a5880b5f9492f1245b3bc9fda074432d67fad964d104a1d424ec85b` |
