# Portable v1 and external File — author verification

Exact source **`d3702f7f470890b971334dc4e7281e104a2714f6`**. All six browser
reports started with this SHA and clean sourceTreeStatus. Subsequent changes are
report/handoff documentation only. Linux, Node24.19.0, Chromium151.0.7922.173.
Independent review remains required; no parent review of other pins is substituted.

Base is #194 tested `5007face5e00863231291b0de66cb80475561d76`. Git ancestry
confirms #193 `ef9a9fe39c19a33680d71f32366b61f299eb7ddc` and #188
`eee789625dc698ba1cd226090feb97d1ba936383`. New diff is entirely within
`packages/video-metadata/file-backed-storage`; Host/Core/Time/dependency/workflow
source remains byte-identical to that base. No new dependency or schema migration.

## Acceptance mapping

| Gate                                                                    | Result                              | Evidence and limits                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit v1 portable dispatch/native-interpretation consistency         | PASS,12 new unit cases              | Fractional42251/600 endpoint; retained-parent roundtrip; v0-only API refusal; unknown format/native/envelope; mislabeled v0; interpretation format/fields/native mismatch; missing parent-only original; mixed native preparation; native hash mismatch even with rebuilt ZIP checksums |
| Actual #194 Host scoped v1 save                                         | PASS                                | Existing EditorSession/SaveCoordinator + concrete factory, three immutable versions and exact original closure. Synthetic bytes; media codec callbacks intentionally throw if called                                                                                                    |
| External ZIP only → empty Host → new save                               | PASS                                | Downloaded ZIP supplied as File to a new browser process with a new empty origin profile. Same selected native hash/live sources/plans; next save retains all old envelopes/hashes and original bytes; no OPFS or original cache carried over                                           |
| Bounded original leases                                                 | PASS                                | Whole external-archive arrayBuffer deliberately throws; actual reads max65536 bytes. Oversize range/cap rejects; release clears maps and rejects retained/late-read operations. Already-returned immutable Blob slices remain consumer-owned, not revocable                             |
| Failed external replacement                                             | PASS                                | Actual #194 Open input receives invalid ZIP; previous native hash/live original remains. Screenshot inspected: explicit failure status and original two-clip42251/600 timeline retained                                                                                                 |
| v0 dispatch and Host separation                                         | PASS                                | External opener reads v0, v1 factory refuses without live-map mutation; no silent migration                                                                                                                                                                                             |
| Full retained closure                                                   | PASS                                | Selected empty native still retains parent-only interpretation and original in next archive                                                                                                                                                                                             |
| v1 browser suite total                                                  | PASS,6 groups/3 processes/errors0   | Synthetic131089-byte original; no146MB admission/codec claim                                                                                                                                                                                                                            |
| Prior v0 verifier/oracle                                                | PASS,14 groups/errors0              | Exact reviewed Node-base archive bytes and malformed verdicts unchanged; real40MiB retained-original/browser download/reopen, malformed hashes/parents/cycle/interpretation/schema rejected                                                                                             |
| Prior actual v0 coordinator integration                                 | PASS,6 groups/2 processes/errors0   | 40MiB retained original; captured revision/live edits; exact unknown/no-write settlement; controlled restart and new save                                                                                                                                                               |
| Capture ownership                                                       | PASS,5 groups/errors0               | Captured-head stale owner refuses; live/Undo resource B retained after normal A commit and unknown→committed; settled references released                                                                                                                                               |
| Scratch recovery                                                        | PASS,12 groups/27 processes/errors0 | Includes extra process restart after durable refusal fence; no-write replay reads0 chunks; exact old candidate/native/original preservation                                                                                                                                             |
| Receipt forget race                                                     | PASS,1 group/errors0                | Late verified reconcile cannot reinsert forgotten receipt                                                                                                                                                                                                                               |
| Related units                                                           | PASS,233/14files                    | Core/v1/PCM, portable/storage, media workflow and real draft2/schema-edit save regressions                                                                                                                                                                                              |
| Root lint/typecheck/build/file policy                                   | PASS                                | No lint warnings; fixed Office-font verification included                                                                                                                                                                                                                               |
| Journal-only browser runner                                             | NOT RUN on this source              | Journal implementation unchanged; prior14-group evidence stays pinned to #188. Journal paths exercised by scratch/coordinator regressions above                                                                                                                                         |
| Actual146MB original and codec/export/playback, full product/mobile E2E | NOT RUN                             | Referenced actual file absent here; Video owns next integration and media acceptance                                                                                                                                                                                                    |
| Power-loss/OS crash, performance, CI, main merge/release                | NOT RUN                             | Holds maintained; browser restarts are controlled, not crash certification                                                                                                                                                                                                              |

