# Consumer ownership fixture verification

Tested clean code **de0027294678310f847e4448fb83b840fd06ea49**. This successor
adds isolated consumer ownership fixtures after accepted #234, not real M2/Host
connection. #234 code5dca1b10/docs2817648e and #215 remain intact.

| Check                                                  | Result at tested pin                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated consumer ownership                            | PASS28 tests. Cumulative owner/realm limits, four resident-source inventory plus coexisting v1/staging/unreleased outputs, full backing aliases, separate source/mix leases, mix failure cleanup, hash/skip lifetimes, native ended/close and setup failures, export add + consumer proof, transfer and cleanup failures. |
| Accepted focused regressions                           | PASS10 tests: source session4, native playback drain5, original R0 oracle provenance1. Total38 tests/4 files passed.                                                                                                                                                                                                      |
| Existing frozen M2 JS/forced-WASM fixture              | PASS10 groups, same-runtime raw source + mixed bits. Successful forced conversions explicitly require completions>0 and completions==invocations; backendWASM/fallbackfalse/hash retained.                                                                                                                                |
| Typecheck                                              | PASS root TypeScript.                                                                                                                                                                                                                                                                                                     |
| Lint/file policy                                       | PASS focused directory ESLint and repository file policy.                                                                                                                                                                                                                                                                 |
| Oracle integrity/private bundle                        | PASS frozen source regeneration/hash check and esbuild fixture bundle. Numerical sources unchanged.                                                                                                                                                                                                                       |
| Kernel/toolchain                                       | Reused accepted official build `/tmp/m2-pcm-final-kernel`, produced at5dca1b10 with verified official Rust1.90.0/toolchain/license provenance. Reviewed WASM hash checked at runtime. Kernel rebuild NOT RUN anew; no kernel/build/dependency change.                                                                     |
| Full product build/root suite/kit/legacy/browser/media | NOT RUN. Controlled native ports are not real M2 consumer verification or normal Host acceptance.                                                                                                                                                                                                                         |
| Performance                                            | NOT RUN; remains held.                                                                                                                                                                                                                                                                                                    |

Forced fixture records empty working tree and exact tested commit, Node24.19.0 /
V813.6.233.17-node.51, reviewed module SHA256
`142871dcfdb24035b228f42ae72a369f6fb389d9b179a13512ae0053901a6bca`, positive equal
kernel invocations/completions per successful forced source. Zero kernel completion
cannot pass by falling back. Cancellation-only cases do not claim completed output.
Frozen numerical manifest remains
`3c00df6ecc6946f8c1e82779d1c48e8a01db2eb882c716ff43e33d4e8a4c22a5`.

Commands:

```sh
npx vitest run packages/video-core/experiments/pcm-wasm-m2-fixture/consumer-ownership.test.ts packages/video-core/experiments/pcm-wasm-v1/session.test.ts packages/video-core/experiments/pcm-wasm-v1/playback-drain.test.ts packages/video-core/experiments/pcm-wasm-r0/oracle.test.ts
node packages/video-core/experiments/pcm-wasm-m2-fixture/check.mjs /tmp/m2-pcm-final-kernel/pcm.wasm /tmp/m2-consumer-final-forced
npm run typecheck
npx eslint packages/video-core/experiments/pcm-wasm-m2-fixture
npm run check:files
```

Use a fresh external output path on rerun; original evidence must not be overwritten.
Raw evidence under `/workspace/m2-consumer-fixture-evidence/` and corresponding
`/tmp/m2-consumer-final-*` paths remains outside Git. Prior #234 evidence is retained.

Retained failure: first consumer run **23PASS/1FAIL**, due to a handwritten expected
peak8263736 that did not match the actual listed allocations. The actual total is
7896312, independently summed in CONSUMER-CONTRACT.md. Correcting that assertion
changed no ledger or release behavior. `/tmp/m2-consumer-first.log` and its durable
copy retain the failure. Four additional consumer tests were then added; final
28/28 and full focused38/38 pass at the clean pin above. No timeouts, caps, policies
or test exclusions were relaxed.

Intentional conservative retention is a tested outcome, not an unnoticed leak:
when export consumersDone rejects, the owner remains charged256 bytes after add
settlement and sample.close. No proven consumer drain exists, so close cannot zero
it. Likewise rejected/unknown native close retains until ended. Real integration
must provide genuine completion proof; fake fixture signals cannot certify a
worker/encoder/native release chain.

The Video owner's conditional contract direction is acknowledged. 64KiB/256KiB
remain provisional upper-bound design targets within8MiB. The representative
worksheet is not full real source/index/cache/worker memory measurement. Real M2
and normal Host stay unchanged pending this contract/fixture review and the
independent #233 catalog-isolation/final integration gates. No quota/default/cap,
rounding/numerical/public API, CI, benchmark, main/release/publication or license
change.
