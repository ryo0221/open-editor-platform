# Port/fixture verification

Tested clean code pin: `5dca1b102a0478ea83635c33966d9ed96d53687a`.
Scope: isolated private adapter/fixture, not real M2 mixer/consumer/Host adoption.
Accepted #215 runtime391edb1d/docscfe0ccd6 and #232 plan90775f14 stay unchanged.
All changed paths are in `packages/video-core/experiments/pcm-wasm-m2-fixture`.

| Check                                                               | Result at tested pin                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen #222 numerical closure                                       | PASS, 15 original files plus facade; original/frozen hashes and regeneration checked. Manifest SHA256 `3c00df6ecc6946f8c1e82779d1c48e8a01db2eb882c716ff43e33d4e8a4c22a5`.                                                                                                                               |
| Fixture bundle + forced Node execution                              | PASS, 10 named groups. JS/forced WASM raw source and whole mix bits; three resident sources, fade/chunk/cut/endpoints, owned result lifetime, late decode drain, port transfer abort/disposal, final guard order, forced missing-module/shared-budget refusal, zero reservations after module disposal. |
| Backend proof                                                       | Node24.19.0 / V813.6.233.17-node.51. Each forced source reports WASM, fallbackfalse, completedRequests and positive invocations; reviewed SHA256 `142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`.                                                                                    |
| Official offline kernel build                                       | PASS, Rust1.90.0 compiler1159e78c4 / LLVM20.1.8; clean source pin in manifest, 4972bytes, reviewed hash unchanged. Installed-file/toolchain proof and license notices retained.                                                                                                                         |
| Root TypeScript                                                     | PASS.                                                                                                                                                                                                                                                                                                   |
| Focused ESLint and file policy                                      | PASS, 1821 files checked.                                                                                                                                                                                                                                                                               |
| Existing focused regression                                         | PASS, 10 tests/3 files: v1 session4, native playback drain5, R0 oracle provenance1.                                                                                                                                                                                                                     |
| Product build, full root/kit/legacy, browser, real originals/output | NOT RUN; this is a fixture-only successor with no real consumers changed. Prior acceptance is not relabeled.                                                                                                                                                                                            |
| R0 raw kernel edge matrix/browser                                   | NOT RUN anew; kernel unchanged. Separate accepted raw-kernel evidence remains at its original pins. This fixture's final guard controls are not raw kernel tests.                                                                                                                                       |
| Performance                                                         | NOT RUN, held.                                                                                                                                                                                                                                                                                          |

Commands are in README. Fresh evidence: `/tmp/m2-pcm-final-fixtures/results.json`,
`/tmp/m2-pcm-final-kernel/manifest.json`, `/tmp/m2-pcm-final-*.log`; durable local
copies under `/workspace/m2-pcm-fixture-evidence/`, outside the repository. The
fixture and official build independently record tested commit and empty dirty
state. Raw generated bundles, notices and test logs are not tracked in Git.

Retained failures: first development fixture executed eight groups successfully
but failed teardown by calling nonexistent `ModulePin.release` instead of
`dispose`; this was not a passing run. First typecheck also caught that error and
missing narrowing of dynamic diagnostic keys; first lint caught undeclared Node
process/console imports. Logs `m2-pcm-fixture-first.log`, `m2-pcm-type-first.log`,
`m2-pcm-lint-first.log` are retained in the evidence directory. Corrections changed
only new fixture files. A failed local edit-script substring match was corrected
before the final transfer-race fixture commit; no accepted source changed.

The execution transport disconnected while final commands were active and
returned transport errors. After successful shell reconnection, the clean HEAD,
complete result/manifests/logs and absence of remaining test processes were
checked directly. Final result records show all ten groups passed; regression
log shows10/10; chained type/lint/file checks reached the final no-failures file
report. No healthy process was restarted. No recovery claim relies on task status.

Owner agreement for the proposed Video-owned lease/reservation seam remains
pending in the linked coordination threads. Proposed mix/output ceilings and
all-resident-source worksheet are review inputs only. Real adoption requires
owner agreement, complete resident/cache/native overlap inventory and release
chain review against the eventually reviewed combined Host pin. #230's accepted
capacity candidate does not itself certify that composition. CI/manual-only,
main/release/publication/license/security holds remain intact.
