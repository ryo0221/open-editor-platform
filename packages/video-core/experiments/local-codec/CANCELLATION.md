# Deterministic unfinished-work cancellation follow-up to #158

Exact tested code: **0e421c020720566d812c2cc5a126632b54e9e6a2**.
Base: **6433aa95d7be7c2628b34ffffef187ec2328c545**; no bridge/binary changes.

The previous test established notification → termination request → new-worker
recovery only: its entire synchronous workload could finish before the parent
received `started`. LIFECYCLE.md now explicitly restricts that historical claim.

The new worker decodes exactly one step, asserts non-EOF, and installs a message
handler that requires an explicit parent grant before any further decode. The
armed message reports unfinished state (code 0, one step, five handles, zero grants
and zero publications). The parent never grants before cancelling or terminating.

- PASS: three terminations while unfinished work awaits a parent grant.
- PASS: three cooperative cancels, repeated close, zero handles. A late grant is
  delivered after cancellation; a FIFO barrier acknowledges it was ignored, with
  zero decode grants and zero late publications. This checks messages after the
  cancellation acknowledgement rather than assuming absence from an early return.
- PASS: new-worker decode hashes equal the warm full-decode hashes.
- PASS: existing 14 fault/cancel/bounds cases and 16 fault/reopen cycles; occupied
  allocator bytes return to warm 144 (resource accounting, not performance).
- PASS: root typecheck, lint, build, file policy and 54 Video Core tests.

This proves cancellation at a bounded host/decoder chunk boundary. C instruction
interruption and independent measurement of terminated-worker memory reclamation
are NOT RUN, not implied. No production admission, shared API, dependency, license,
Actions or performance changes. #162 remains unchanged.

Binary pins remain wasm `53ad16cccae8fcafc5fa422fd9a520f79d77ae2bf598e80f55b39d50bbeca7d4`,
JS `ffe5d5c9c82571a645db0b35e9bd8fe62641ceda67adaed50f27e639614efa58`.
Raw proof: `/tmp/video-cancel-handshake-final/{raw,cancellation,results}.json`.
Reproduce with the LIFECYCLE.md command and a fresh output directory.
