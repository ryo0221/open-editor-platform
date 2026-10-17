# #165 lifecycle correction (separate from DSP/source-edge policy)

Exact tested code: **44d5025bd0fcbe73052b5549ec529dd3b568f957**.
Base: #165 evidence HEAD **5462816803c8d6e314ba362102bcb91a619823b0**.
The original #165 branch remains unchanged; no boundary-policy or product-path
integration is included in this small correction.

## Session ownership

The new generation/controller is installed before notifying the previous owner's
abort listeners. The caller signal is subscribed before notification. After that
callback boundary, and before decode and publication, the session checks caller
abort, owned signal, disposed state, generation and active-controller identity.
Dispose clears active ownership before invoking listeners. An outer stale call's
finally block cannot clear a newer request's owner.

Three direct regressions use the actual session and DSP with a controlled DecodePort:

- Old abort listener starts render(200) while outer render(100) supersedes render(0).
  Only 0 and 200 decode; 200 succeeds, 100 refuses before allocation, and late 0
  cannot publish. Previous implementation decoded 0 → 200 → 100 and rejected 200.
- Old abort listener disposes: outer 100 never starts a decoder.
- Old abort listener aborts the outer caller: outer 100 refuses before decode.

All three failed before the fix (`/tmp/pcm-session-before.log`) and pass at the pin.
These are deterministic lifecycle tests, not claims about codec interruption.

## Native ownership after await/resource acquisition

The adapter rechecks cancellation/error state after each await and immediately
before/after resource acquisition/configuration. Cleanup no longer has a global
one-shot `closed` shortcut. It re-examines the current decoder every time and tracks
input disposal separately, so a resource acquired after synchronous cancellation
inside its constructor is closed by final cleanup.

`native-lifecycle-check.mjs` bundles the actual native-aac.mjs source and actual
WindowCollector. Input, timing metadata and AudioDecoder are deterministic stubs.
The browser's actual microtask queue orders cancellation after the abortable wrapper
resolves but before the adapter's await continuation. This is an adapter control-flow
probe **with stubbed codec**, not a native AAC decode success.

| Cancellation point                    | Created / closed decoder | Other required evidence                            |
| ------------------------------------- | ------------------------ | -------------------------------------------------- |
| Input constructor                     | 0 / 0                    | input created/disposed exactly once, no track read |
| Track result                          | 0 / 0                    | no config query after cancellation                 |
| Config result                         | 0 / 0                    | no support query after cancellation                |
| Support result                        | 0 / 0                    | no decoder created after canceled await            |
| Decoder constructor before assignment | 1 / 1                    | never configured                                   |
| Decoder configure                     | 1 / 1                    | no packet sink/read                                |

All six PASS at the pin. Input disposal is exactly once in every case. Before the
fix the support-result and decoder-constructor probes reproduced created=1/closed=0
(`/tmp/pcm-native-lifecycle-before/results.json`); those failures are retained.

## Exact-pin gates

- PASS: 3 new session lifecycle tests, 11 existing renderer tests, 54 Video Core tests.
- PASS: 6 deterministic browser microtask/resource-owner cases above.
- PASS: separately, all 4 **real native AAC** window/seek/cancel/fractional-end cases.
- PASS: root typecheck, lint, build and file policy.
- NOT RUN: new public API/product integration, full repository regression, physical
  boundary filtering, practical indexed seek, file-backed bundle, audio MP4 export,
  iPhone/Windows, HDR, performance. No C-instruction interruption claim.

Raw evidence: `/tmp/pcm-lifecycle-final-*.log`, `/tmp/pcm-native-lifecycle-final/`,
`/tmp/pcm-lifecycle-real-aac-final/`. Both browser outputs record exact code and a
clean working tree. Generated evidence stays outside Git. No shared code, dependency,
license, main push, merge, release, Actions enable/dispatch or performance changes.
Review of this correction is required before treating #165 lifecycle as accepted.
