# Corrected scope verification

Clean tested code **7683c3fa4a730064786ced23547869fbbf71dd7c**.
No production consumer, codec, numerical, default or cap changes.

PASS at this pin:

- Ten manual fixture groups: nine actual Mediabunny resource/source lifecycle
  groups and the corrected managed-ledger envelope/refusal control. The accepted
  codec heap is no longer inserted into the managed ledger control.
- Root typecheck, focused directory lint, file policy1837 files, private bundle.
- All73 pinned package-file hashes and exact excerpt lines verified before import.
- Shipped AAC bundle/WASM identity verified; generated inventory matches the tracked
  [JSON evidence](library-evidence/aac-inventory.json), including exact memory-section
  offsets/hex. No worker or codec WASM was instantiated.

Node24.19.0 / V813.6.233.17-node.51; results record exact commit and clean tree.
The source fixture manifest hash remains
`23fbd02f635ca5f4acd06cea41f9ebff0d69558cb8b13a75b99c69dc0b5c17fa`.
Raw evidence is `/workspace/m2-real-library-scoped-evidence/` and
`/tmp/m2-real-library-scoped-final/`, outside Git. Reproduce with the commands in
[REAL-LIBRARY-VERIFICATION.md](REAL-LIBRARY-VERIFICATION.md), using fresh output.

The previous38 regression tests remain PASS at0cfef80f; NOT RUN again for this
scope-only correction. Browser/actual AAC worker/media/production tests, full root
suite and benchmarks NOT RUN. Independent review of #237 is still required.

Earlier exact-pin results and raw failures are preserved. The prior oversize
control only proved arithmetic admission refusal; its policy interpretation was
wrong because it expanded the accepted ledger scope to total codec memory.
The cap-decision request and codec-size non-fit claim are withdrawn, not relabeled
as passing acceptance. The new control fits6964984 bytes of stated managed overlap,
then adds an idle JS arena to7622392 and verifies another1MiB managed cache refuses
without releasing existing owners. Codec initial/minimum/max values remain true
but belong to the separate inventory. See [scope derivation](PCM-BUDGET-SCOPE.md)
for conditions, aliases and unresolved composition lifetimes.

Known managed terms fit the unchanged8MiB under stated admission conditions;
arbitrary simultaneous old leases/caches/jobs may refuse. That is an ownership
and scheduling verification gate, not a demonstrated need for higher caps or a
new codec. #233 two-source-review GO and pending exact-pin legacy/kit gates do
not change this budget's scope. All existing CI/performance/main/release holds remain.
