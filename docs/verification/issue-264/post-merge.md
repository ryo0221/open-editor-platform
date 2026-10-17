# #264 post-merge corrections

2026-10-17 JST. Base main `454853cce5e86826f1559840542b3e4ffc484db4` (PR #39 merged).
Application and regression-test commit: `e381fbd52902ec72237e85b03b13adab62c64611`.

PR #265 left three actionable review comments after merge:

- `discussion_r4295550396`: the independent Host parsed retained destination versions without validating their native content or retained reference hashes.
- `discussion_r4295550421`: saving a captured version overwrote persisted draft bytes while the live EditorSession still held the original draft.
- `discussion_r4295550431`: Playground rejected template/reuse authoring for a whole artifact before checking the selected scope.

The independent Host now validates all four destination histories at bootstrap, including inactive destinations. It checks array/native shape and validates retained references with `capture(..., false)`. Validation does not replace versions with normalized captures or overwrite corrupt storage. Navigation uses the validated owned history arrays. Saved versions receive captured references; persisted drafts continue to match the live Session content.

Playground opens the authoring dialog with the canonical native content and selection. Existing template/reuse selection helpers continue to reject references within the actual chosen scope. Whole-artifact authoring with references remains unsupported; clean fragments beside unrelated references can be previewed.

## Verification

Node 20.20.2; Chromium desktop 1440×1000 and mobile/touch emulation 390×844. Generated screenshots/logs remain in ignored `work/`.

- Production browser regressions: **38 PASS**, 19 scenarios each on desktop/mobile. Coverage includes all four destinations with fixed/follow source updates, unchanged persisted draft bytes after saving a captured version, invalid history arrays/native entries, corrupt retained hashes in inactive destinations, whole-artifact authoring rejection and clean-fragment preview, and save/export destination-change guards. Browser console errors fail these tests.
- Production build: **PASS** (`npm run build`, including TypeScript and all three Vite builds).
- Desktop/mobile Slide screenshots inspected: source update rendered after save/reload; native Host controls remained available.
- Test setup corrections: the new authoring test first waited for an artifact menu on the empty landing page, then used a label query that did not match the select. Creating an initial artifact and selecting the combobox by role fixed the test. Those incomplete runs are not counted as passes.

- Full workspace unit suite: **243 files PASS, 2552 tests PASS, 9 existing optional skips** (141.51s).
- `npm run typecheck`, `npm run lint`, `npm run test:tooling`, `npm run check:files`: **PASS**. Tooling: 63 tests; file policy: 2152 files checked.
- Public export of documentation commit `996b5d65`: **1710 files PASS**, manifest/residual scan PASS (`npm run public:check -- work/issue264-public`). Snapshot `49f4af8f2d6b1b7db90b1e15f4ace3b50f8a3580b3005474137e3fd2b123815d`; local-only export, no public sync. The earlier 248-case review matrix is not rerun in full. No CI dispatch, deployment, public sync or performance measurement is included. Browser emulation does not certify physical iOS/Android devices.

## PR #268 review follow-up

The review identified two reachable gaps: constructing a new resolver for each retained version lost cross-version immutable identity checks, and reducing Slide selections to object IDs lost their page scope.

Bootstrap now uses one destination-scoped resolver for its draft and all versions. Individually valid snapshots that contradict the same source revision/version identity are rejected together. Authoring carries optional `{pageId, elementId}` Slide selections through the Host, template dialog and reusable-component dialog into native selection. The Slide Surface now emits its page ID in the optional third selection callback argument, and the Host preserves it. Page filtering precedes template-wide ID validation; group expansion happens separately on each selected page. Whole-artifact authoring still checks the entire artifact; callers without page-scoped selections retain the existing ID-only API behavior.

The production regressions now include draft/version and version/version hash conflicts plus Template and reusable-component preview with a clean selected object whose ID is reused by an embedded reference on another page. Implementation/test pin: `be693d25bc3407d18bd0faf21f64f07df9007608`.

During regression development, the two authoring browser cases exposed both the template-wide duplicate-ID precheck and the missing page ID in native selection notifications. Those failed runs prompted the two corrections above; they are not counted as passes. The saved-version conflict cases passed after sharing one resolver across the complete history.

Final verification at that implementation/test pin:

- Production Chromium desktop/mobile: **42 PASS**, including both cross-history identity conflicts and page-local Template/reusable authoring. Existing save/export guards and all four destination fixed/follow/save/reload flows remain covered. Mobile Slide screenshot inspected.
- Full unit: **243 files PASS, 2552 tests PASS, 9 existing optional skips**, 129.46s.
- TypeScript (production build), all three Vite production builds, full lint, tooling **63 PASS**, file policy **2152 files PASS**, changed-code Prettier check: **PASS**.
- Full 248-case review matrix, physical devices, full shared-editor browser matrix and performance measurements remain **NOT RUN** for this follow-up. No workflow dispatch, deployment or public sync.

### PPTX diagnostic navigation follow-up

Review `discussion_r4300398114` identified that diagnostic navigation queued a new active page but immediately reported selection with the old rendered page ID. `choose` now accepts an explicit target page, and PPTX navigation passes `address.slideId`. Ordinary selections retain their default current-page behavior.

A production regression imports two pages with the same object ID but different text, navigates to page 2 using a real PPTX diagnostic, closes the export panel, then checks that Template and reusable-component previews contain page 2's text and exclude page 1's text. Implementation/test pin: `5f3242c4159cf21b8231e633c52472099934c2c3`.

- Production Chromium desktop/mobile: **44 PASS**, including the new diagnostic navigation regression and the preceding 42 scenarios.
- Slide unit suite: **2 files / 17 PASS**. Full workspace unit results above belong to the preceding `be693d25` implementation pin; the full suite was not repeated for this three-line callback correction.
- TypeScript plus all three production builds, full lint, file policy: **PASS**. Diagnostic authoring screenshot inspected at the mobile viewport.
- Full review/shared browser matrices, physical devices and performance remain NOT RUN; no workflow dispatch, deployment or public sync.
