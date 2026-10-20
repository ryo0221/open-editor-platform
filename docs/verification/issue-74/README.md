# Issue #74: Animation 2D verification

Date: 2026-10-20 JST. This record covers schema 2 and the current Surface/Player.
The [earlier layer-action record](layer-actions.md) retains the results and source
for its original rectangle-only change. Those counts are not reused here.

## Source and scope

Base: main `bca0cb147e7dd910ddbd74fcac32d587f66eec65` (PR #300).
Implementation and assertion source: `ae7e502ae2a1236e7935d6546b48b25f51a3f566`.
Subsequent commits update this report and screenshot framing only; application
code, fixtures and assertions are unchanged. Lockfile SHA-256:
`68321b1ae863d6d3801be32a9467e5ce384323cd0ecf4c4593c435166e8a5160`.
[ADR 012](../../decisions/012-animation-2d.md) and the
[capability/Host guide](../../animation/production-2d-design.md) define the subset.

One current schema 2 editor/Player covers 2D native authoring, pinned resources,
shared commands/native text, Design capture, Slide exact references, independent
Web/registered React output and static SVG/PNG consent. Schema 1 keeps readers,
validated playback projection and explicit draft migration; saved bytes/hashes
remain immutable. Generic templates/linked fragments, animated Slide/Office
output, additional editor embeddings and GIF/video/Lottie are unsupported.

Environment: Linux, Node 24.19.0, npm 11.9.0, TypeScript 5.9.2, React 19.1.1,
Vite 6.4.4, Playwright 1.63.0, system Chromium 151.0.7922.173.
Desktop 1440×900 and mobile viewport 390×844. Synthetic composition events are
input-guard checks; they do not certify native OS IME or physical devices.

## Acceptance evidence

| Condition | Evidence and limits                                                                                                                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01       | Production authoring creates Japanese text with a retained font, image/vector hierarchy, mask/motion/nested scene, graph easing, multi-key move/paste, nest/unnest, native save/reload and immutable old versions. Core/structure units verify IDs and command atomicity.                                                    |
| A02       | Core tests cover forward/reverse/random seek, hold/linear/Bezier/color/text, motion endpoints, exact rational nested trim/rate/hold/loop/hide and fractional grids. Transport tests cover absolute clock, dropped frames, pause/resume/rate/work area, terminal sampling and dispose.                                        |
| A03       | Same evaluator/renderer serves all consumers. Production Slide imports a retained font/image/mask/nested source into a fresh context without its catalog and compares evaluated instance transforms/text. Japanese SVG/PNG and registered React output are opened in actual Chromium.                                        |
| A04       | Native commands and production UI verify multi-key move/paste/nest one Undo; duplicate-time, lock, stale base, invalid target/IDs and failed preparation refuse atomically. Existing layer confirmation/cancel/focus regressions remain.                                                                                     |
| A05       | Production connection cases cover valid/invalid/composing buffers across save, import hashing, history, read-only and navigation; invalid input is retained. Shared pending export is disabled. Captures flush authoritative input and recheck permission after resource work.                                               |
| A06       | Slide units exercise schema 2 pinned source v1/v2 adoption, consumer inputs, explicit diff, missing declaration refusal and A Undo preserving B placement. Production source navigation/adoption/import regressions exercise ordinary UI.                                                                                    |
| A07       | Owning native validation checks complete per-source closures, version/hash, missing/cyclic/deep/expanded graph, asset hash/signature/budgets and typed input ownership. Independent native and retained Slide playback require no source catalog.                                                                            |
| A08       | Pure conversion captures public resolved geometry once with remapping/provenance, rejects changed hash/forged plan and leaves source untouched. Production saved-frame preview/adopt/one Undo and unsupported ellipse refusal run in both viewports.                                                                         |
| A09       | Core/authority tests enforce read-only, scoped grants, locks, expiry/revocation, malformed IDs and immutable targets. Production normal shared/local inputs and private play/seek preserve native content. Existing entity replacement cannot bypass native text steps.                                                      |
| A10       | Normal two-context peers exercise geometry, native ProseMirror text, peer-preserving actor Undo, pending/reconnect/export guard. Authority/session tests cover same/different key conflicts, duplicate delivery, lost acknowledgement/checkpoint recovery, locks/scopes/revocation/expiry and structural one Undo.           |
| A11       | Native roundtrip and retained source import validate hashes. Exact static plan/consent, forged/changed plan, abort and permission refusal have units; actual SVG/PNG downloads contain pinned fonts/notices. Generated registered React bundle runs on a separate ordinary static HTTP Host.                                 |
| A12       | Four production builds include independent Surface/Player without Playground CSS/store. Production keyboard/focus/IME guards, mobile layout, reduced-motion/presentation/cleanup and Slide connection regressions are exercised. Design conversion uses its own adapter; existing Design/Slide regression is recorded below. |

The N01–N14 engineering requirements map to the ADR/capability guide (N01/N14),
core/commands/authority units (N02–N05/N09/N10/N12), controlled independent and
ordinary production flows (N06–N08/N11), and the checks below (N13).
C01/C03/C04/C06/C07/C08 apply to the declared text, Host, shared, exact-composition,
SVG/PNG and registered React subsets. S01–S06 apply to the existing reference
service, not production authentication or durability. C02 infinite canvas and C05
generic template creation are N/A for this capability set; their entrypoints stay
unsupported. OS IME/assistive technology and untested engines remain NOT RUN.
This is functional engineering evidence, not release/performance acceptance.
The 2026-10-20 performance record holds the requested
edit/Player/test-time measurements for PR #307.

## Reproduction and final results

```sh
npm run lint
npm run typecheck
npm test
npm run test:tooling
npm run check:files
npm run build
npx playwright test --config playwright.animation-2d.config.ts
npx playwright test --config playwright.animation-connection.config.ts
npx playwright test --config playwright.animation-layer-actions.config.ts
```

Build all four targets before production browser tests. Run these configurations
sequentially because their ports overlap. The 2D configuration prepares a Japanese
font subset from the existing fixed Office font fixture using FontTools and keeps
all font name/license records; generated font/export/screenshots remain in ignored
`work/` or `/tmp`. It serves generated React output only through ordinary local
HTTP, without browser-policy workarounds. Console errors and page errors fail tests.

| Gate                                                          | Final post-refactor result                                                                                              | Raw log                                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lint / strict TypeScript / format / diff whitespace           | PASS                                                                                                                    | `/tmp/issue74-final-lint2.log`, `/tmp/issue74-final-typecheck2.log`; changed-file Prettier check and `git diff --check` |
| All units                                                     | PASS: 2,904 tests / 280 files; 9 existing optional skips. Main 2,896 + isolated Slide codec corpus 8                    | `/tmp/issue74-final-units2.log`                                                                                         |
| File policy                                                   | PASS: 2,429 files / zero failures                                                                                       | `/tmp/issue74-final-files3.log`                                                                                         |
| Tooling                                                       | PASS: 107                                                                                                               | `/tmp/issue74-final-tooling.log`                                                                                        |
| Four production builds                                        | PASS: main, React UI, Artifact Host, Animation Host                                                                     | `/tmp/issue74-final-build2.log`                                                                                         |
| New 2D production                                             | PASS: 10 (desktop 5 / mobile 5), no retries                                                                             | `/tmp/issue74-final-browser2.log`                                                                                       |
| Existing Animation/Slide connection                           | PASS: 64 (desktop 32 / mobile 32), no retries                                                                           | `/tmp/issue74-final-connection2.log`                                                                                    |
| Existing layer actions                                        | PASS: 8 (desktop 4 / mobile 4), no retries                                                                              | `/tmp/issue74-final-layers2.log`                                                                                        |
| Existing Design / independent all-surface / mobile regression | PASS: 4 (desktop 2 / mobile 390px + 768px)                                                                              | `/tmp/issue74-final-design-slide-regression.log`                                                                        |
| Design preview capture framing                                | PASS: repeated 2 viewport cases, assertions unchanged                                                                   | `/tmp/issue74-final-design-capture.log`                                                                                 |
| Code public snapshot export / fresh check                     | PASS: 1,967 files + manifest; npm including dev/optional and 3 OSV queries on each invocation; manifest/residual checks | `/tmp/issue74-final-public-export1.log`, `/tmp/issue74-final-public-check1.log`                                         |

The production cases total 86 (10 + 64 + 8 + 4), excluding repeated captures.
Generated evidence is not committed. Images of Japanese authoring/PNG, independent
React output, mask/motion/nested composition, retained Slide playback and the
captured Design triangle were visually inspected. Design preview images were
reframed to capture the actual review region, not the clipped page viewport.

Code snapshot: `work/issue74-2d/public-ae7e502a`, manifest SHA-256
`d1b32642f1b08416ebcef48e7f02717711d5efe865a6dda30c908e59769a2cb2`.
The baseline final documentation/capture source was
`adb1c1837480652f13fafb5e58b6e91bb4655cc1`, exported to
`work/issue74-2d/public-final-docs` with manifest SHA-256
`e85150ab8f2d3a7de215ec052a32c169331e708486080d49c7a424466f7be5b6`.
Export and fresh check both passed, including 1,967 source files plus manifest,
npm dev/optional audit and three OSV queries per invocation. This identifies the
completed baseline artifact; subsequent review corrections have their own source
and snapshot receipt in [review follow-up](review-followup.md). No public
repository is synchronized.

Additional reproduction:

```sh
npx playwright test --config playwright.production.config.ts \
  tests/e2e/issue2-embedding.spec.ts tests/e2e/issue2-mobile.spec.ts \
  tests/e2e/issue2-canvas.spec.ts --grep 'QA-18|QA-17|H2 design' --workers 1
npm run public:export -- --ref HEAD --out work/issue74-2d/public-final
npm run public:check -- work/issue74-2d/public-final
```

## Failures and corrections retained

- One file-policy invocation under the default sandbox failed with a child-process
  permission error (spawnSync git EPERM). The unchanged check passed under the execution permissions used by the
  other spawned checks; no validation was removed or bypassed.
- Initial full-unit runs exposed two old factory expectations (schema 1) and an
  invalid registered React style value. Tests now check the schema 2 fast gate;
  registered component styles use the existing typed literal representation.
- Early lint/typecheck attempts found unused imports and incomplete test fixture
  arguments. Corrected before the final gates; a focused Vitest pass alone was
  not treated as strict TypeScript acceptance.
- Early production tests used old accessible names/relative peer URL assumptions.
  They now follow actual named controls and resolve peer URLs against their Host.
  A Design screenshot assertion selected a non-painted clip definition; it now
  asserts the painted path. No production behavior was weakened to fit a selector.
- `file://` navigation was blocked by browser administration. The actual independent
  reader test uses a normal static HTTP server for the generated bundle; no policy
  bypass was attempted.
- Connection regressions exposed source metadata ID validation mismatch and static
  poster metadata altering appearance comparison. Host IDs remain bounded opaque
  identities; export provenance metadata is separate from appearance-only posters.
- Invalid saved source metadata could throw during the Animation catalog render.
  Each unavailable version now has a diagnostic and does not block usable entries.
- The current Player initially swallowed Escape on a range control, leaving Slide
  presentation open. Navigation keys stay local to the range; Escape reaches the
  enclosing dialog. The existing desktop/mobile regression is retained.
- Authority hardening initially classified a six-segment transform field as a
  whole key entity. The ordinary two-peer test caught the refused geometry edit.
  Paths now distinguish field and entity shapes; numeric geometry and malicious
  whole entity/text relocation regressions verify both sides of the boundary.
- A clip expansion test initially used an invalid parent type; its corrected DAG
  uses native groups/masks and proves rejection before exponential clip expansion.

## PR #301 separation and limitations

PR #301 head `a8cbdc265eefa5661fa47ff734f99748e90e72fb` was checked. Its Design
model/view/template/instance-text/prototype work is not part of this change.
Only the common `collaboration-adapters/src/editor-transactions.ts` file overlaps:
this PR adds the Animation branch and Slide animation field; PR #301 adds Design
read dependencies. A three-way merge of that file and `git merge-tree --write-tree` for both
complete branches against the shared main base completed without conflicts.
The combined tree was `447b3ec1bc9ff6245083682973c9b3d190d60ac7`. This is a merge
check, not certification of combined runtime behavior. `docs/status.md` is left to PR #301 to avoid competing
edits; the current Animation contract is linked from root README/docs index and
the public status overlay.

NOT RUN: physical devices, native OS IME, screen readers, Firefox/WebKit, all
unrelated browser suites, installed plugin Host, production authentication/durable
service and new performance measurements. GIF/video/Lottie, generic Animation
templates/linked fragments and animated Slide PDF/PPTX/static exports are declared
unsupported and refuse; they are not marked tested compatible.

CI/Actions, product-side trials, public repository synchronization/deployment and
plugin pin/release changes remain untouched. Merge/release approval is separate.
