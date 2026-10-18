# #269 clipped Design text and large Document rendering

2026-10-17 JST. Base main: `f51a50eb6cee596e60143add9f8b58203781a0b0` (PR #272 merged).
Its tree `717734279d3b3b1a34aca2682b439cb33c1966f6` matches local base
`c34477e1c2ddaba09b1625fcde4fc61e3de47aaf`. This continues the owner's targeted #269
request, including the explicit instruction to resolve #269. Its targeted tuning and checks
do not lift the pause on general performance acceptance, unrelated tuning or Actions.
Application/spec checkpoint: `aa5235fc6e13ac3035054201d15a00a73de4f6a8`.
Final shared-regression spec: `8704f35472d4d32922ec671629981bf0ad2fb5e1` (confirmation wait only).
The later PR #273 review correction is recorded separately below.

## Changes

The remaining Design cost came from SVG text lines outside their existing native clip.
Even a tiny text box mounted every wrapped line. A native modal then restyled that large
editing DOM, despite the retained drawing projection from #271/#272.

`DrawingView` now requests `visibleTextOnly` primitives. The text layout still uses the full
native text, including fit sizing and vertical alignment. Screen primitives retain lines near
the existing clip with four maximum-font ems of overscan; expanded text retains every line.
The complete text is assigned to the inner SVG text's `aria-label`. `CanvasStage` buttons
still use their explicit `CanvasTarget.label`; their presentational descendants do not expose
that inner label as the button name. Full-text screen-reader access through Design, Slide and
Whiteboard canvas objects is not established by this change. SVG/native/Office exports use the
default full primitives. Positions use one cumulative line offset, replacing repeated prefix scans.
No rasterization, low-resolution preview or content/schema mutation is introduced.

Documents above 200 native blocks use browser-assisted `content-visibility: auto` on top-level
paragraphs, headings and code. Measured heights are remembered with intrinsic-size fallbacks.
All ProseMirror/native nodes remain mounted for selection, search, history and output.
Selection endpoints stay rendered through private node decorations. Find and outline focus
the editor before requesting ProseMirror's scroll, so its native selection geometry is available.
Unsupported CSS falls back to full rendering. Print media uses full rendering.

The previous owning snapshots, mutable Host checks, native transactions, permission checks and
full-content selection/export contracts are retained.

## Workloads and protocol

- Design: the same bounded public Host with 94 Frames, 89 components with 20 parts each,
  31 flows and 4,888 native elements (1,144,825 JSON bytes). Fit-all keeps every Frame visible.
- Document: a bounded public Host with 400 headings and 400 paragraphs, 137,489 UTF-8 text
  bytes. Owned and fresh mutable-copy Host acknowledgements are both exercised.
- Node is 20.20.2; system Chromium is 151.0.7922.173 on Linux, with a four-CPU cgroup quota.
  Desktop is 1440×900; mobile is Chromium iPhone 13 emulation at 390×844, including its device
  scale factor. These are emulated conditions, not physical devices.
- Production public Hosts use production React/esbuild. Development uses actual Vite with
  React StrictMode through the independent Host configuration.
- Each measured condition has five warm-up actions and twenty measured actions. Prototype
  open and close each have twenty measured samples; Document has twenty measured keystrokes.
  p95 is the nearest-rank percentile within each condition. Cold samples remain in the raw data.
- Action timing starts at the actual DOM click or `beforeinput` and ends after two animation
  frames, excluding driver round trips. Input includes Host acknowledgement/rendering.
  Workers run serially, without concurrent unit/build jobs during measurements.
- The targeted checks are 500ms for prototype open/close and 100ms for input. They do not
  certify the repository's paused general budgets or the original consuming application.

## Initial diagnosis

With the same bounded production Host, the diagnostic recorded 194,028 DOM nodes before the fix
and 52,664 after it. Load observations were 13,502ms and 2,474ms. After two warm-up cycles,
the five before samples were about 1.05–1.17s open / 1.06–1.14s close; the five fixed samples
were about 0.285–0.301s open / 0.265–0.277s close. These diagnostic samples are separate from
the twenty-sample acceptance checks. The fit-all screenshots are pixel-identical.
Drawing visits, drawing callbacks and native content remain unchanged across toggles.

Raw reports, failed attempts, screenshots and traces remain in ignored `work/resolve269/`.
The earlier [first fix](README.md) and [viewport follow-up](follow-up.md) retain their own
conditions and results; their historical runs are not relabelled as this final implementation.

## Development verification

Actual Vite/React StrictMode checks pass eight conditions across three invocations. Desktop
Design's two successful cases are retained from `dev-observation-fixed` (its Document fixture
failure and interrupted remainder remain failed/not run); the subsequent Document navigation
correction does not change Design files. `dev-document-focus` passes all four Document cases,
and `dev-mobile-design-final` passes both mobile Design cases. The final code has no delayed
scroll retry: focus precedes ProseMirror's native selection scroll, with active text pinned.

