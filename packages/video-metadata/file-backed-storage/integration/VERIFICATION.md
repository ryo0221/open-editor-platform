# Exact combined private integration evidence

Tested implementation **3ce6b9c2ed51cdc419e0c60a76ff58f65b2732ba**. Clean source at
all three browser runner starts. Final evidence-only documentation commit does not
change runtime/test code. Git ancestry checks confirm all reviewed inputs:

- #172 `414514241ee0dff13159635826c7493f513c2865` (Node storage/keyset/session fixes).
- #178 `28f467f35ad5bf75a38ea80650da7162884fb32a` (durable browser refusal fences).
- #179 `e0e09a9b364d261c9b60e1266efa2cd85021d717` (single shared strict verifier).

No Video-owned ordinary Host/bundle/import/codec source is edited. The explicit
approved dependency is the only owning-package manifest/lock change; literal diff
adds @noble/hashes1.8.0 to video-metadata and its corresponding workspace lock entry.
Root manifest, existing resolved dependency record and package exports unchanged.

## Actual scoped coordinator integration

Cloud Linux/Node24.19.0; real Chromium151.0.7922.173. The independent Host imports
public ReferenceRegistry, SchemaEditExperimentRegistry and videoTimelineExtension,
then invokes `handle.context.addons.save.api.save()`. Bundle metafile confirms the
actual draft2/save.ts implementation. ManualClock is the controlled Host scheduler;
these are functional ownership/receipt tests, not wall-clock deadline measurements.
The fake Storage/stand-in SaveCoordinator is not used.

| Gate | Exact result |
| --- | --- |
| I01 current save | PASS:real scoped capture → proposed Storage → strict ZIP64 → journal → committed evidence; capture released and markSaved called once; native3-version closure includes parent-only40MiB original |
| I02 changed draft/catalog | PASS:pause after real capture, edit via existing controller and remove live original references, then dispatch; captured content/originals commit unchanged; newer draft not marked saved; captured originals retained into adopted history |
| I03 unknown/reconcile | PASS:injected lost journal acknowledgement retains actual coordinator capture/SaveBusy claim; wrong capture evidence leaves invalid-receipt unknown; exact verified evidence settles/releases/marks current once; old completed reconciliation cannot republish |
| I04 no-write/reconcile | PASS:journal authority refusal creates durable aborted-ID fence; real coordinator returns aborted-before-write with adapter guarantee; subsequent no-write reconciliation stays definitive without markSaved; prior selected output unchanged |
| I05 empty in-memory Host restart | PASS:second real browser process on same persistent origin/profile restores validated native/history/original Blob lease; new coordinator has zero prior jobs/marks, fresh session scope, rejects reconciliation of dead job with UnknownOperation |
| I06 next save | PASS:new scoped save from restored history/originals commits and marks only its current capture; seven retained native versions remain coherent |

**6 integration groups PASS, 2 actual controlled browser process launches, browser
console/page errors0.** No source file is selected in the recovered process; it uses
the verified retained OPFS File/Blob ranges. This means empty in-memory Host with
persistent origin storage, not erased storage or OS-crash recovery. Recovery
screenshot inspected; the page explicitly labels itself a private synthetic Host.
Scratch was empty after settled adapter calls. Interrupted preparation/scratch GC
is not certified (see limits below).

## Combined regression gates

- Browser journal B01–B14: **14PASS**, six process launches, errors0, including
  competing-owner/restart rejection fencing and cancellation around commit.
- General archive V00–V06: **14PASS groups**, errors0. Adds direct normal valid-file
  expected capture mismatch and expected byte-length mismatch checks, alongside
  operation/hash mismatch. Exact old Node source remains the differential oracle.
- Unit: **185PASS /9files** =124 Node archive/review/Video Host/Core +8 browser
  mapping/range +34 draft2 SaveCoordinator +19 schema-edit save regressions.
