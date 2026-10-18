# Design viewport rendering and scoped Slide capture (#269 / #270)

2026-10-17 JST. Base main: `f10d35b11f332209a0bfce40d708fb678d4417a4` (PR #271 merged).
Its file tree matches local base `bf2dd0f1d50e7dfdff3fda01cea47f61be5449de` exactly.
Original application/unit/build checkpoint: `b4593eb88203d6f74a8e3c47e88d0f709c65c6d7`.
Original corrected viewport-spec checkpoint: `530d1aac020e48a594f20ab62dcc2892b702ac80` (only the viewport
test changes; all application and unit-test files are byte-identical). The PR records the
documentation head and published tree equality. The transform-preview review fix below uses
application/spec checkpoint `ef280b250b6c92c0225b83946fe600e5128eee9e`.

The owner requested the remaining work after merging #271. This continues the targeted #269
investigation; general performance acceptance and Actions remain paused. The
[earlier report](README.md) retains the Document input fix and its original observations.

## Changes and boundaries

- A public Design Host render owns one drawing snapshot. Mutable inputs are copied/frozen privately;
  the Host's records and extension callbacks retain their original ownership. Local camera/panel
  updates retain that snapshot. A later Host render rechecks mutable input even when its identity
  is unchanged. One projector and its indices serve the snapshot instead of rebuilding per object.
- Design opts into rendering-only Canvas culling with 128 CSS-pixel overscan. Conservative bounds
  include all projected component parts, rotation and stroke extent. Selected targets, active text
  editors and targets with changed preview geometry stay mounted. Expanded text and image error UI
  retain conservative fallbacks; a Host supplying `extension.render` retains all its CanvasObjects because the callback
  can paint beyond native bounds. All native targets still participate in selection,
  hierarchy, hit testing, commands and exports. Slide/Whiteboard keep the default rendering mode.
- Design layer lists above 200 rows render a window with 36px rows and four overscan rows. Search
  uses every native layer. Arrow Up/Down and Home/End reach distant rows; selection is revealed
  when a panel opens. Focused, renamed and dragged rows remain mounted while scrolling.
- Prototype diagnosis shares frame targets across alternative histories within one synchronous
  call. No diagnostic cache trusts mutable Host identity across calls.
- #270 validates the entire native Slide source with page-local schema/hierarchy rules, extracts
  selected objects and group closure, then checks template-wide IDs. Unselected duplicate IDs on
  different pages no longer reject a valid multi-page template/reusable page capture. Duplicate
  selected IDs and malformed unselected native records still fail. Whole-template rules remain.

Native schemas, authority/permission checks, transaction history and export formats are unchanged.
The public low-level Canvas option is documented in [embedding](../../embedding.md#design-frame-prototypes).

## Workloads and diagnosis

The synthetic Design still has 94 Frames, 89 components with 20 parts each, 31 single-frame
flows and 4,888 native elements (1,144,825 JSON bytes). It is not the reported 6.2 MB artifact.
The fixture now supplies a bounded `100vh` embedding container so the Canvas viewport matches
the visible editor. Previous unbounded-container observations remain historical.

A separate desktop production diagnostic compares merged-main package sources and checkpoint
`640ce79f824030df7ac1bc149ef7a020d812522c` with the identical bounded fixture. The final application
checkpoint subsequently adds dragged-row retention and panel-open selection reveal; these
profiled samples are not relabelled as a new final-source benchmark.

| Observation                                | Merged main            | Follow-up diagnostic   |
| ------------------------------------------ | ---------------------- | ---------------------- |
| Initial load (ms)                          | 19,656                 | 7,426                  |
| Fit-all DOM elements                       | 281,464                | 194,028                |
| Layer-tree descendants                     | 87,796                 | 360                    |
| Open samples (ms)                          | 1907.2, 1593.1, 1537.8 | 1150.6, 1137.8, 1417.9 |
| Close samples (ms)                         | 1523.2, 1665.9, 1444.0 | 1189.9, 1082.1, 1194.6 |
| Style recalculation across six actions (s) | 6.318                  | 4.490                  |

Only the open/close portion has CPU profiling and tracing enabled; timings include that overhead.
Initial load has the CDP Performance domain enabled in both conditions. These three-cycle samples
are diagnosis, not p95 acceptance. They confirm that the remaining fit-all cost is dominated by
browser style/paint work over the visible SVG DOM. When all Frames are visible, culling retains them.
The viewport browser case separately focuses a Frame, checks distant selection and private input
retention, and records one unprofiled open/close sample per desktop/mobile condition.

At the final viewport-spec checkpoint, desktop mounts **4,720 DOM elements** and records
**80.5 / 41.5ms** open/close; mobile mounts **7,664** and records **98.1 / 55.2ms**.
This functional case renames/reparents and restores a layer before focusing a Frame, so these
single samples describe that focused view, not a before/after fit-all comparison.
The unchanged fit-all desktop/mutable case records **1,124.2, 1,034.6, 1,100.2ms** open and
**1,062.1, 1,002.9, 1,025.0ms** close without CPU profiling. Its projection probe remains
**14,664 →14,664**; all four mutable/owned desktop/mobile cases retain the no-reprojection invariant.

Raw logs, JSON, CPU profiles, traces and screenshots stay in ignored `work/issue269-followup/`.
The production public-API Hosts use Node 20.20.2 and system Chromium, desktop 1440×900 and mobile
390×844 emulation. Browser console errors fail the tests; physical devices are not covered.

## Verification

| Check                                            | Result                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`, application checkpoint `b4593eb8`    | **246 files / 2,567 PASS**, 9 existing optional skips; 138.93s                                                                                                                |
| `npm run build`, same application checkpoint     | PASS: TypeScript and all three production builds                                                                                                                              |
| Lint / tooling at application checkpoint         | PASS / **63 PASS**                                                                                                                                                            |
| Unchanged Design prototype production cases      | **18 PASS** from the first 20-case invocation; its two viewport fixture failures remain failed below                                                                          |
| Corrected viewport production spec at `530d1aac` | **2 PASS**, desktop/mobile: selection of all 4,888 native elements, distant search/rename, keyboard access, drag-source retention, offscreen text commit and Frame navigation |
| Targeted Design reference production cases       | **14 PASS**: changed closure hashes, pending access, live prototype images, scoped exports, cover fit and Undo                                                                |
| Shared Canvas production regressions             | **13 PASS**: independent Host/read-only, Design/Whiteboard editing/export, text/IME/history, search, Slide copy and 390/768px navigation                                      |

Unique successful targeted browser coverage is **47 cases across these invocations**. This is not
a claim that the initial 20-case invocation passed. Only the failed viewport spec changed afterward;
the eighteen successful prototype cases and application files are unchanged. Browser errors fail
the tests. Representative desktop/mobile screenshots were inspected. Final documentation, file
policy, format and local public-snapshot checks are recorded in the PR.
Final-spec TypeScript and lint checks also pass, as does the **2,166-file** guard. Changed
code/configuration and the updated/new formatted documentation pass Prettier and whitespace checks.

The #270 negative baseline, after correcting the fixture's required object index, is **2 FAIL /
4 PASS**. Focused fixed unit checks pass **15 cases** across scoped authoring, drawing snapshot
ownership and conservative paint bounds. Source/Host input remains unmodified.

The first viewport run found that clearing search lost the selected distant row from the rendered
window; selection reveal was corrected. An additional mobile private-input run timed out when
the programmatic timing click left the toolbar menu over Done. The test now explicitly dismisses
that menu before pointer-driven editing. Failed logs remain; these runs are not counted as PASS.
The subsequent 20-case invocation recorded **18 PASS / 2 FAIL** because the drag test left a child
at its original world coordinates after reparenting. Fit correctly included that distant child,
invalidating the test's offscreen assertion. The final test restores and verifies the hierarchy
before checking culling. Its fresh two-project run passes without changing the rendering logic.

## PR #272 transform-preview review

The review found that `designPreview` includes an entry for every native element, including
unchanged geometry. Retaining every preview-map member therefore remounted the whole Design
on a pointer move. A new production browser regression reproduces the pre-fix problem: the
previously culled Frame 93 mounts while Frame 0 is dragged (**1 FAIL**, expected negative
baseline in `work/review272/baseline.log`).

Canvas now compares preview position, dimensions and rotation against native target geometry,
normalizing an absent native rotation to zero. Only an actual geometry change adds preview
retention. This includes unselected descendants changed by Frame layout or rotation; unchanged
entries retain ordinary viewport culling. The public preview map and native command semantics
remain unchanged. Selected targets, private text editors and unbounded paint keep their existing
retention rules.

The new cases exercise move, resize and rotate with a pointer held down in the 4,888-element
production Host. They check fewer than 300 mounted CanvasObjects and no distant Frame, then
pan the viewport away while the preview remains active. Changed descendants stay mounted;
unchanged resize children leave the window. Escape clears the preview without changing native
content. The original offscreen selection/search/layer/private-text case is also rerun.
The desktop/mobile invocation passes **all 8 cases** (six transform-preview cases and two
existing viewport cases, 2.3 minutes, `work/review272/viewport.log`). Browser console errors
and uncaught exceptions fail these tests. Representative desktop/mobile preview screenshots
were inspected. This run covers production Chromium and mobile emulation; dev/StrictMode and
physical-device coverage are not claimed.

At checkpoint `ef280b25`, related unit checks pass **28 cases across four files** (Design
advanced geometry, drawing snapshots, paint bounds and Editor Core advanced geometry).
TypeScript and all three production builds pass, as do lint and the 2,166-file guard.
These targeted checks supplement the original 2,567-unit run above; that full unit suite was
not rerun for the review fix. Raw review logs and screenshots stay in `work/review272/`.

Reproduce the targeted checks:

```sh
npm test -- packages/design/src/design-advanced.test.ts packages/design/src/render-cache.test.ts packages/design/src/paint-bounds.test.ts
npm test -- packages/editor-core/src/geometry-advanced.test.ts
npm run lint
npm run build
npx playwright test --config playwright.design-prototype.production.config.ts tests/e2e/design-virtualization.spec.ts --output work/review272/viewport
```

## Remaining acceptance

This section records limits at this earlier checkpoint. The subsequent
[completion](completion.md) addresses clipped screen text and offscreen Document rendering.
At this checkpoint, fit-all mounts every visible Frame and remains above 500ms in these diagnostic samples.
The original consuming artifact/Markdown and its dev/StrictMode environment are NOT RUN here.
Document paragraph virtualization is not implemented; #271's local-input correction is retained.
No full-scene level-of-detail/raster preview or consuming-application latency guarantee is claimed.
The full-scene target and real-data confirmation remained open here. #270 subsequently closed
when #272 merged. No CI dispatch, public sync, deployment or broad performance acceptance was performed.
