# Scratch recovery successor — exact author verification

Later receipt-identity and post-fence-restart evidence is recorded in the follow-up
section below. The initial source/results are preserved without relabeling them.

Base #184: `a4f7f2c658aecc013b8fec5824e1a02e184680f5`.
Tested source: **`c2be2549071d69f74561b465f71b0c61958a299e`**.
All five browser reports record this SHA with clean sourceTreeStatus. The following
report-only commit does not change executable/test source. Linux / Node24.19.0 /
Chromium151.0.7922.173. Synthetic data only. Independent review remains pending.

## Results and acceptance

| Suite                                                                                                            | Result                                                 | Acceptance boundary                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| scratch-check                                                                                                    | 12 groups PASS,23 controlled browser launches, errors0 | Six preparation/cleanup interruption points; current authority; exact capture; previous native/archive/original preserved; retry; cross-owner refusal; foreign/missing/corrupt ownership; invalid completed candidate; v1 metadata upgrade; actual coordinator settlement once |
| capture-review-check                                                                                             | 5 groups PASS, errors0                                 | A capture before other owner B publication rejects stale head; later imported B remains live and Undo/Redo-reachable after normal A commit and unknown→committed adoption; final pending references released                                                                   |
| integration/check                                                                                                | 6 groups PASS,2 controlled browser launches, errors0   | Real scoped SaveCoordinator,40MiB parent-only original, capture changes, lost acknowledgement, exact/no-write reconciliation, empty-RAM process restore, new scoped save                                                                                                       |
| browser/check                                                                                                    | 14 groups PASS,6 controlled browser launches, errors0  | Existing journal bounds/ownership/refusal/restart/lease regressions; #178 retained                                                                                                                                                                                             |
| browser-verifier/check                                                                                           | 14 groups PASS, errors0                                | Shared strict ZIP64/project parser, prior Node oracle, malformed closure and capture/hash/bytes refusal; #172/#179 retained                                                                                                                                                    |
| Related unit                                                                                                     | 185 PASS /9files                                       | Storage, browser evidence/ranges, media workflow, Video core, actual draft2/schema-edit save                                                                                                                                                                                   |
| Root lint/typecheck/build/file policy                                                                            | PASS                                                   | No lint warnings; build includes fixed Office-font hash checks; file policy no failures                                                                                                                                                                                        |
| Dependency/notice                                                                                                | PASS                                                   | Owning workspace resolves exact @noble/hashes1.8.0; each digest runner checks full MIT notice and emits provenance; no registry-tarball attestation                                                                                                                            |
| Screenshot inspection                                                                                            | PASS, synthetic Host only                              | Recovered process has no input file selected, retainedCaptures0, one markSaved and7 retained native versions                                                                                                                                                                   |
| Full repository units/E2E, normal Video Host, actual146MB original, rational-time native registration            | NOT RUN                                                | Video-owned integration remains separate                                                                                                                                                                                                                                       |
| OS crash/power loss, live IDB upgrade across old clients, eviction recovery, performance, CI, main merge/release | NOT RUN                                                | No certification or authorization implied                                                                                                                                                                                                                                      |

The numerical/version/retention limits remain the existing private proposal.
No public API compatibility or production durability promise is made. See
[recovery contract and limits](SCRATCH-RECOVERY.md).

## Exact commands

All commands below ran at the tested source. Output paths were exclusive, so
re-runs cannot overwrite a failed report/profile.

```sh
node packages/video-metadata/file-backed-storage/integration/scratch-check.mjs /tmp/video-scratch-final-scratch
node packages/video-metadata/file-backed-storage/integration/capture-review-check.mjs /tmp/video-scratch-final-capture
node packages/video-metadata/file-backed-storage/integration/check.mjs /tmp/video-scratch-final-integration
node packages/video-metadata/file-backed-storage/browser/check.mjs /tmp/video-scratch-final-journal
node packages/video-metadata/file-backed-storage/browser-verifier/check.mjs /tmp/video-scratch-final-verifier
npm run lint
npm run typecheck
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-core/src packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run build
npm run check:files
npm ls @noble/hashes --workspace=@editor-platform/video-metadata
```

Local logs: `/tmp/video-scratch-final-{scratch,capture,integration,journal,verifier,lint,type,unit,build,files}.log`.
Reports contain source, browser and bundle evidence; raw archives/profiles/bundles
and screenshots are not committed.

