# Video M0/M1 Core status — prototype, not accepted

Date: 2026-10-12 UTC. Scope: [provisional ADR](ADR-video-m0.md), pure Core and
injected reader/probe boundary only. No shared Host/root/config/domain-table edits.
Baseline main: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb` (#52 merged).
ADR checkpoint: `e7b00e9` was reported before implementation completion.
Initial implementation tested: `48fa34196e4530d962520d31e622dbb48c23d5f9`.
PM follow-up implementation: `442bf9f3ea77ea60b58bf6e9547d90180f953de8`; see the
separate exact-commit results below. Initial results are not reassigned to this fix.

## PM review follow-up

Implementation commit `442bf9f3ea77ea60b58bf6e9547d90180f953de8` fixes two defects:

- Probe success is withheld until read drain and lease release finish; cancellation
  during either stage rejects with the AbortSignal reason. Lease release remains
  exactly once. Deferred-read and deferred-release regressions cover both races.
- Validator checks audio presentationOrigin plus both sample-window endpoints,
  including exclusive end. Unrepresentable rational results reject before content
  is accepted. Tests cover overflowing start, overflowing end and valid negative
  origin; no rounding or schema/API/codec changes.

Red/green: five added tests on the previous source produced 4 FAIL / 50 PASS
(`/tmp/video-pm-red.log`, uncommitted tests atop prior HEAD `668c51d8eb8f4c822d6ae84b33769c662adf72ba`).
The fixed code produces 54 PASS, with no failures.

| Check at `442bf9f3ea77ea60b58bf6e9547d90180f953de8` | Result  | Evidence                                                                                                             |
| --------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/video-core/src`            | PASS    | 40 Core + 14 media tests; `/tmp/video-pm-green.log`                                                                  |
| `npm run typecheck`                                 | PASS    | `/tmp/video-pm-typecheck.log`                                                                                        |
| `npm run lint`                                      | PASS    | `/tmp/video-pm-lint.log`                                                                                             |
| `npm run build`                                     | PASS    | `/tmp/video-pm-build.log`                                                                                            |
| Full unit / E2E rerun                               | NOT RUN | Focused Core fixes only; previous exact-commit results below retained. Existing baseline mobile FAIL is not cleared. |
| Codec / performance / Actions                       | NOT RUN | Approval/measurement holds unchanged                                                                                 |

## Implementation

- Canonical rational sequence time and exact CFR timestamps; safe JSON integers,
  internal BigInt products, fail on unrepresentable results.
- Native video PTS/timebase/presentation origin and audio sample indices/rate;
  no forced 240000-Hz quantization, no nominal-fps VFR mapping.
- Strict prototype schema/unknown-field/ref/overlap/handle/budget validation.
- Pure insert, linked move/split/delete, explicit independent trim, link/unlink,
  non-crossing ripple delete/gap insert, duration resize. Existing EditorSession
  Undo/Redo tests; no independent history or sync engine.
- Deterministic stateless source requests; no decoder sample selection or renderer.
- Injected media lease/probe guard: identity, per-read/total/count limits, range,
  short reads, abort, release and drain of outstanding reads. Fake probes only.
- Animation exact ref type is isolated; not accepted content or connected Player.

`package.proposed.json` is deliberately inactive. Activating package.json without
updating root package-lock breaks npm ci. Integration owner should activate the
manifest and regenerate the two workspace/link entries together after review.
Root manifest wildcard needs no edit. Root README/status registration belongs to
that integration change. Until then use `packages/video-core/src/index.ts` directly.

## Environment and exact-commit checks

Linux 6.18.44 x86_64, Node v24.19.0, npm 11.9.0, TypeScript 5.9.2, Vitest 3.2.4,
Vite 6.4.1. Chromium 151.0.7922.173 (`/usr/bin/chromium`). Fixed repository fonts
fetched and hash-verified. Dependency versions unchanged; install used
`npm ci --ignore-scripts --cache /tmp/video-npm-cache`.

All rows below target `48fa34196e4530d962520d31e622dbb48c23d5f9` unless stated.
Raw evidence lives under `/tmp/video-*` in this task environment, not in Git;
it is not a durable or public evidence archive. Commands/configs below reproduce
checks; report does not promise evidence release/upload.