| Domain / Host                | Desktop p95 (ms) | Mobile p95 (ms) |
| ---------------------------- | ---------------- | --------------- |
| Design mutable, open / close | 358.9 / 285.3    | 381.7 / 297.4   |
| Design owned, open / close   | 333.2 / 283.8    | 357.4 / 299.3   |
| Document mutable-copy input  | 74.3             | 31.1            |
| Document owned input         | 59.1             | 60.4            |

All twenty-sample p95 checks meet their unchanged 500/100ms thresholds. Drawing callbacks,
projection visits and native content remain unchanged during toggles. Document retains 799/800
untouched blocks per local key after initialization, and skips text paint for 776 desktop /785
mobile blocks at the measured point. Its successful cases also cover offscreen find/outline,
editing, Undo/Redo, native-content equality during navigation, whole-document selection and print.

## Production verification

The independent production invocation passes **all 10 cases** in 2.5 minutes, at `aa5235fc`:
four Design conditions, four Document conditions and two desktop/mobile pixel comparisons.
All four Design conditions retain fit-all and the same 4,888 native targets; mounted DOM is
52,664 desktop /52,388 mobile. The pixel checks cover twelve drawings with clip/fit/expand,
top/middle/bottom and left/center/right alignment, mixed fonts, tight line height, decorations,
rotation/flip, shapes and table cells. Full and pruned screen images are exactly equal.

| Domain / Host                | Desktop p95 (ms) | Mobile p95 (ms) |
| ---------------------------- | ---------------- | --------------- |
| Design mutable, open / close | 300.5 / 299.6    | 322.0 / 317.1   |
| Design owned, open / close   | 320.5 / 301.4    | 303.5 / 289.0   |
| Document mutable-copy input  | 29.0             | 23.6            |
| Document owned input         | 27.7             | 26.7            |

This gives sixteen successful measured conditions (eight production, eight Vite/dev) plus two
pixel cases. It does not turn any failed or interrupted development invocation into a PASS.

## Repository checks

At application/spec checkpoint `aa5235fc`, the complete unit suite passes **247 files /
2,573 tests**, with 9 existing optional skips (133.61s). TypeScript, all three production builds,
lint, **63 tooling tests**, and the **2,174-file** size guard pass. The source/build/font hash
manifest is retained in `work/resolve269/source-manifest.json`. Application and unit files stay
byte-identical through the original documentation checkpoint `58ed8d4b`. The final shared-regression
spec adds the acknowledgement barrier described below. The later review correction changes only
DOCX navigation ordering in application code and adds its own browser regression.

Targeted successful browser coverage totals **55 conditions across invocations**:

| Group                                                                     | Successful conditions                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Production budget/pixel checks                                            | 10                                                                 |
| Vite/dev StrictMode budget and functional checks                          | 8                                                                  |
| Ordinary Design prototype/viewport regression                             | 22 (21 from the initial run, plus the final corrected shared case) |
| Ordinary rich Document regression                                         | 2                                                                  |
| Shared Canvas/independent Host/Slide/Whiteboard desktop/mobile regression | 13                                                                 |

The final focused shared case passes after the confirmation barrier. The ordinary Document
cases cover rich editing, IME, tables/Mermaid, persistence/output and anchored-comment Undo.
Shared Canvas cases cover native geometry/history, Japanese text fit, Inspector Undo, read-only
independent Hosts, mobile panels, Slide copy selection and Whiteboard search. Browser console
errors/uncaught exceptions fail the fixtures; representative screenshots were inspected.

## Failure history

Initial Vite setup attempts used the Playground root, an absent root readiness page, and then
an IPv6-only listener. The independent Host config/readiness URL/IPv4 binding correct those
setup errors; they are not accepted as timing runs. A subsequent run met timing thresholds but
failed the console-error guard on a missing fixture favicon, a mistaken self-visibility probe,
and a mobile pixel comparison that mixed world/local ellipse origins. Fixtures now supply an
inline favicon, observe native skip-state events, and compare full/pruned text at matching origins.
The pixel assertion remains exact, with no tolerance added.

The first outline locator omitted its existing `H2 ·` prefix and was corrected. Mobile find then
exposed a real navigation regression: focusing after dispatch bypassed ProseMirror's native
selection scroll while skipped content changed geometry. Pinning active text and focusing before
dispatch correct it. An experimental delayed scroll retry did not solve that focus issue and is
absent from the final code. The initial text unit check also had one fixture assertion that assumed
a table's wrapped text was one contiguous SVG run; it was corrected and all ten focused units pass.
Failed and interrupted logs are retained rather than counted as successful checks.