| Report                                              | SHA256                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-scratch-final-scratch/results.json`     | `78b5981e9b7ed09bee112cde3391466a0977ef6f14b1159869730af08684e165` |
| `/tmp/video-scratch-final-capture/results.json`     | `02f66fa12eb1f5b51f2bfd1fc5cf0a925348348d4845b38c42ca5a6caf4569eb` |
| `/tmp/video-scratch-final-integration/results.json` | `060d672119d226bb7439eae4f73e7ae840d27dc04feb5788b9d297b2665ac65b` |
| `/tmp/video-scratch-final-journal/results.json`     | `def01e44e8246c8f4fc6bb4eb775af6559c2df3974cfeb43d7f48565fcad07d6` |
| `/tmp/video-scratch-final-verifier/results.json`    | `78e17ac1ece49198e276595368c075860b22c1ec38585834c937f0ae06e72d77` |

## Preserved failures and corrections

- Exact #181 capture ownership reproduction remains `/tmp/video-capture-before/results.json`
  SHA256 `58ebe4fdbf3a639ead0590ec4cee6485f0a8111520ba868b8cff288d0360cc67`:
  five real failing cases, corrected by #184. The successor reruns all five.
- `/tmp/video-scratch-first/results.json`, SHA256
  `99d1ed755c5ee33a52445422ea5b8e2d7f9ce5131dc9b149780cb8a5524d9db1`:
  first four restart cases passed, then fresh save failed after the test accumulated
  more than the existing8 native-version limit. Each case now uses an independent
  persistent profile. The production limit was not raised. The diagnostic second
  run is also retained at `/tmp/video-scratch-second`.
- `/tmp/video-scratch-full/results.json`, SHA256
  `33a76fac838fc45b0c2127e34096999da1995529a8603723ef696561e7d6a55d`:
  cleanup fault assertion used Storage's `unknown` instead of actual coordinator's
  `indeterminate`; corrected the assertion, not coordinator behavior.
- Initial root lint caught an unused runner fixture binding; removed. No lint rules
  were disabled. Earlier exploratory positive runs remain separately under
  `/tmp/video-scratch-{third,guards,complete}`; final results above use clean SHA.

Git ancestry verifies #172/#178/#179/#184 are retained. This successor modifies
only `packages/video-metadata/file-backed-storage`. Shared root manifest/lock,
approved dependency/notice, normal Host files, Video native/interpretation schema,
other lanes and workflow configuration are unchanged. Repository remains private;
workflow triggers were rechecked as manual-only before branch publication.

## Independent review follow-up: receipt identity and post-fence restart

The parent reports limited GO for #184's original live-catalog/captured-head blockers
and for #188's journal/scratch ownership review. These are bounded review outcomes,
not overall production acceptance. The parent subsequently also reported limited GO for #188 retention. These review
notifications do not retroactively certify the new receipt-identity follow-up.

The additional #184 receipt issue is reproduced by injecting its exact
`integration/storage.ts` source at `a4f7f2c658aecc013b8fec5824e1a02e184680f5`
into the current controlled harness/journal. A verified settled reconciliation is
paused, `forgetSettled` runs, then completion is released. Its minimal receipt is
reinserted; no Blob leak is claimed. Failure report:
`/tmp/video-forget-before/results.json`, SHA256
`07419a4e6335adb4a21d50ca05d3c30bef55ed67f3cb8fd3f369124250b3f6bf`.

#188 already reads the pending entry after scratch verification, avoiding that
specific #184 stale read. Runtime follow-up **`de3a85d92e6e49f20914862c9531ed88c04f186b`**
also explicitly checks the same Map entry identity after its asynchronous snapshot
read and before adopting history/replacing a receipt. A forgotten/replaced owner
cannot be revived. The new real-coordinator delayed-reconcile/forget test passes;
durable journal history/refusal ownership remains untouched.

Test-only follow-up **`911c9328534c7f9c6347d1573b46564f5016ec3f`** adds a second
controlled process restart AFTER each pre-journal capture refusal fence is created.
All four cold replays return unknown, consume zero input chunks, reject a conflicting
capture as occupied, retain the selected archive, and reproduce the exact no-write
evidence. The extended scratch suite passes12 groups/27 browser launches/errors0.
This is still controlled close/relaunch, not OS-crash or power-loss certification.
The only difference from `de3a85d9` is the27-line scratch runner addition.

At `de3a85d9`, receipt1/capture5/scratch12 and real40MiB integration6 pass
(all browser errors0),185 related units pass, root lint,
typecheck, build and file policy pass. Reports began on clean source. The new
scratch runner also passes focused ESLint at `911c9328`. Original journal14 and
verifier14 results remain scoped to `c2be2549`; those implementations were unchanged
and were not rerun for this receipt-only change. All existing limitations remain.

Commands: same suites/commands above with `/tmp/video-forget-final-*` destinations,
plus:

```sh
node packages/video-metadata/file-backed-storage/integration/forget-review-check.mjs /tmp/video-forget-before --baseline
node packages/video-metadata/file-backed-storage/integration/forget-review-check.mjs /tmp/video-forget-final-forget
node packages/video-metadata/file-backed-storage/integration/scratch-check.mjs /tmp/video-forget-cold-fence
```

The handoff example now explicitly supplies required eighth `LiveCatalog` from the
Host's separate OriginalStore. The optional ninth observation hook is omitted.
No Video native/portable schema, ordinary Host or accepted dependency was changed.

| Follow-up report                                   | SHA256                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-forget-final-forget/results.json`      | `59591043630fcea0488ba2abd2d67f4b416ef6e1fb2a735f48e0c4dbc1815bac` |
| `/tmp/video-forget-final-capture/results.json`     | `fc969e6d5ff666500efa8028ca56b124ad8e5ef6718b19f5d51e07a6019d2e92` |
| `/tmp/video-forget-final-scratch/results.json`     | `f18bee1600935833f74a96aa5a494ca5b265c89eff239a6c023a3227f0a2e348` |
| `/tmp/video-forget-final-integration/results.json` | `8676250605c15b53ed20e54c7b2ac82a73d30fdbe4abbd242b8969a7177d985a` |
| `/tmp/video-forget-cold-fence/results.json`        | `9cb2173763b771e68181f1d14fa4ba9c3b38b5f57e3f9336b8b6c27ac0f8623b` |