| Check                                                                                                                                    | Result  | Evidence / actual scope                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                      | PASS    | `/tmp/video-typecheck-final.log`                                                                                                                                            |
| `npm run lint`                                                                                                                           | PASS    | `/tmp/video-lint-final.log`                                                                                                                                                 |
| `npm test`                                                                                                                               | PASS    | 131 files, 1211 tests, including Core 37 + reader/probe 12; `/tmp/video-unit-final.log`                                                                                     |
| `npm run build`                                                                                                                          | PASS    | Existing Playground/React preview builds; `/tmp/video-build-final.log`; Video is not registered in these apps                                                               |
| `npx esbuild packages/video-core/src/index.ts --bundle --platform=neutral --format=esm --outfile=/tmp/video-core.mjs`                    | PASS    | Independent Core bundle, no runtime React/Host/codec dependency                                                                                                             |
| `npm run check:files`                                                                                                                    | PASS    | Initially at `05b30b85c90d6f3d29b659ef8d23fbbb59406942`; rechecked for report commit                                                                                        |
| `npm run test:tooling`                                                                                                                   | PASS    | 25 tests at `05b30b85c90d6f3d29b659ef8d23fbbb59406942`; tooling unchanged in final code                                                                                     |
| `npx playwright test tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts --output=/tmp/video-e2e-results --reporter=list` | FAIL    | Existing dev Host: desktop 1 PASS; mobile 390/768 both FAIL waiting for `Next PDF page` at issue2-mobile.spec.ts:64; 45s timeout                                            |
| Baseline mobile reproduction                                                                                                             | FAIL    | Main `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`, same spec `--project=mobile --grep=390px`, same line 64 timeout; `/tmp/video-baseline-e2e.log`. Baseline 768 not repeated. |
| Video UI/independent Viewer/production Video E2E                                                                                         | NOT RUN | Not implemented or registered                                                                                                                                               |
| Real media probe/decode/encode/mix/mux/redecode                                                                                          | NOT RUN | No approved backend/dependency/profile selected                                                                                                                             |
| Performance/extended scale/Actions                                                                                                       | NOT RUN | Intentionally paused; never dispatched                                                                                                                                      |

Desktop narrow-container and mobile Slide screenshots were visually inspected;
existing content/toolbar fit the container. Failed File Viewer screenshot shows
rendered first PDF page but no exposed next-page control. No UI fix included in
this lane. This remains a regression gate failure, not an overall E2E PASS.

Initial failures retained: initial npm cache could not write under /home/agent;
retry used /tmp. Active provisional manifest initially caused lock mismatch and
was made inactive before the final install. At `05b30b85c90d6f3d29b659ef8d23fbbb59406942`,
focused 47 tests/lint/tooling passed, typecheck failed on test TypedArray buffer
type; fixed at the final implementation SHA. Initial npm test/build attempts hit
fonts:check while extraction was pending; neither was recorded as a test/build
PASS. Retried only after pinned font extraction completed. The dev E2E startup
also logged a Vite `undefined.join` warning; desktop nevertheless completed.

## Codec feasibility observation (not format acceptance)

Local secure-context Chromium capability inquiry only, at the final implementation
SHA; no actual decode/encode, media transmission or backend installation.
Raw configuration/results: `/tmp/video-feasibility/capabilities.json`; reproduction
script: `/tmp/video-feasibility/inspect.mjs`. Check each browser/OS independently.

| Config                                         | Decoder isConfigSupported | Encoder isConfigSupported |
| ---------------------------------------------- | ------------------------- | ------------------------- |
| VP8 (`vp8`), 1280x720; encoder 30fps, 2Mbps    | true                      | true                      |
| H.264 (`avc1.42001f`), same dimensions/rate    | true                      | true                      |
| Opus (`opus`), 48000Hz stereo; encoder 128kbps | true                      | true                      |
| AAC (`mp4a.40.2`), same audio config           | true                      | false                     |

This supports prioritizing the proposed local WebM/VP8+Opus spike over assuming
MP4/AAC output works here. [WebCodecs](https://www.w3.org/TR/webcodecs/) leaves codec
support to implementations; neither config inquiry nor a supported decoder proves
an end-to-end format profile. Demux/mux choice, license/size review, SDR color,
resampling/priming/padding and output sink remain owner decisions. No dependencies
or license terms changed. Real AV profile gate remains NOT RUN.

## Acceptance map and remaining gates

| IDs               | Result for this change                             | Remaining boundary                                                                             |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| N01/N14           | PASS for prototype documentation                   | Owner contract review pending; no product capability claimed                                   |
| N02/N04           | PASS for v0 Core subset                            | Native production schema/migration not accepted                                                |
| N05               | PASS for local linked move Undo/Redo test          | Gesture/input/restore paths NOT RUN                                                            |
| N03/N06–N11       | NOT RUN as Video Editor gates                      | No Video Host, Surface, permission submission, storage/version import or selection integration |
| N12               | PASS for bounded Core/reader subset                | Untrusted real demux/codec/container and media hashing NOT RUN                                 |
| N13               | FAIL overall                                       | Mobile regression failure retained; unit/type/lint/build individually PASS                     |
| V02               | PASS for rational/source-request/sample tests only | Real VFR decoder and drift/AV checks NOT RUN                                                   |
| V03               | PASS for supported pure commands only              | Crossing ripple, effects/keyframes/transitions/shared stale checks NOT RUN                     |
| V01/V04–V11       | NOT RUN                                            | Full production, AV, Animation, media durability, output, privacy and Host gates pending       |
| C01–C10 / S01–S06 | N/A to advertised Core-only capability             | No capability registrations or fallback; future Epic work remains unimplemented, not waived    |

M0 contract approval and real codec feasibility are incomplete. M1 Core subset is
implemented, but M1 Viewer/AV clock/store/relink/native persistence are incomplete.
M2 Surface, M3 Animation/export and M4 shared/combined regression remain future work.
The branch must not be described as full M0, M1 or Epic completion.

Owner review requested for rational representation/rounding boundary, deliberately
limited ripple/link subset, media lease authority and candidate local codec spike.
#74 tested Player/API review precedes any Animation connection; #76 approved API
precedes Host registration. Final merge/release remains a separate owner decision.
