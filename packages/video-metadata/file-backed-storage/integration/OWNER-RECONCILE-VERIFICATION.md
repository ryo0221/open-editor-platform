# Guarded Host save and same-owner reconciliation — exact evidence

Base #198 HEAD **`18403b80790dc796c84ff324974acbcbe1aa4339`**, including Host
runtime **`eed4975ccda15c2168f24f974124d95ece1d5340`**, prepared actual-media harness
`bc8809e18daa68960ad7209333a87bca5ca40547`, #195/#197, and accepted #188/#196.
Tested storage successor **`f2557aa0ebcbba2ef785463d4cd28463b7657274`**.
Following commits are handoff/report only. No Host/Core/Time/native/portable/schema,
journal/lease/closure engine, dependency or workflow edits.

The factory adds precisely this port, matching #198 PersistenceV1:

```ts
reconcile: (operationId, signal) => storage.reconcile(operationId, signal);
```

`storage` is the same live ScopedStorage created for that factory result, not a
new instance, journal, session or coordinator. Reconciliation does not drain/close
it. Host #198 alone passes the evidence into its existing owner.saves.reconcile and
unlatches only on that coordinator's definitive observation. The test harness now
uses `host.editor.save()` and unwraps `SurfaceSaveResult.outcome`; it no longer
accesses the removed unrestricted `host.handle` bypass.

## Results at tested SHA

Linux / Node24.19.0 / Chromium151.0.7922.173. Final browser report records clean
sourceTreeStatus and exact tested SHA. Synthetic131089-byte original only.

| Gate                                          | Result / scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing external-file v1 browser regression  | PASS,6 groups: guarded actual Host save; bounded/released leases; empty-profile external ZIP reopen/new save; failed replacement preservation; explicit v0 refusal; parent-only retained closure                                                                                                                                                                                                                                                                                           |
| Actual factory unknown recovery               | PASS: real journal writes/verifies before only its acknowledgement is suppressed. Close is requested while Save is pending; Host refuses close and retains the original owner, live original and capture. New Save/Open remain blocked. An aborted actual-storage reconciliation read returns unknown and retains claim. Retrying via factory port returns verified committed evidence to the same Host coordinator; capture released; next committed save uses the original session scope |
| Replacement/close after settlement            | PASS: verified replacement closes old persistence exactly once, retains the new original/catalog; final close releases both owners exactly once. No owner replacement while indeterminate                                                                                                                                                                                                                                                                                                  |
| Browser total                                 | 8 groups PASS,4 process launches, page/console errors0                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Related units, serial files                   | 238 PASS/14files, including16 v1 semantic/hash cases and archive F01. No test timeout or production limit changed                                                                                                                                                                                                                                                                                                                                                                          |
| Root lint/typecheck/build/file policy         | PASS; no lint warnings; corrected TS2339 source checked by root tsc/build                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Screenshot                                    | Inspected: failed invalid ZIP replacement keeps original fractional timeline; connected reconcile control supplied by actual #198 Host                                                                                                                                                                                                                                                                                                                                                     |
| Actual146MB/media/desktop-mobile product gate | NOT RUN here; referenced original absent in Storage environment. Video's prepared actual-media harness remains the next gate                                                                                                                                                                                                                                                                                                                                                               |
| Prior wide v0 browser/oracle/scratch suites   | NOT rerun; unchanged implementations retain separately pinned #196 evidence. This change does not relabel those results                                                                                                                                                                                                                                                                                                                                                                    |
| CI/performance/OS crash/main merge/release    | NOT RUN; holds maintained                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

The test-only fault seam wraps the actual storage writer _after_ it commits, then
suppresses the reply. It does not replace storage durability or coordinator logic.
To exercise still-unknown evidence, it passes an aborted read signal to that same
storage's reconcile method. Counters assert exactly one factory owner until
explicit post-settlement replacement, with no persistence close/drain while
unresolved. Scope equality in the next actual save confirms the original coordinator.

## Failures preserved

- At clean base18403b8, root typecheck fails TS2339 at v1-harness.ts102 (`host.handle`
  removed), and the existing browser runner fails accessing undefined `.context`.
- First added recovery test incorrectly assumed the journal write-authorization
  callback rejects read-only reconciliation too. It settled successfully instead
  of staying unknown, so the assertion failed. Accepted journal semantics were
  not changed; the test now uses an aborted read for genuine unknown evidence.
- Initial test instrumentation accessed `reconcile` through the public Storage
  type, which does not expose that private method: TS2339/TS7006. The test now
  narrows the actual factory instance with `instanceof ProfileJournalVideoStorage`
  before instrumenting it. No public type/contract was widened.
- Video's reported prior parallel archive F01 timeout remains in #198's evidence;
  the current related-unit run uses `--no-file-parallelism`. It is not erased or
  relabeled as a pass by this successor.

## Commands

```sh
node packages/video-metadata/file-backed-storage/integration/v1-check.mjs /tmp/video-v1-owner-final-browser
npm run lint
npm run typecheck
./node_modules/.bin/vitest run --no-file-parallelism packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/host-media/file-source/rational-v1.test.ts packages/video-core/src packages/video-core/experiments/pcm-renderer packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run build
npm run check:files
```

All raw logs/profiles/ZIPs/bundles/screenshots remain outside Git. Final report
`/tmp/video-v1-owner-final-browser/results.json` records exact source, full-notice
bundle/digest provenance and browser version. Existing approved dependency/notice
is unchanged; no registry-byte or production-capacity attestation is implied.

| Evidence                                          | SHA256                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-v1-owner-before-type.log`             | `d4dd4781c855e1ef9717b8263e320e448c2a5018b11f088c6e813f19a7f69934` |
| `/tmp/video-v1-owner-before-browser/results.json` | `d3d972f3773ec05bc559a27d4424706828bc75ea677e1f5ac06a34a4724ead67` |
| `/tmp/video-v1-owner-first/results.json`          | `5ced186837b3cbc79dbb7568af1569997dbdc7857893702b78c381d3bb76a12b` |
| `/tmp/video-v1-owner-type-dev.log`                | `189cefa671efe97608f48494febb9bfad4db738d9b550b094032e75877fa15b4` |
| `/tmp/video-v1-owner-final-browser/results.json`  | `1f00e4789804c7b0efd28ca993064d21644fb330a5441d59c32f570ca0b7f646` |
| `/tmp/video-v1-owner-final-lint.log`              | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-v1-owner-final-type.log`              | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-v1-owner-final-unit.log`              | `6fd8b8ddc16264e8caf0fc00f5d62ee4539b5315626b23d31a3352585d9955eb` |
| `/tmp/video-v1-owner-final-build.log`             | `4d39cf02b144bc755e51058f44e02e619fe06c96d93541375df606aae5255c1d` |
| `/tmp/video-v1-owner-final-files.log`             | `c2f8d63fad06fc2fa63b866280fb5f0be4179a0f608a3580d7e8e81c6b1b17ab` |
