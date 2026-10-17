# PR #39 review corrections — 2026-10-09

Reviewed head: `cedaf93f015bc7194d3e210219595401b7bcbb8c`.
All six P2 findings were read and checked against source. The #38 functional
[initial report](README.md) remains historical; this checkpoint supersedes it.

| Review                                                                                                             | Correction / actual regression                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4231264569, required undefined unions | Only genuinely optional symbols remove undefined. Required top-level/nested JSON fields diagnose `unsupported-union`; optional top-level/nested examples still extract the right schema. Callback arguments retain their existing stricter normalization.                                                                                                                      |
| 4231264583, locale ordering           | TSX/CSS maps, component/node ordering, extracted fields and output manifest pins/files use a code-unit comparator. An I/i composition exports in code-unit order while `localeCompare` is replaced by a throwing spy. Generator is pinned as `react-ui-tsx@2.0.1`; earlier unmerged 2.0.0 output is not relabeled.                                                             |
| 4231264598, non-renderable function   | Return type must be assignable to the Program's actual ReactNode type. Object/function/symbol returns diagnose refusal; null/text/element arrays/JSX elements remain valid. A locally shadowed React namespace cannot override the target.                                                                                                                                     |
| 4231264606, required callbacks        | Diagnose non-optional callback props because native events have no required flag. Existing optional reference/enum callbacks still extract and work; required callbacks need an explicit Host wrapper. No native contract/schema migration is introduced.                                                                                                                      |
| 4231264617, file/directory collision  | Creation and verification reject ancestor collisions in either order, including case differences. Tests include unsafe actual file sets and a correctly fingerprinted colliding manifest against safe files.                                                                                                                                                                   |
| 4231264628, unknown CLI fields        | Public runtime request validation checks exact request/entry/ref/import/policy/slot/controlled-input fields and basic shapes before reading sources. CLI validates tsconfig too. Actual process tests reject policy/require/ref/import/sample typos and invalid config with nonzero exit and no successful candidate output; excluded entries also retain metadata validation. |

The initial return-type correction failed focused tests because the React UMD
namespace is an alias; resolving its actual symbol corrected this. Full native
models and registries were not weakened. An intermediate browser configuration
inherited the base mobile project's broad match: 64 passed, one was interrupted,
three were not run when the unintended expansion was stopped. The final dedicated
configuration explicitly selects each project's declared React/Design cases.
Those extra cases are not used to claim complete mobile acceptance.

Final checks pass lint/typecheck/build/file guard, **978 unit tests / 111 files**,
**26 tooling checks**, and **19 production Chromium cases together** with
`npx playwright test --config playwright.react-ui-portability.config.ts`.
The export server builds all five strict TypeScript/production independent apps;
the ordinary UI, shared/read-only cases and related Design regression pass.
Two separate form-export processes reproduce all five generated files and the
output manifest with the same saved pin and generator `react-ui-tsx@2.0.1`.
Representative 390px independent output and mobile UI screenshots were inspected.
Logs remain under ignored `work/issue-38/review-*`, output under
`work/issue-24/` and screenshots in `work/issue-38/browser-production/`.
The default Vite failure is still NOT REPRODUCED. Actual consuming application trial, native IME,
physical devices, other engines and production trust/durability remain NOT RUN.
No performance measurements/tuning, Actions run, external product integration, Site deployment
or merge is included. PR #37's Host review fixes remain a separate branch.
