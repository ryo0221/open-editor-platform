# PR #39: main integration and six review corrections (2026-10-17 JST)

Original PR head: `93693c9631188b6dd9b7ee5c4098174118770183`.
Integrated main: `e117d81a1618f69207d0fb1d54aaae1547e885b2` (including PR #37).
Application/test pin: `3f8eb9c0af899f03a248ec477eb32ad1d2b61d01`.
Merge commit `b076aa86` preserves both status histories and both branches' workspace
packages/links; no external dependency version is changed to resolve the lock.
Later changes are documentation and public-snapshot inclusion only.

## Reachable findings and corrections

1. Numeric literal props such as `columns: 3` previously became unrestricted number
   schemas with sample 0. Extraction now produces an addressed unsupported-numeric-literal
   diagnostic. An explicit Host wrapper may expose an unrestricted number contract.
2. Style layout previously checked only that a prop named style existed. It now requires
   a declaration accepting React.CSSProperties and its supported properties; string,
   narrowed style objects and required extra fields diagnose a Host wrapper. Actual
   CSSProperties imported under an alias still succeeds.
3. A selected saved version must belong to its enclosing Artifact. A valid content hash
   and matching selected version ID no longer permit foreign artifact ownership.
4. The CLI rejects tsconfig parse diagnostics before constructing a Program. Unknown
   options, invalid option values and missing extends fail without candidate stdout.
   Diagnostic 18003 alone is excluded because explicit request entrypoints are added
   independently of glob discovery. Other parse errors are not ignored.
5. Slot detection compares the Program's actual React declaration symbols rather than
   type names. Local JSON aliases called ReactNode/ReactElement/ReactPortal/ReactChild
   remain data objects. Actual imported/renamed ReactNode slots continue to work.
6. Host policy cannot lower an extracted required slot minimum. Keeping or narrowing
   the permitted count remains supported; making the source prop optional requires
   an explicitly reviewed wrapper rather than a policy override.

No component implementation is executed during declaration extraction. No original
source, prior registration or immutable version is rewritten by these diagnostics.

## Verification and failure history

Linux, Node 20.20.2/npm 10.8.2, pinned TypeScript 5.9.2 and Playwright 1.63.0,
Chromium 151.0.7922.173. Desktop 1440x900, mobile emulation 390x844.
The four Office fonts retain their pinned SHA-256 values.

Before correction, the added unit regressions report **10 failed / 37 passed** in
2 files: foreign version ownership, numeric literal, three incompatible style types,
four local React-named JSON aliases and lowering required slot minimum. The separate
CLI regression fails because an unknown tsconfig option still emits a candidate;
its unrelated existing test is excluded by the targeted name filter, not disabled.

After correction, both targeted unit files pass **47/47**, including the compatible
CSSProperties and real React slot alias controls. The complete tooling suite passes
**63/63**, including all three invalid tsconfig forms and existing metadata validation.
No test deadline, retry, worker limit, expected behavior or correctness assertion was
relaxed. These baseline failures are retained under ignored work/issue39.

| Final command / scope                                       | Result                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `npm test`, isolated after browser/tooling jobs             | 243 files, 2552 PASS / 9 existing optional Spatial WASM skips               |
| `npm run test:tooling`, repeated after public policy update | 63 PASS / 0 skipped                                                         |
| lint / typecheck / production build                         | PASS; existing chunk-size warnings retained                                 |
| production React UI / portability / Design browser suite    | 19 PASS, desktop/mobile, workers2; no browser errors                        |
| five independent React Host apps                            | strict TypeScript and production Vite builds PASS before browser acceptance |
| separate-process portable Host regeneration                 | all 5 generated files plus handoff manifest byte-identical                  |
| file size / changed-file formatting / diff check            | 2151 files, zero size failures; PASS                                        |
| final local public snapshot                                 | export plus manifest/residual checks performed before push; no remote sync  |

The production portability suite also builds five independent React apps with strict
TypeScript and Vite before declaring server readiness. It exercises Library/Inspector,
optional-slot defaults, actual input/callback behavior, save/reload/native ZIP stability,
read-only/errors/shared editing and ordinary Design generation/regeneration. Independent
output uses 390/1024/1400 widths. Screenshots are inspected and browser console/page
errors fail the tests. Logs, exports and raw evidence stay outside Git.

## Scope and remaining acceptance

The reported default Vite failure is still NOT REPRODUCED; the established independent
Host driver retains its previous bundler setting. This review correction does not claim
that separate report fixed, or prescribe that setting for arbitrary consuming projects.
Actual consuming-application trials, physical mobile/IME, real production auth/durability,
Firefox/WebKit and unrelated whole-repository E2E are NOT RUN here. Existing #22
performance acceptance and measurement/tuning/Actions holds remain in force.

The public snapshot includes the new public contracts, Host guide and verification
records. Product-specific wording in these docs is replaced by consuming-side terms;
forbidden scan rules are unchanged. Local export/manifest/residual checks do not imply
public upstream synchronization or a public Site deployment. PR #39 and #35/#38 remain
pending adoption/review; this task does not merge or close them automatically.
