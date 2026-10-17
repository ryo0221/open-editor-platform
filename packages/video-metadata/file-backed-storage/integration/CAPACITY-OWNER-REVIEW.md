# Direct-owner capacity review correction

Capacity gate remains HOLD pending independent review of this correction. Author
verification does not lift that hold. This supersedes the initial #205 ownership
coverage; it does not erase the initial report or adopt a new budget.

## Confirmed defect and correction

The private direct constructor permits two storage owners with the same journal
namespace/operation ID and different scratch namespaces. Normal factory locking
avoids this interleaving, but the supported constructor did not forbid it.

At runtime `a2f28f7c1887e36459984d915d75df46662f86a4`, the new regression paused A
after its durable reservation and before scratch file creation. B's duplicate
reserve failed, then its existing no-write cleanup settled the shared ID. The
capacity ledger examined A's absent file/candidate and wrongly removed A's3106
reserved bytes. A third3000-byte reservation was admitted. This confirms premature
release and loss of the promised reservation; the journal fence still prevents A's
commit. No archive corruption or measured physical-disk peak is claimed.

The fix requires the **exact original scratch file path and operation identity**
for both candidate attachment and settlement. All normal cleanup, reconcile and
recovery call sites pass the path from their own durable ScratchRecord. B cannot
mutate or release A's reservation even when both files are absent. A's own later
reconcile can settle the fenced no-write. Cold recovery uses the existing durable
path, not a volatile owner token; no persisted schema migration is needed.

## Exact evidence

- Base before correction: `a2f28f7c1887e36459984d915d75df46662f86a4`.
- Final tested correction: `38bdc343e5d2be276b92170e5302229f969d0cc2`.
- Before browser reproduction used the old runtime unchanged and modified only the
  two regression harness/runner files; the report records that dirty status.
- Final browser runs recorded a clean source tree. Linux/Node24.19.0 and
  Chromium151.0.7922.173; synthetic files only.
- A later docs-only commit adds this report. Exact final HEAD is in the PR/handoff.

| Requirement                                                                | Evidence                                                                                                                           | Result          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Reachability on old direct constructor                                     | `/tmp/video-capacity-owner-before2/results.json`: A3106 reserved -> B cleanup0 -> third reservation admitted                       | FAIL reproduced |
| Reject foreign owner attachment/release before any file exists             | CAP07 unit: same journal/ID, even a different file within the same scratch namespace; foreign candidate and settlement both refuse | PASS            |
| Preserve reservation through real duplicate-owner cleanup                  | CAP-B08 browser: A paused after reserve; B actual storage write/cleanup; A reservation unchanged and third refused                 | PASS            |
| Allow original owner to finish settlement                                  | CAP-B08 resumes A; its exact no-write reconcile releases reservation; CAP07 close/reopen exact-path settlement                     | PASS            |
| Earlier capacity scenarios                                                 | Capacity browser suite now9 groups, all PASS, no browser errors                                                                    | PASS            |
| Existing v1 scoped save/reconcile/import                                   | 8 browser groups,4 launches, no browser errors                                                                                     | PASS            |
| Related unit suite first run                                               | 245 tests:244 pass, existing archive F01 exceeds5-second timeout; later Python zipfile read reports FileNotFoundError              | FAIL retained   |
| Same unchanged unit command after other checks finish                      | 245 tests/15 files, unchanged timeout/config                                                                                       | PASS            |
| Root lint/typecheck/build/check:files                                      | exit0 on corrected source                                                                                                          | PASS            |
| v0/scratch browser rerun at this correction                                | Prior6/12 group evidence remains at e7861e7d; not repeated for this opt-in ownership guard                                         | NOT RUN         |
| Normal Host/mobile/combined actual originals/physical pressure/performance | Unchanged scope and limits from initial report                                                                                     | NOT RUN         |

The unit timeout occurred while browser/build checks were also running. Contention
is a possible explanation, not a proven cause. No timeout increase, performance
tuning or source change was made to obtain the subsequent pass. The initial new
runner also exited on a pending page.evaluate rejected during failing-test cleanup;
that harness failure was corrected to retain the baseline report, then the old
runtime defect was reproduced in `before2` above. Neither failure is hidden.

## Commands

```sh
node packages/video-metadata/file-backed-storage/integration/capacity-check.mjs /tmp/video-capacity-owner-final
node packages/video-metadata/file-backed-storage/integration/v1-check.mjs /tmp/video-capacity-owner-v1-final
./node_modules/.bin/vitest run --no-file-parallelism packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/host-media/file-source/rational-v1.test.ts packages/video-core/src packages/video-core/experiments/pcm-renderer packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run lint
npm run typecheck
npm run build
npm run check:files
```

The unit command was run twice, preserving first failure and later pass logs.
No normalHost files, dependency, archive format/hash semantics, capacity numbers,
GC, main or workflow setting changed. [Host handoff](CAPACITY-HANDOFF.md) documents
the strengthened private ownership parameters. Independent review is still needed.

## Raw evidence hashes

| Local evidence                                    | SHA256                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-capacity-owner-before2/results.json`  | `9b2b72ee0a4b60af11b63d9a75e9f17db936a04d593a5a04019d91235ad9be79` |
| `/tmp/video-capacity-owner-final/results.json`    | `d5c60f02318771e0256adf5aa8e32dca8c717174c291d963f5e5d5bbc4b5378e` |
| `/tmp/video-capacity-owner-v1-final/results.json` | `5b5293ac2d9d2afb93ca4746fa9fc1db6b22c917fb2c6240f0e7e4b78ba1ab05` |
| `/tmp/video-capacity-owner-final-unit.log`        | `080064d97439ddfd669b9fb7dd95b89c3bf8c382626a117ab9c9b60d447d20c8` |
| `/tmp/video-capacity-owner-serial-unit.log`       | `5901efe9fd334b8a1a692428537b7e9516915604ae161da44fbfe05ecf522d74` |
| `/tmp/video-capacity-owner-final-lint.log`        | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-capacity-owner-final-type.log`        | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-capacity-owner-final-build.log`       | `291bf387299efb14d7c44fe7dc3cd2fb0062b58d4adb3e1d86bb6daca4866f71` |
| `/tmp/video-capacity-owner-final-files.log`       | `c5b115ae64b3139f6c40d856608ea97018b7ac1ee842b93e1c3cd9815d01df1b` |
