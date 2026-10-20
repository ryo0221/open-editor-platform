# #38 / #261: default React builds and native decoder evidence

**Later disposition, 2026-10-18:** the owner authorized the
actual consuming frontend trial, which passes on the
same application source below. #38 is ready for closure on PR #284 adoption.
The owner also directed closing #261 as currently unreproduced and reopening on
recurrence. Its historical cause remains unproved. Neither PR #283 nor #284 was
merged at that checkpoint; the open/unrun statements below describe that earlier state.

## Merge review follow-up (2026-10-18)

The owner requested adopting PR #283 and #284 and closing completed issues.
Three review findings were checked before merging. PR #283 source
`8551011a` includes the input corrections; combined source and final browser tests
are at **`0283f8137b22b73d59e6a167409478e63fc560da`**. Subsequent edits are documentation.

- Preview input commands now propagate the Host's `false` result and thrown rejection
  through CommitInput. Invalid drafts remain pending and block version save until
  corrected. The public Surface execute signature accepts boolean or void, preserving
  existing void Hosts. Page-contract JSON also reports rejected execution.
- A present null fixture overrides its default; only an absent key uses the default.
  No fixture or immutable version is rewritten by rendering the controls.
- Current status describes the authorized consuming-frontend trial as passed within
  its declared scope. Earlier NOT RUN results remain historical.

New unit coverage compares explicit null with missing string/boolean fixtures.
Production desktop and mobile scenarios reject an over-length string and out-of-range
number, verify pending drafts block save, correct and commit both, then save/reload
without changing null or absent fixture values. Existing Japanese sample, save dialog,
reference discovery and accessible text scenarios also pass. Browser errors fail the run;
desktop/mobile recovery screenshots were inspected.

Final checks: **2,659 units PASS / 9 existing optional skips / 258 files** (2,651 in
the normal cohort and 8 in the unchanged fresh-process Office cohort, including I07),
lint and strict TypeScript PASS, all three production builds PASS,
`playwright.next-priority.config.ts` **10 PASS** across desktop/mobile, changed-file
format/whitespace and file policy **2,301 files PASS**. These are the new merge-review
checks, separate from the earlier 25 browser cases and the external-source trial.
No benchmark, Actions dispatch, public sync or deployment was performed.

The first new test fixture omitted required field flags, so strict TypeScript rejected
it. The first browser run was **7 PASS / 3 FAIL**: the new string limit exceeded the
existing bound prop's type and correctly rejected the page contract; an existing form
test typed before the interaction-mode render was ready. Fixture flags and a narrower
limit were corrected; the test now awaits the actual interactive mode and verifies
the controlled value before submission. Final assertions retain save rejection,
callback output and persistence checks, with no deadline increases or automatic retries.

Logs: `/tmp/editor-merge-review-units.log`, `-lint-final.log`, `-build-final.log`,
`-browser-final.log` under that prefix. Failed attempts remain in
`/tmp/editor-merge-review-build.log`, `/tmp/editor-merge-review-browser.log` and
`/tmp/editor-next-priority-results/`; final screenshots are in
`/tmp/editor-merge-review-browser-final-results/`. None is committed.

## Earlier implementation checkpoint

Verified locally on 2026-10-18, starting from PR #283 source
`9ce7a3c599cd367dd0d33c30db4d6623cc7748fd` on
`fix/output-and-verification-followups`. This is a separate PR stacked on #283,
which was still open when work began.
Application and regression source: **`99f3046f9500611c51d0d5057b995a9a32b0af29`**.

The code changes fix the reproduced default-Vite build stall and make new native
image failures distinguishable. **#38 remains open for consuming-product trials;
#261 remains open for the historical I07 cause.** Neither earlier failures nor
unrun trials are converted to PASS.

## Default tree-shaking: reproduced and corrected

The ordinary Design dependency ZIP from #283 supplies the fixed source, original
React modules, aliases, CSS/image and Provider. Removing only the existing
`treeshake: false` reproduced a stall with Vite 6.4.1 / Rollup 4.64.0 /
React and ReactDOM 19.1.1. A debugger pause captured repeated Rollup
`includeCallArgumentsOfPossibleValues` / `includeCallArgumentsWhenCalledAtPath`
frames. The diagnostic process was stopped explicitly; it was not successful.

