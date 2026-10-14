# #247 spatial Wasm functional verification

PR #252 review corrections and matched Office diagnosis record
the corrected source, current-main reconciliation and new verification. The
original results and failure history below remain historical evidence.

Scope: internal numeric candidate search connected to Design and Whiteboard
through their existing CanvasStage. See [design, ABI, distribution and measurement proposal](../../spatial-wasm-design.md).
Performance measurement is **NOT RUN / held**, CI stays manual-only, and the PR
stays Draft. This report does not certify performance or all Editors.

## Source and environment

- Final implementation/test source: `454b8c909714b79cba0ae2ee26d13e2b0b7daeb6`.
  Subsequent changes are documentation only. Base is `ac0252c7fbf6e3d51cfafc0be15e3c2b4624957f`.
- Linux x64; Node 20.20.2, npm 10.8.2, Rust 1.90.0
  (`1159e78c4 2025-09-14`); Chromium 151.0.7922.173.
  Desktop 1440×900 and mobile emulation 390×844. Physical mobile is NOT RUN.
- Actual Rust release Wasm SHA-256:
  `837e8c06237c9238837e3c81e3abe8a4abbacd2816280e419640a6548c56f423`.
  Rust source/ABI is unchanged after `cffae387536bac67772d53788100b815dfd44335`;
  the final runtime retirement correction is TS-only.

## Required conditions

| Condition                                                | Evidence                                                                                                                                                                                                 | Result                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Existing workload and exclusions investigated            | actual pointer-up call site, domain projections, exclusions and call frequency in design                                                                                                                 | PASS                                                      |
| Real Rust/Wasm reachable through TS                      | offline pinned crate; real ABI query calls observed separately in Design and Whiteboard                                                                                                                  | PASS                                                      |
| Functional equivalence and edge cases                    | compiled Wasm vs TS; points/contact/negative and large coordinates, order, rotations, hidden/locked, 100,000 objects, replacement/disposal                                                               | 11 TS tests PASS, included in 144 below; 1 Rust test PASS |
| Initialization/unsupported/runtime failure fallback      | loader rejection, malformed bytes, missing WebAssembly, unknown ABI, superseded init, failed allocation/build, bad result count and injected RuntimeError; later snapshots return to TS after retirement | PASS                                                      |
| Numeric transfer/ownership/error/distribution documented | ABI, temporary buffer cleanup, owned results, memory growth, 64 MiB cap, idempotent disposal, optional build and notices                                                                                 | PASS                                                      |
| Two actual consuming Editors and regressions             | independent Design/Whiteboard marquee and read-only source preservation; existing ordinary editing/export flows                                                                                          | 8 desktop/mobile cases + 2 existing desktop cases PASS    |
| Measurement remains paused                               | no benchmarks; workload/environment/adoption thresholds are a proposal only                                                                                                                              | PASS                                                      |
| lint/typecheck/build/file/tooling                        | final source lint and build including typecheck; file guard and tooling                                                                                                                                  | PASS; final document/export checks recorded below         |

## Commands and results