No failing author run occurred for the new functional gates. The initial exploratory
browser run `/tmp/video-v1-first` had6 PASS; unit development58/5files and new-only12
also passed. These are not relabeled as the final exact-source results. Historical
#181/#184/scratch failures remain preserved in their existing reports.

## Reproduction

```sh
node packages/video-metadata/file-backed-storage/integration/v1-check.mjs /tmp/video-portable-final-v1
node packages/video-metadata/file-backed-storage/browser-verifier/check.mjs /tmp/video-portable-final-v0-verifier
node packages/video-metadata/file-backed-storage/integration/check.mjs /tmp/video-portable-final-v0-integration
node packages/video-metadata/file-backed-storage/integration/capture-review-check.mjs /tmp/video-portable-final-capture
node packages/video-metadata/file-backed-storage/integration/scratch-check.mjs /tmp/video-portable-final-scratch
node packages/video-metadata/file-backed-storage/integration/forget-review-check.mjs /tmp/video-portable-final-forget
npm run lint
npm run typecheck
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/host-media/file-source/rational-v1.test.ts packages/video-core/src packages/video-core/experiments/pcm-renderer packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run build
npm run check:files
```

Logs are `/tmp/video-portable-final-*.log`. Each runner creates an exclusive output
folder; reports/profile/archive/notice/bundle/screenshot evidence remain outside Git.
The digest remains approved @noble/hashes1.8.0 with complete MIT notice and installed
input/bundle provenance; no registry tarball attestation is implied.

| Report                                                  | SHA256                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-portable-final-v1/results.json`             | `8c43fd7ba53b9382cb8327928f85feb257999652656f225134acf33ee36bb457` |
| `/tmp/video-portable-final-v0-verifier/results.json`    | `cf2cbcda0a21b77b8eff26312fc9944d77d3c212704912ed953aa44ada5855e4` |
| `/tmp/video-portable-final-v0-integration/results.json` | `db75de77a095c6b73c343937acac3a68027277f017b50b17cf02e9612c377c72` |
| `/tmp/video-portable-final-capture/results.json`        | `acd758b1d045002e5bc5ff49a28068bbcbef59f59f12f79146722e8757e8f682` |
| `/tmp/video-portable-final-scratch/results.json`        | `0a133fa133db0ce7c8ba38351ba9b6a90285cca3aaabc80d113c7d48abe475b9` |
| `/tmp/video-portable-final-forget/results.json`         | `6f313511eaa62aec1e9712ebd7f1ce9f998fab1887b1b04129466a8617e74337` |

See [the exact adapter handoff](V1-HANDOFF.md) for constructor/ports, version mapping,
consumer lifetime, namespace allocation and budget responsibilities. The actual
original missing locally is a remaining integration blocker, not a reason to claim
synthetic fixture acceptance covers146MB. No private source bytes were uploaded.

## Limited-GO follow-up: semantic refusal with valid hashes

The parent reports limited GO from both independent #196 storage reviewers for the
original runtime/source `d3702f7f470890b971334dc4e7281e104a2714f6`. That exact
runtime and its original results above remain unchanged.

Focused test-only source **`2f7e1b430930845fec66b0b9a654481627baf3ae`** adds four
negative wire archives: selected/retained native × noncanonical rational/invalid
audio presentation window. Each native contentHash is correctly recomputed; the
selected capture hash is updated when applicable; envelope filename SHA, manifest
references and ZIP CRC/SHA are rebuilt. The test independently reads the resulting
ZIP and verifies every entry checksum/name hash, every native contentHash and the
selected capture hash before asserting the specific semantic rejection:
`Invalid canonical time` or `Invalid audio presentation window`. Thus these refusals
cannot be attributed to a stale contentHash or broken outer ZIP checksum.

At this exact test source: v1 suite16 PASS, all storage suites65/5files PASS,
focused ESLint PASS and root typecheck PASS. No failing run. No new browser/build
rerun is claimed for this test-only change; earlier233-unit/browser/build results
stay scoped to the original runtime SHA. Runtime, schemas and lifecycle contracts
were not modified. Commands:

```sh
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage
./node_modules/.bin/eslint packages/video-metadata/file-backed-storage/portable/v1.test.ts
npm run typecheck
```

| Focused log                             | SHA256                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-v1-semantic-final-unit.log` | `4a98071a1713f0302f7c49793a6ea5d3eed43d76ac92269afd1170824f2d8bd7` |
| `/tmp/video-v1-semantic-final-lint.log` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/tmp/video-v1-semantic-final-type.log` | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