The upstream [Rollup #6565](https://github.com/rollup/rollup/pull/6565), released
in 4.64.3, corrects path-dependent explosion in this call-argument analysis.
Updating only Rollup and its matching native packages to **4.64.9**, then running
fresh `npm ci`, lets the same source/configuration finish with default tree-shaking.
Vite, React, ReactDOM, original component sources and generated TSX are unchanged.
The committed lock stays within Vite's supported Rollup dependency line.

| Lock           | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| #283 base      | `2c0f2c5d0c46973ab04c759d4f0689cbfc61264004f6d5f4b9fd774821a7b3e9` |
| This follow-up | `7faa4481f17482d768ce94713004f8b6aacb58caec8949ed483a73d4fac6d81f` |

The ordinary `react-ui-export-host.mjs` and `design-react-export-host.mjs` now
omit the workaround. Each compiler/build child has a 60-second diagnostic deadline
and records launch/deadline code and signal on failure. This is a bounded verification
command, not a performance acceptance budget or a mandatory setting for other Hosts.
The frozen scale/performance driver remains unchanged and was not measured.

Independent strict TypeScript, production build and browser checks cover:

- Five React-only apps: unbound, product, form, revised and a separate typed portable Host.
- Ordinary Design's component, page and site entries, including the dependency fixture.
- 390 / 1024 / 1400px display, original CSS/PNG/Provider, named/default imports and slot.
- Actual callbacks, controlled input, route navigation, native persistence and regeneration.
- Empty-slot defaults, byte-stable TSX after save/reload and preview/export comparisons.

This reproduces and resolves the repository fixture's fault. It does not retroactively
identify every detail of the original external-product report; that product's actual
registration/material trial remains NOT RUN.

## Decoder failure classification and child lifetime

The previous message combined rejection and time limit and discarded exit signals.
`OfficeImageDecodeError.diagnostics` now preserves:

- Distinct input rejection, conversion failure, startup failure, external signal,
  timeout, cancellation and output-limit causes.
- Actual exit code/signal, startup error code, operation and output byte count.
- Input SHA-256, byte count, MIME and declared dimensions; no image bytes.
- Diagnostic elapsed time and at most 4,096 stderr characters.

The trusted child uses separate exit codes for loading and PNG conversion failure.
The parent records when it initiates deadline/abort/output-limit termination, waits
for `close`, clears the deadline and removes the abort listener. Public cancellation
retains AbortError. The **10-second decoder deadline, image/pixel/output bounds and
subprocess isolation are unchanged**; no retries, caches or deadline increases were added.

Eight new tests use real child processes. They distinguish the exit paths, bound stderr,
exercise SIGTERM, missing executable and output overflow, confirm timeout kills/reaps
the child, and test cancellation followed by another successful operation.

A real 13-byte incomplete GIF with declared 1x1 dimensions produced a native
**SIGSEGV**, `exitCode: null`, `reason: signal`, with no output bytes. Exact input:
`e166f869cdc0a87f67fc5841ad08082c87d0ffa3c1d677956415ea3110e1fd3f`.
The parent survived and decoded the valid pinned PNG afterward. The test also permits
a native build to reject cleanly, but requires that the diagnosis match its actual exit.
This demonstrates crash containment and evidence retention, not that native codecs
can never terminate on malformed input.

The historical I07 input/exit evidence is absent, so this SIGSEGV is **not attributed
to that old failure**. Current I07 passes within its existing deadline in the complete
unit command. Its fresh-process cohort remains unchanged. No old timeout, failed run
or worker RPC error has been relabeled as a pass.

Host detach/reattach recovery also passed **before the changes**, including pending
input, failed persistence, resumed synchronization, permissions and reload. It passed
again on the new production build. The previously absent `Host sync status` locator
was not reproduced, and no speculative lifecycle patch was made.

## Checks

Linux x64, Node **24.19.0**, npm **11.9.0**, Playwright **1.63.0** and system
Chromium **151.0.7922.173**. Mobile cases use Chromium touch/viewport emulation.

| Command / scope                                                      | Result                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Fresh `npm ci`                                                       | PASS; four fixed Office font SHA-256s verified                                  |
| `npm run build`                                                      | PASS: main, isolated React preview and artifact Host                            |
| `npm run lint`, `npm run typecheck`                                  | PASS                                                                            |
| `npm test`                                                           | **2,658 PASS / 9 existing optional skips / 257 files**, including new 8 and I07 |
| `npm run test:tooling`                                               | **90 PASS**                                                                     |
| `playwright.react-ui-portability.config.ts`, workers 1               | **19 PASS**, including 3 mobile                                                 |
| Design dependency ordinary-UI scenario                               | **1 PASS**, all 3 independent entries                                           |
| Final production Host recovery / security / Office Mermaid selection | **5 PASS**                                                                      |
| Node 20.20.2: new decoder cases and default Vite site build          | **8 PASS**, build PASS                                                          |
| `npm audit --json --omit=dev`                                        | **3 high package records**, unchanged bounded dispositions                      |

The new-build browser total is **25 distinct cases**. The earlier Host baseline is
separate. Screenshots of the default-built dependency page, typed portable Host and
mobile form were inspected. Browser page/console errors fail these cases.
Main/worker security inventories retain corrected Mermaid/KaTeX/DOMPurify and exclude
the image-size parser and PDF viewer/scripting paths. Runtime notices are preserved.

The first negative decoder fixture corrupted PNG data, which the native codec accepted;
those assertions failed. The replacement incomplete GIF exposed an actual signal rather
than the initially expected clean rejection. Assertions were corrected to require explicit
exit/signal classification, and the complete final suite passes. A temporary diagnostic
CommonJS setting was first placed under esbuild incorrectly and rejected; after correcting
that diagnostic configuration, it still reached its 25-second deadline. Neither setting
is in the final implementation. These failures remain in the raw logs.

Raw logs/audit/diagnostics: `/tmp/editor-followups-*`, including the debugger stack,
pre/post-update builds and the real decoder JSON. Independent source, ZIP and build:
ignored `work/issue-24/`, `work/issue-29/`, `work/issue-29-dependencies/` and
`work/issues-38-261/`. Screenshots/traces: `/tmp/editor-followups-design-results/`,
`/tmp/editor-followups-portability-results/` and `/tmp/editor-followups-host-security-results/`.
No generated bundle, binary image, ZIP, build, font or raw log is committed.

Final changed-file Prettier and Git whitespace checks pass. File policy passes
**2,299 files**; tooling was rerun after the public-export policy update and passes
all **90** cases. The pinned native codec is `@napi-rs/canvas@0.1.100`.

Firefox/WebKit, physical devices, OS input methods, external consuming-product trials,
the entire repository browser suite and deployment validation are **NOT RUN**.
Actions, public synchronization and deployment remain paused. No performance benchmark,
tuning, fixed-workload remeasurement or new performance acceptance was performed.