- Root lint: PASS,0errors; one unused no-undef directive warning in provenance.mjs.
  Root typecheck/build/file policy and owning-package npm dependency resolution PASS.
  Existing build chunk warnings are not performance acceptance.

Commands:

```sh
node packages/video-metadata/file-backed-storage/integration/check.mjs /tmp/video-combined-integration
node packages/video-metadata/file-backed-storage/browser/check.mjs /tmp/video-combined-journal
node packages/video-metadata/file-backed-storage/browser-verifier/check.mjs /tmp/video-combined-verifier
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-core/src packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run lint
npm run typecheck
npm run build
npm run check:files
npm ls @noble/hashes --workspace @editor-platform/video-metadata
```

Output directories must be new. Profiles/archives/screenshots/logs remain outside
Git. Report hashes:

| Report under `/tmp/` | SHA-256 |
| --- | --- |
| video-combined-integration/results.json | 028e616052ddc62dec2f187eafabee78a8ef74334fe93884ee6be87537977b51 |
| video-combined-journal/results.json | 91152bd95f0d40d7334a4a352286bac92d07033478666be745f3407b846214e4 |
| video-combined-verifier/results.json | 765643e4051d9f3d0104419828317221b94fe435892d1ff20483f8d7bbe71a76 |

Integration and verifier artifact directories each include full
THIRD-PARTY-NOTICES.txt and digest-provenance.json. Six actually included installed
@noble files, installed manifest, lock record and whole lock hash are tied to
bundle and notice hashes. Full MIT notice SHA-256:
`4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec`.
Both served JS bundles include that full copyright/permission/disclaimer text.
This proves the described **locked installed input-to-artifact relationship**;
registry tarball bytes were neither downloaded nor independently attested.

## Failure history and remaining gates

Exploratory first integration6PASS is not substituted for final evidence. The
stronger second run retained I01PASS then a wait timeout: the harness replaced a
beforeDispatch callback after schema admission had already pinned callback
identities. Fixed by installing a stable callback before opening the scope and
changing only its controlled gate state. No shared runtime was changed or timeout
hidden. `/tmp/video-integration-second/results.json` retains FAIL. Initial lint
also rejected an unused seed variable; removed it. Third exploratory run and the
final exact-source run pass. Prior #172/#178/#179 failure evidence remains intact.

**NOT RUN / NOT IMPLEMENTED:** ordinary Video Host wiring/UI/codec acceptance,
actual146MB iPhone fixture acceptance, full repository regression, OS crash/power
loss, origin eviction, user-file atomic overwrite, interrupted pre-journal scratch
recovery/GC, performance, CI, merge/deploy/release. Generic pre-journal failures
remain unknown until explicit Host recovery; no false no-write is manufactured.
Budgets and full scratch/candidate occupancy require Host policy. The tested48MiB
scratch budget is not a146MB-file setting or a product capacity promise.

Video owns final wiring and the146MB original's native/ImportSet/hash evidence.
Minimal interface, callback ordering, lease lifetime, recovery semantics, exact
dependency/notice obligations and budget handoff are in VIDEO-HANDOFF.md. Current
scope completes a private integration proof, not product integration or release.

| Local log under `/tmp/` | SHA-256 |
| --- | --- |
| video-combined-unit.log | b9dd40e1c8dc5b0cdbf9b39d125de52fe3572590e11059cc0c3c218df079d723 |
| video-combined-lint.log | c673e1b360c78b7362f54423b709e82ff533a9d678367a5b9dae3ceb0c95f170 |
| video-combined-type.log | 94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280 |
| video-combined-build.log | 9c42621c8d841508e7edeb90d2e68538a3c141c9d866aa78ec48aeb68304a64f |
| video-combined-files.log | 8139836ccb3596110697225bc07b66743b1ebdd18df172bf39212ac8d8f941c2 |
| video-combined-dependency.log | 9acef790f15ea9f4b5da812f4b1e96c9c557033091840edac9c3a0a26881394d |
