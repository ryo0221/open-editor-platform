# Total-capacity candidate verification

**Review follow-up:** direct-owner reservation release was reproduced on the initial
HEAD. See [ownership correction and current evidence](CAPACITY-OWNER-REVIEW.md).
Correction tested at `38bdc343e5d2be276b92170e5302229f969d0cc2`; capacity gate remains
HOLD pending independent review. The results below are the initial checkpoint.

Status: author-tested private adapter, pending independent review and Host policy
selection. No normal Host adoption, budget increase, GC or release approval.

- Accepted integration base #198: `3b45be9f53e7a32c881f226cd0e5a44728fc449e`.
  Initial inspection used #199 `ea00e2d3e30907b360a44a52b4452aad0de695cf`;
  storage-owned files were identical at the accepted integration checkpoint.
- Tested runtime/tests/docs: `e7861e7d96931c793c3f736522d85c9ecf5be6fe`.
  All final browser reports recorded an empty source-tree status.
- Main observed unchanged: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
- Linux, Node24.19.0, Chromium151.0.7922.173. Synthetic files only. All archives,
  profiles, screenshots, bundles and raw reports remain under `/tmp` outside Git.
- This report is a later documentation-only commit. Runtime/test files were not
  changed after the tested commit. Final PR HEAD is reported in the handoff.

## Requirement-to-evidence matrix

CAP IDs describe this capacity task, not a claim that unrelated Editor acceptance
or M2 media/profile gates have passed. Existing storage F05/F07/F09 are the related
quota, uncertain-write and bounded-input requirements.

| ID / requirement                                                                  | Functional evidence                                                                                                                                                                                                  | Result  |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| CAP01 / F05,F09: count old namespaces and both new copies before allocation       | CAP01 unit; CAP-B01 real save plus unknown closed namespace; CAP-B02-total no-write with no scratch chunks/files                                                                                                     | PASS    |
| CAP02 / F05: concurrent owners cannot over-reserve                                | CAP02 unit; CAP-B06 two independent pages race and fresh browser process retains unresolved reservation; CAP-B07 real held save blocks competing owner, then fresh operation succeeds after settlement               | PASS    |
| CAP03: materialization replaces reservation, committed files remain counted       | CAP03 unit; CAP-B01, CAP-B03 real journal files                                                                                                                                                                      | PASS    |
| CAP04 / F07: no-write/unknown/cleanup evidence controls release                   | CAP04 unit; CAP-B03 lost commit acknowledgement then same-owner reconcile; CAP-B04 interrupted cleanup remains unknown until existing authorized recovery; CAP-B05 mid-write journal failure is fenced and accounted | PASS    |
| CAP05 / F09: explicit policy, bounded scan and fail-closed behavior               | CAP05 unit rejects mismatch/NaN/depth/entry overflow; CAP-B02-journal refuses before scratch under unchanged journal cap                                                                                             | PASS    |
| CAP06: reject reused/existing reservation identities and oversized credited files | CAP06 unit                                                                                                                                                                                                           | PASS    |
| Existing v1 portable and same-owner recovery                                      | v1-check8 groups,4 browser launches; retained fractional content/hashes, parent-only original, invalid replacement protection, bounded external reads, pending-close refusal and same-owner reconcile                | PASS    |
| Existing scratch recovery/fences                                                  | scratch-check12 groups,27 launches; interrupted phases, foreign/missing/corrupt state, old journal upgrade and same-process coordinator settlement                                                                   | PASS    |
| Existing v0 coordinator/storage                                                   | check6 groups,2 launches; retained40MiB synthetic original, edit after capture, no-write, unknown/reconcile, fresh process restore and next save                                                                     | PASS    |
| Related unit regression                                                           | 244 tests /15 files, serial file execution                                                                                                                                                                           | PASS    |
| Root lint/typecheck/build/check:files                                             | Commands below, exit0                                                                                                                                                                                                | PASS    |
| Normal Host usage UI / mobile / accessibility / actual media combined portable    | No wiring or rendering capability added; existing caps still block combined originals                                                                                                                                | NOT RUN |
| Browser power loss, physical-disk exhaustion or backing-file overhead             | Controlled context/process close and injected exceptions only                                                                                                                                                        | NOT RUN |
| Performance/capacity guarantees, other browsers/devices                           | Not measured or certified; performance hold maintained                                                                                                                                                               | NOT RUN |
| Archive GC, native/Undo pruning, M2 portable schema dispatch                      | Outside this slice; no implementation/adoption                                                                                                                                                                       | N/A     |

