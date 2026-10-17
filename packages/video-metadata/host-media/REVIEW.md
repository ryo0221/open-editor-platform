# Import/original-bundle review checkpoint — #75 / #160

Code tested: **9d4a4ba1da6b8056c00aa6824f4c3fab4a73c62f** (clean tree).
First adapter + revised-contract pin: **b0a875515850b76656a177166b954198d927ee1a**.
Base: #157 **d4f34568cc34f1600d062b3cabf7b89d57d2333d**.
Latest main checked: **5a32d355ac107258a604e5a4d7a45d03f3b9efdb**.
No other lane or unreviewed PR merged. This document is an evidence-only follow-up.

## Implemented bounded slice

- `import.ts`: atomic selected A/V import through the existing guarded controller;
  exact rational media intervals/relative placements, linked clips, original hash;
  opaque single-use Host/scope lease, bounded reservation, rollback on refusal.
- `bundle.ts`, `staging.ts`: immutable original retention, complete native version
  envelopes, independently derived selected/retained-root closure; private bounded
  framing, staging/readback verification, existing SaveCoordinator capture hooks,
  unknown-result correlation/reconciliation. The next native parent is the
  explicitly selected root, not the last entry in archive order. Replayed receipts
  cannot roll selected roots backwards.
- `mp4-probe.ts`: private unfragmented MP4 feasibility profile, explicit BT.709 AVC,
  optional AAC-LC mono/stereo, positive stts and bounded ctts, one normal edit plus
  optional leading empty edit, no rotation/alternate-track auto-selection or
  external media references. No general ISO BMFF, codec or HDR acceptance claim.
- `browser-host.ts/html`: actual local file selection, existing Video timeline,
  browser-native reference frame, verified project download and file-only reopen.
  Imported originals include audio, but this preview does not render audio and
  is not frame/sample accurate. The reference frame is captured at import/open;
  timeline edits do not refresh it. No permanent Host registration or dependency
  adoption. Only existing workspace/tooling dependencies are used.

Read `CONTRACT-REVISION.md` before adoption: #160 remains HOLD. Its ZIP64 STORE
profile, large-file budgets, recursive index/recipe closure and public adapter
adoption remain proposals. Current framing is **not ZIP64**, has no derived/index/
recipe kinds, and rejects unknown entry kinds. Hashes never authorize execution.

## Exact-code verification

| Gate                                                | Result at 9d4a4ba1da6b8056c00aa6824f4c3fab4a73c62f |
| --------------------------------------------------- | -------------------------------------------------- |
| Focused Host workflow tests                         | PASS, 18                                           |
| Existing Video Core tests                           | PASS, 54                                           |
| Root typecheck                                      | PASS                                               |
| Root lint                                           | PASS                                               |
| Root build (both Vite targets + font verification)  | PASS                                               |
| Repository file policy                              | PASS                                               |
| Chromium desktop 1280×900 focused E2E               | PASS                                               |
| Chromium mobile 390×844 focused E2E                 | PASS                                               |
| Full repository unit/E2E regression, other browsers | NOT RUN                                            |
| Performance, automated Actions                      | NOT RUN / held                                     |

Unit tests cover atomic AV/one Undo+Redo/original retention, invalid/ambiguous/
fractional audio refusal, foreign/stale/consumed/revoked import leases, probe cancel,
quota, independent in-process Hosts, retained-root original closure, exact native
hash versus byte hash, tamper/missing/extra/plan/capture/quota rejection, frozen
capture, failed staged-write preservation, existing coordinator lock/unknown/late
receipt after scope close, and selected-parent/duplicate-receipt semantics.

Browser tests use a generated 320×180, 25 fps, one-second AVC + 48 kHz AAC MP4.
They import actual file bytes, verify one linked video/audio pair and a decoded red
reference pixel, download one bundle, destroy the first browser context, start a
new empty context, and reopen using only the bundle. Exact native content,
independently computed original file SHA-256 and decoded pixel match. A corrupted
bundle preserves the active Host; pending UI input blocks reopen. Browser errors
are zero and observed requests remain localhost/blob only. Desktop/mobile
screenshots were visually inspected. This is not actual iPhone or Windows proof.

Fixture SHA-256: `f2b841e4caa6c900fd0d00122dda306a43535746c666dc32def85039c40ab161`.
Decoded reference pixel: `[255,24,0,255]`; this is an identity/regression check,
not a colorimetric correctness assertion. Native FFmpeg is a fixture generator
only; no FFmpeg binary or generated media is added to the product/repository.

Commands:

```sh
npx vitest run packages/video-metadata/host-media/workflow.test.ts packages/video-core/src
npm run typecheck
npm run lint
npm run build
npm run check:files
node packages/video-metadata/host-media/browser-check.mjs /tmp/video-workflow-final-browser
```

Raw logs, generated MP4/bundles and screenshots are outside Git at
`/tmp/video-workflow-final-*.log` and `/tmp/video-workflow-final-browser/`.
The browser script uses installed Chromium (`CHROMIUM_PATH` override available),
FFmpeg and esbuild; it runs only on localhost and never enables/dispatches Actions.

## Initial failures retained

Before the code pin, unit harness admission initially failed 17/17 because its
verifiedPin passed extra manifest fields; fixed to the exact existing pin fields.
Then 16/17 passed: the remaining expected error label was Authority, while the
runtime correctly returned ScopeRevoked. That assertion was corrected. Initial
typecheck found a missing Track.enabled field in a validation-only scratch model;
added it. Logs: `/tmp/video-workflow-tests-{first,second}.log` and
`/tmp/video-workflow-typecheck-initial.log` / early tool output.

Browser first attempt failed on edit bounds: B-frame presentation PTS was compared
against decode duration. Fixed by deriving presentation bounds independently from
stts+ctts. Second attempt correctly rejected generated fixture colr primaries/
transfer marked unspecified; added explicit source-frame setparams, retaining
strict BT.709 checks. Third attempt's harness read hidden details via innerText,
producing empty JSON; changed to textContent and awaited Host readiness. These are
not erased or presented as codec PASS: `/tmp/video-workflow-browser-{first,second,third}/results.json`.
Subsequent working-tree runs passed; acceptance above is rerun at the exact code pin.

## Remaining work and holds

This is the first product-facing private import/bundle unit, not all of #75/#77.
ZIP64 streaming and durable filesystem writes, exact rational PCM/resampling,
preview/export shared timing, audio playback, frame-accurate seeking, HDR/Spatial,
rotation/VFR diversity, 1080p MP4 export, actual iPhone/Windows fixtures and lifecycle
cancellation strengthening from #158 remain separate. No Animation connection,
remote processing, license change, shared Core API, root manifest, main push,
merge, release, deployment or publication was performed.

Before push, all seven local and main workflow files were checked manual-dispatch
only. CI/file-size/Office workflows remain disabled_manually; other workflows are
manual-only. No Actions were enabled or dispatched. Verify run count at PR HEAD
in the final report.
