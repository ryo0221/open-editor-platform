# #170 review corrections

Tested code **729914304f83ca769c367c33052f9f9129679f61**; base #170
**e7519245693d7da90c743ce9f59a1be88a6c7042** remains unchanged. This branch contains
only the two private implementation corrections, one focused test file and this
record. The browser journal candidate is a separate workstream, not included.

## Reproduced defects and decisions

- R01: rename A completed while its replace acknowledgement remained pending.
  Previously reconcile released A's ownership early, and late A success/rejection
  could clear newer state or dereference missing pending.receipt. New contract:
  **reconcile during an in-flight replace returns unknown and keeps the claim**;
  B is Busy until A's promise settles. A captures its own attempt/receipt and only
  clears state it still owns. Late rejection retains A's genuine unknown lock
  until correlated file verification; late success settles A. Then B can save.
  Both delayed success and rejection tests follow A → inspect → attempted B →
  late A → settled B, checking A's receipt and B's final native operation identity.
- R02/R03: delimiter-joined key sets admitted comma-containing key collisions.
  `fields` now checks own enumerable key count and element-by-element sorted
  equality. Capture scope.sessionId must equal revision.sessionId. Writer and
  reader reject both malformed scope and mismatched sessions. Reader fixtures
  have freshly generated valid ZIP CRC/SHA; transport failure cannot mask schema
  refusal. No schema or existing Host files are changed.
- R04: a path assigned before failed exclusive creation was treated as acquired.
  Cleanup now owns the path only after `open(wx+)` succeeds. Injected ENOSPC,
  EMFILE and ENOENT produce definitive not-written, no unlink of an unowned path,
  unchanged previous file, and successful same-operation retry after recovery.
- R05: genuinely acquired staging that cannot be removed remains locked for Host
  recovery; old complete bytes remain unchanged. This safety condition is retained.

Before correction on #170 source, added tests produced **9 FAIL / 1 PASS**, plus
an unhandled rejection from the actual stale pending.receipt dereference. This
failure is retained, not filtered. After correction all10 pass without unhandled
errors. Original unknown/quota/cancel/40MiB/closure tests remain passing.

## Exact-source verification

| Check                                              | Result                     |
| -------------------------------------------------- | -------------------------- |
| New review regressions                             | PASS,10                    |
| Prior file archive tests                           | PASS,30                    |
| Existing Host + Video Core/media                   | PASS,83                    |
| Combined unit                                      | PASS,123 /5 files          |
| Root lint / typecheck / build / file policy        | PASS                       |
| Browser adapter, Windows, crash journal, full repo | NOT RUN in this correction |
| CI / performance / merge / release                 | NOT RUN; holds maintained  |

Commands at the tested pin:

```sh
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-core/src
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Linux/Node24.19.0; installed dependencies and synthetic local files only. Raw
logs stay outside Git. Environment was explicitly checked after the disconnect
notification: commands/files accessible, completed test log intact, no active
Vitest/Playwright/Vite server. No workspace restart or replacement was performed.

| Log                                 | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-file-review-before.log` | `83e70b00feb8c2d10c5fb1a5e60a9689e3bb9d2e955fe0e32ff4f14084dd0546` |
| `/tmp/video-file-7299-unit.log`     | `e1853eb2628a221e23a1d3daac362da629f0795779f28b95d6f76a6b1d1d55c2` |
| `/tmp/video-file-7299-lint.log`     | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-file-7299-type.log`     | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-file-7299-build.log`    | `ce830370e3a531b6bea4bd9e3f4a5db77b8f25816a08245584928ff31c970744` |
| `/tmp/video-file-7299-files.log`    | `8273b4c4cce97c8024e93369cf0b4d37bccf14409addeafb7154ca9e5151cf66` |

Adoption remains HOLD pending independent review. No permanent format/API/budget,
license, dependency or cross-platform durability guarantee is added.

## Deferred reader cleanup follow-up (supersedes tested pin above)

Tested code **b20b590943c9eeae2651d9fe2f041002c46cfe2a** adds R06. Holding A's
reader.close on the previous correction allowed B to rename and return unknown
while A's shared reconciliation promise still existed. The regression failed
(1 FAIL /10 PASS), retaining B's actual unknown receipt in
`/tmp/video-close-before.log`. This confirms ownership was released too early.

Now reconciliation holds its pending/busy claim through reader cleanup and clears
that claim together with the shared promise in the final synchronous callback.
While close(A) waits, B is Busy and repeated reconcile(A) shares A's promise.
After cleanup settles, B can save, lose its acknowledgement and reconcile to B's
own saved receipt. Original #170 remains unchanged. Independent review is still
required; this follow-up does not clear all storage adoption gates.

At this tested pin: **124 PASS /5 files** (11 review +30 archive +83 Host/Core),
root lint, typecheck, build and file policy all PASS. Same commands/environment as
above. Logs: `/tmp/video-close-final-{unit,lint,type,build,files}.log`. Browser,
Windows, power loss, full repository suite, CI and performance remain NOT RUN
for this correction. Documentation-only commits after this pin do not change code.