The newly added browser suite has8 groups. Error events/console errors were empty.
v0 before/recovered and v1 external-reopen screenshots were inspected. The v1
screenshot intentionally shows Archive budget rejection for the invalid
replacement fixture; the previous native remains available. These screenshots do
not certify a new capacity UI.

## Failures retained

Two development runs failed the CAP-B07 fresh-retry assertion because the test
budget used a baseline ZIP size from a shorter owner/operation identity. The real
captured archive was7 bytes larger, so three copies needed21 more bytes. Storage
correctly returned fenced no-write before scratch; no runtime fix was needed.
The synthetic test allowance was corrected while still allowing only one active
two-copy reservation, and the final run passes. Raw failed reports remain at
`/tmp/video-capacity-dev2/results.json` and `...dev3/results.json`, hashes below.
No earlier #198/#199 failures or limitations are erased by this report.

## Reproduction

```sh
node packages/video-metadata/file-backed-storage/integration/capacity-check.mjs /tmp/video-capacity-final-browser
node packages/video-metadata/file-backed-storage/integration/v1-check.mjs /tmp/video-capacity-final-v1
node packages/video-metadata/file-backed-storage/integration/scratch-check.mjs /tmp/video-capacity-final-scratch
node packages/video-metadata/file-backed-storage/integration/check.mjs /tmp/video-capacity-final-v0
./node_modules/.bin/vitest run --no-file-parallelism packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-metadata/host-media/file-source/rational-v1.test.ts packages/video-core/src packages/video-core/experiments/pcm-renderer packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit/save.test.ts
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Use fresh output directories. Digest implementation remains the existing locked
@noble/hashes1.8.0 with the complete MIT notice; browser reports include installed
input-to-bundle provenance. No dependency or registry-byte attestation was added.

| Evidence                                         | SHA256                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `/tmp/video-capacity-final-browser/results.json` | `7dcb044857fb55c0eb3bec0211090898f983c78c7ad085200275b21710fa72c3` |
| `/tmp/video-capacity-final-v1/results.json`      | `62b5fb88c2026b0679a95aa6af7bb623505a523d38127110e9641831bf038cad` |
| `/tmp/video-capacity-final-scratch/results.json` | `c83bd96b55a50f9a48daef95cdbc1ad24f5bf01d961c670d93a9d0b9a560a2e9` |
| `/tmp/video-capacity-final-v0/results.json`      | `e6b264c9420caaaf5124afb3e81c433e48587dcc4e01928557dd17c68541feb8` |
| `/tmp/video-capacity-final-unit.log`             | `59a7f71291fcf1b8155185a9eecb477f0f1da8796c964b35244011a386d354c3` |
| `/tmp/video-capacity-final-lint.log`             | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-capacity-final-type.log`             | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-capacity-final-build.log`            | `40c22b55ced8ad985c5358a2b25831067bf1c7a08e2a88745e0423e413b07419` |
| `/tmp/video-capacity-final-files.log`            | `a1e02d6bb6f62187f6c8ce01c54e3a7994a936117645c0ebc5b5edaa906ece06` |
| `/tmp/video-capacity-dev2/results.json`          | `f4c346affbca31aa6159041158f15ef0656efecd6728c0bb41a3fb08fc085d96` |
| `/tmp/video-capacity-dev3/results.json`          | `e763686c7bedb8df0114908e4cfceb13a4588d9d28286ec4d44718b06581939d` |

## Remaining integration decisions

See [CAPACITY-HANDOFF](CAPACITY-HANDOFF.md) for the explicit Host policy and usage
adapter. Normal Host must choose numeric policy, ensure every active writer
participates and own lifecycle/usage display. No new default is chosen here.
The candidate accounts logical OPFS bytes plus Host management allowance, not
exact browser/OS physical usage or memory. Unknown reservations do not expire.

Future archive retirement needs separate evidence/lease semantics and user
confirmation. M2 Storage dispatch awaits exact reviewed native/import profile
pins; #204 native work is coordinated separately through #75. The current
scratch/external256MiB and journal1GiB integration policy is unchanged.