The ordinary 22-case Design run recorded **21 PASS /1 FAIL**: the shared metadata case
observed a peer's Redo projection before its originator had confirmed it, so the following
metadata edit correctly hit `stale-precondition` and was retained. An unchanged focused run
passed. The final spec explicitly waits for both clients' confirmed state before starting
that next accepted-path edit. It keeps the authority checks and all field/history assertions.

## PR #273 review correction

Runtime and browser-spec checkpoint: `6ef4a5cb64ca5e2544da7e011c6747df6ae9bde0`.
Final browser-spec checkpoint: `edfdb9f0fda1dfacdf4a0b2767c2b5b208f36387`.
DOCX diagnostic navigation now focuses the editor before dispatching `jumpToBlock`, matching
find/outline navigation. Selecting warning text in the export panel leaves the DOM selection
outside ProseMirror; the previous dispatch order then skipped its scroll. The regression uses
a valid 403-block native Document, a half-point size diagnostic on the last paragraph, and
the real DOCX preview worker and navigation button. It checks focus, visibility, active text
rendering and unchanged native content.

The initial simple-button checks passed on the previous build because selection remained in
the editor. With warning text selected, the regression failed on both desktop and mobile:
the target remained outside the viewport. Those logs are retained under
`work/resolve269/review-selection-before*` alongside the final checks.

Production functional coverage succeeds in **14 conditions across invocations**: ten DOCX
conditions (five on desktop and mobile), plus four large Document copy/owned Host cases with
the measurement flag unset. DOCX covers the new distant diagnostic, unchanged native content
and history, ordinary API/output parity, Mermaid/source consent, cancellation and worker-owned
image bytes. Large Document checks retain search/outline, distant editing, Undo/Redo, full
selection and print assertions. The final diagnostic screenshots were inspected on both viewports.

The first full DOCX run was **9 PASS / 1 FAIL**: the older D11 fixture looked up a visible header
Undo button on mobile, where the responsive toolbar hides it. The final fixture reads that same
action's enabled state with `includeHidden`, retaining the before/after history assertion.
The final focused diagnostic/D11 run passes all four desktop/mobile conditions (13.8s); the six
unmodified DOCX cases retain their successful checks from the first run. The separate large
Document run passes all four conditions (19.8s). The failed run is not relabelled as all-pass.
The ignored review runner reuses the repository's desktop/mobile project settings, overrides
file matching for `office-docx-ui.spec.ts`, runs one worker and serves the ordinary production
Playground at port 4173. It does not replace the DOCX UI or worker with a mock.

At the final browser-spec checkpoint, the complete unit suite passes **247 files / 2,573 tests**
with 9 existing optional skips (158.63s). Final TypeScript, lint, 63 tooling tests and the
2,174-file guard pass. All three production builds pass at runtime checkpoint `6ef4a5cb`;
application and unit files remain byte-identical through the final browser-spec checkpoint.
The build/browser jobs completed before the unit and final static/tooling checks.

The accessibility wording above and in the embedding contract now distinguishes the inner
SVG `aria-label` attribute from the explicit parent Canvas button name. It does not claim that
the full text is exposed through ordinary Design/Slide/Whiteboard Canvas objects.

The measurement-pause review was checked against the owner's explicit #269 instruction.
The existing opt-in checks remain limited to that authorized issue; general acceptance,
unrelated tuning and Actions stay paused. This review correction adds functional checks and
does not rerun timing budgets or replace the earlier checkpoint's timing evidence.

## Reproduction

Use the repository's Node 20.20.2 setup, fonts and system Chromium/Playwright browser.
The explicit measurement flag applies only to #269:

```sh
npm run build
ISSUE269_MEASURE=1 npx playwright test --config playwright.issue269.acceptance.config.ts --output work/issue269-production
ISSUE269_DEV=1 ISSUE269_MEASURE=1 npx playwright test --config playwright.issue269.acceptance.config.ts --output work/issue269-development
```

Without `ISSUE269_MEASURE=1`, the functional tests use their shorter action sequences.
No CI dispatch, public synchronization or deployment is part of these commands.

## Scope of the evidence

The original 6.2MB Design and 83KB Markdown files were not available in this workspace.
They and the consuming application's own Host/environment are NOT RUN. The structural
workloads and independent production/dev Hosts above are the evidence for this fix.
The synthetic Design has fewer JSON bytes and more mounted SVG nodes than the reported
consuming scene. No universal latency guarantee or real-device acceptance is claimed.