| Command                                                                                                                                                                              | Exact scope and result                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run spatial:test`                                                                                                                                                               | `cffae38`: locked/offline real Wasm build, Rust unit 1/1, spatial TS/adapter unit 11/11. Later final unit run below uses the same binary with the corrected retirement runtime.                                                                                                                                                                                                  |
| `cargo clippy --locked --offline --manifest-path packages/spatial-index/rust/Cargo.toml --target-dir work/spatial-target -- -D warnings`                                             | PASS; Rust tree is identical at final source. `cargo fmt` also applied.                                                                                                                                                                                                                                                                                                          |
| `npm test -- --maxWorkers=1 packages/editor-core/src packages/canvas-ui/src packages/design/src packages/whiteboard/src packages/slide/src packages/spatial-index/src`               | final source: 22 files / 144 tests PASS, including actual Wasm 11 tests; default test timeouts maintained.                                                                                                                                                                                                                                                                       |
| `npm run lint`                                                                                                                                                                       | final source PASS.                                                                                                                                                                                                                                                                                                                                                               |
| `npm run build`                                                                                                                                                                      | final source PASS, including typecheck and both Vite production builds. Normal build does not call Cargo or require an optional Wasm asset.                                                                                                                                                                                                                                      |
| `npx playwright test --config playwright.spatial.production.config.ts`                                                                                                               | final source: all 8 PASS. Each case checks both actual Surfaces, immutable canonical source, native selection IDs/order, hidden/locked exclusion, read-only Delete and unmount cleanup. TS/Wasm/broken/unavailable each run at desktop and mobile viewport. No console errors/page errors. Wasm ABI calls and drops increase for each Surface separately. Screenshots inspected. |
| `npx playwright test --config playwright.production.config.ts --project desktop --workers 1 tests/e2e/issue2-canvas.spec.ts --grep 'H[12] ' --output /tmp/issue-247-existing-canvas` | final source: 2/2 PASS (existing H2 Whiteboard connections/group geometry/Undo/SVG and H2 Design components/layout/PNG). Includes normal Host editing, save/reload and actual graphic output. Existing timeouts maintained.                                                                                                                                                      |
| `npm run check:files` / `npm run test:tooling`                                                                                                                                       | PASS / 25 tests PASS; later source does not change tooling implementation. Final file/export counts are recorded below.                                                                                                                                                                                                                                                          |

## Mandatory criteria affected

- N01/N02: PASS for the numeric boundary, exclusions, validation and ownership;
  no new domain model/native schema is added.
- N03/N04/N05: PASS for pure selection/source preservation and related ordinary
  editing/Undo regression. No index/camera/selection enters content or history.
- N06/N08/N11: PASS for independent public-API Host and native IDs at the declared
  Chromium desktop/mobile viewports. This does not declare physical touch coverage.
- N07/N09/N10: PASS for the affected ordinary Host paths checked above. No new
  permissions or persistence capability is introduced; all Editors and every
  import/retained-version path are not recertified by this experiment.
- N12: PASS for bounded finite numeric input, trusted import-free module and
  [Rust provenance/notices](../../third-party/rust-wasm.md). It does not load content-uploaded Wasm.
- N13/N14: PASS for scoped reproducible checks, README/status, distribution and
  truthful limitations. Performance acceptance remains held separately.

## Conditional criteria and untested areas

C01/C02/C03/C04/C05/C06/C07/C08/C09: **N/A for new capability**; this module adds no
text, annotation, external proposal, shared operation, template/reuse, format
adapter, React generation or document asset capability. Existing domain contracts
are preserved; their entire acceptance suites are not recertified. C10: only the
declared Chromium viewports are checked. Physical mobile, other engines, CSP
restrictions, screen reader, OS IME and an independently deployed Wasm asset are
NOT RUN. Other CanvasStage consumers' Wasm paths are NOT RUN; normal TS behavior
is retained, and Slide units are included in the related regression.

## Failure history and scope limits

- Initial lint reported three missing `URL` globals in the build helper; importing
  Node's URL fixed them. Final full lint passes.
- The first browser fixture incorrectly enabled read-only while trying to start
  a marquee. Existing CanvasStage intentionally refuses that gesture. The run
  had 3 FAIL, 1 interrupted and 4 NOT RUN. The fixture was corrected to select
  in editable mode, then separately verify read-only source preservation; final
  8/8 pass. No read-only product behavior was weakened.
- The first related unit command used `packages/slide` and `packages/design`
  filters, which also matched the Office/Design React packages. It encountered
  six Office timeouts: slide-import import.test.ts five (four default 5-second
  timeouts and I07's existing 60 seconds) and slide-export boundaries.test.ts
  one (default 5 seconds). That broader run was interrupted and is **not PASS**.
  Those Office trees are unchanged from base; the timeout cause was not diagnosed
  or fixed here. The intended `/src` package filters above completed 144/144.
  No full-repository unit or E2E acceptance is claimed.
- An initial ordinary browser invocation used an anchored grep and selected no
  tests (0 executed). The corrected command above executes the two intended cases.

Raw logs/screenshots live in `/tmp/issue-247-*` and
`/tmp/editor-platform-spatial-results`; the optional binary/build tree live under
ignored `work/`. None is committed or externally published. Harness durations are
not comparative performance measurements. CI was not re-enabled and main was
not merged. The proposed measurement gates have not been approved or executed.

## Final source/export checks

At documentation snapshot `21b1dc15e549f6f0cd7e437659e63e1b9fd625ae`, the file
guard passes 1,114 files and the local source export/check passes 834 exported /
835 manifest files. Snapshot SHA-256:
`0164bfcfcb512aef5fe7ec84dbb98047e19d9cd44e997a15f5ce6c76dd77a544`.
The follow-up changes only this report to record those results. Implementation,
tests, package metadata and browser configuration still match tested source
`454b8c909714b79cba0ae2ee26d13e2b0b7daeb6` exactly. This is a local source
export, not external publishing or a compiled npm package release.
