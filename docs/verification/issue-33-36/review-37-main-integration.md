# PR #37: main integration and final two findings (2026-10-16 JST)

## Source and scope

Original PR head: `3da6d2cbc6a4d5e414d7596639471877ee3b6701`.
Integrated main: `6a719303ddd4f634eca950c2c9e45663fcb7d562` (PR #265 merged).
Application/browser verification pin: `dd9251bb525d2292f29580efca0271ac5ce205f8`.
Its executable changes are `4bd7507f` and `a3891b6a`; dd9251bb adds contract text.
Later source-provenance/public-snapshot and report changes do not change application
or package runtime blobs. Results below remain attributed to the tested pin.

The first merge preserves both branches' status sections. The PR #265 merge keeps
both reference-adapters and reference-artifact-host workspace links in the lock.
Native Surface callbacks now return void from the reference Host's domain adapter;
commands still pass through ArtifactEditor validation and permission/history checks.
No source update is adopted as a local snapshot Undo or alternate content store.

## Review corrections

- **4231397379 / disposable Code realm.** Each successful Studio execution gets a
  new keyed opaque iframe, including identical-source reruns and sample reset.
  The old frame cannot receive the next execution envelope. A source/frame/origin
  checked ready/connect handshake sends code once to the current frame; repeated
  ready messages after execution cannot rerun it. Existing token/generation checks
  still guard transcript, errors and microphone requests. Recognition is stopped
  before rerun. Browser tests retain old iframe handles, verify their detachment,
  reject old globals/listeners, count one execution despite duplicate ready messages,
  and exercise same-source rerun, reset and stale recognition callbacks.
- **4231397389 / unsaved list artifacts.** Import and duplication add their IDs to a
  Host-owned unpersisted set independently of Session dirty state. Before opening a
  Session, after opening a clean draft, and after returning to the list, unload remains
  guarded. A failed storage write keeps the guard; only successful persistence clears
  it. Two cases run on both Hosts and viewports and verify native content, retry,
  reload and restored content. Original seed samples alone remain unguarded.
- Custom Code's intrinsic height keeps Host capability text below its preview at
  narrow widths. This corrects an actual pointer interception seen in the malformed
  error regression. Ordinary native Surfaces and the default reference Code layout
  retain their existing fixed-height rules.
- The current Studio build no longer requires the archived pre-Host preview source.
  That optional archive and its tests remain distinct from current Studio acceptance.

## Commands and final results

Linux; Node 20.20.2/npm 10.8.2; repository-pinned Playwright 1.63.0;
Chromium 151.0.7922.173; desktop 1440x900 and mobile emulation 390x844.
All four fixed Office font files retain their manifest SHA-256 values.

| Command / scope                                                                                | Result                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run lint -- --quiet`, `npm run typecheck`                                                 | PASS                                                                                        |
| `npm test`                                                                                     | 238 files, **2494 passed / 9 skipped**, final repeated full run at application pin          |
| `npm run test:tooling`                                                                         | **61 passed**, no skips; repeated after snapshot policy changes                             |
| `npm run check:files` / changed-file Prettier / `git diff --check`                             | PASS; 2128 source files, zero size failures                                                 |
| `npm run build`                                                                                | PASS: Playground, React preview and independent Artifact Host; existing chunk-size warnings |
| `node scripts/sync-studio-source.mjs work/issue37/studio VERIFIED_COMMIT`                      | Source-only copy; 606 copied blobs verified at source-tool pin `0ebb050e`                   |
| Studio `node scripts/build.mjs`                                                                | PASS, production esbuild bundle                                                             |
| `npx playwright test --config playwright.host.config.ts`                                       | **38 passed / 8 fixture-only skipped**, desktop/mobile, workers2                            |
| `HOST_STUDIO_URL=http://127.0.0.1:8877 npx playwright test --config playwright.host.config.ts` | **38 passed / 8 fixture-only skipped**, desktop/mobile, workers2                            |
| `node scripts/verify-host-react-output.mjs ACTUAL_UI_ZIP`                                      | PASS: strict TypeScript, React-only production bundle, opaque browser render, zero errors   |
| Local public snapshot export/manifest/residual                                                 | PASS: 1688 files; export, manifest and residual checks; no remote synchronization           |

The reference Host skips four Studio-only voice/runtime cases on two viewports.
Studio skips four injected access/storage fixture cases on two viewports. These are
not accepted missing features or newly disabled tests. Browser-error fixtures remain
active. Neither workers, retries, expectations nor deadlines were relaxed.
Desktop imported-artifact and mobile Code-reexecution screenshots were inspected:
unsaved labeling is visible, the current execution count is one, and capability text
no longer overlays the preview. Raw logs, traces, screenshots and downloaded ZIPs
remain ignored under `work/issue37/`.

## Failure history and fixture diagnosis

- On the integrated implementation before the two fixes, the new unload cases fail
  on both viewports (4 failures); the old-realm regression fails on both (2 failures).
  Original baseline reports and traces are retained outside Git.
- The first corrected focused run passed unload4 and Studio5/6. The mobile error
  button was intercepted by Host capability text; the intrinsic-height fix above
  corrects the actual overlap rather than forcing the click.
- The first expanded Studio run had **31 passed / 7 failed / 8 fixture skips**.
  Subsequent intermediate mobile attempts also fail and are retained. Diagnostics
  distinguish missed parent pointer delivery after scrolling from an offscreen
  opaque frame's rAF-based actionability checks waiting indefinitely before the
  frame owner is scrolled into view. A same-runtime control records no delivered
  DOM pointer events in 3/3 direct-click attempts and delivered pointer/click plus
  the expected syntax error in 3/3 explicit-scroll attempts.
- Code fixture actions now scroll and hover before one normal pointer click. Inner
  actions first bring the iframe owner into view, then use normal actionability
  checks. There is no second-click rescue, forced click, direct handler invocation,
  arbitrary sleep, error filter or added retry. The browser-internal compositor
  mechanism is not proven. Physical first-tap behavior is not certified.
- The adjusted mobile subset passes **8/8**, followed by the complete Host suites
  above. These subset executions are not added to final suite counts.
- Initial dependency installation used an unwritable default npm cache; reinstall
  with `/workspace/.npm-cache` succeeds. The font downloader's 180-second transfer
  timeout caused repeated partial archive downloads. A task-local longer transfer
  retrieved the same official URL; exact size and SHA-256 were checked before the
  ordinary pinned extraction. No download code, hash, font or fallback rule changed.
- Intermediate type checks caught the Surface callback return contract and a test
  screenshot parameter. Both are corrected. Source synchronization initially rejected
  an uncommitted support README as intended; the later pin includes that text.

## Public/source-tool compatibility

A local public export initially rejects four old PR paths for product/private-source
literals. The canonical docs use consuming-side language; source provenance now
records the checkout's actual origin owner/repository without a hard-coded private
name. Only the repository path is retained, never credentials or host selectors.
The copied-source test accepts the repository-name shape and still checks the exact
commit and every blob hash. Snapshot policy explicitly includes the Artifact Host
Vite/Playwright configs, Host contracts and this record. No forbidden scan rule is
removed or weakened and no private-dependent file is excluded to hide the result.
Source sync at `0ebb050e8530a3dc4da471177f62ac66780b1487` copies 606 blobs; an
independent Git-blob hash check confirms every copied byte and the repository/commit
manifest. Rebuilt production JS/CSS/legal assets are byte-identical to the browser-tested
Studio bundle. Tooling passes 61/61. Public export at `19bd4bca` and the manifest/residual
check pass on 1688 files. A further design-limit wording correction removes a product
name from the newly included contract document; the scan rules remain intact. The
final documentation-only head is also exported and checked before push.

## Limits

No public Site deployment, shared/cloud/auth durability, real microphone, native OS
IME, physical iOS/Android, Firefox/WebKit or full unrelated repository E2E acceptance.
Archived prototype Node suites require their original archive sources/dependencies;
they were not rerun as current Studio tests. This does not grant #22 performance
acceptance, restart measurement/Actions, adopt PR #39, merge PR #37 or change sharing.
#35's generic output extension remains a separate PR #39 review.

## Additional reachable review findings (2026-10-17 JST)

Application/test pin: `734794ab2a08d6285ee359b58debe7cd7646b113`.
Five comments on `95faf07f` describe reachable behavior; all five are addressed.

- **4296083037**: the independent reference Code runner also kept its realm across
  executions. PreviewFrame now keys the execution component by compiled project,
  replacing the complete iframe and its token/error state. Initial execution is sent
  on load once. The existing realm regression now runs on both Hosts and viewports,
  checks old-frame detachment, isolated globals and same-source reexecution, and
  requires execution count one. Studio retains its separate duplicate-ready checks.
- **4296083047**: denied localStorage access occurs before the old inner Boundary.
  Studio now renders its startup component beneath an outer Boundary; root-level
  caught errors are handled by that visible recovery diagnostic. A real throwing
  localStorage getter regression requires the alert and reload action. Browser
  pageerror/console-error assertions remain active without test-side filtering.
- **4296083056**: textarea updates shared one unbounded merge key. Consecutive
  typing still merges, while actual selection/caret changes, blur, execution and
  Studio sample replacement delimit history groups. Selection produced by typing
  itself is tracked without breaking the group. Tests type in two regions, undo
  each separately, retain the pre-execution source, and undo sample reset in Studio.
- **4296083059**: public StorageAdapters can retain more than localStorage quota;
  repeated full-version saves can exceed native JSON's 16 MiB UTF-8 import limit.
  Both save and native JSON export now use that same bound. Validation runs before
  storage and saved-baseline advancement. Versions are not silently removed.
  Tests use multibyte content so a draft plus one snapshot fits but a second snapshot
  exceeds the bound; failure retains the last reloadable record and dirty draft.
  A separate oversized draft fails both ordinary save and native export.
- **4296083071**: clean read-only Sessions could be replaced by same-ID import from
  the list. Import checks the current Host permission map and Session permission
  before closing/replacing anything. Tests verify rejection, unchanged native content
  and the retained read-only Session.

Before correction, both size regressions fail by unexpectedly succeeding. Desktop
reference Host regressions reproduce same-ID read-only replacement and collapsed
Undo; old production Studio fails the denied-storage recovery regression. Logs and
failed screenshots are retained under ignored `work/issue37/review2-*`. These are
functional failures, not hypothetical future Host extensions.

The first full unit run was concurrent with both browser suites and tooling: 2494
passed, 2 failed, 9 existing optional skips. The unrelated Word-import consent test
and file-only ZIP64 restore test hit their unchanged 5000 ms deadlines. No code,
timeout, retry or worker setting was changed to address those failures. A full run
without the concurrent verification jobs is recorded below; both affected tests
also pass in that run. This supports a scheduling explanation without asserting a
proven browser/OS mechanism.

Verification at application pin `734794ab`:

| Scope                                                           | Result                                                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| lint / typecheck / production build                             | PASS                                                                                           |
| full unit rerun                                                 | 238 files, 2496 PASS / 9 existing optional skips; 129.14 seconds                               |
| focused editor-host unit file                                   | 15 PASS, including both size-boundary cases                                                    |
| independent Host browser, desktop/mobile, workers2              | 44 PASS / 8 fixture-only skips                                                                 |
| production Studio browser, desktop/mobile, workers2             | 44 PASS / 8 fixture-only skips                                                                 |
| tooling                                                         | 61 PASS / 0 skipped                                                                            |
| file size / changed-file formatting / diff check                | 2128 files, zero size failures; PASS                                                           |
| Studio source synchronization and independent blob verification | 606 exact source blobs at the application pin                                                  |
| actual UI React ZIP                                             | strict TypeScript, independent React-only production build, opaque browser render; zero errors |
| denied-storage mobile screenshot                                | visible recovery alert and reload action; zero console errors/pageerrors                       |

The independent Host skips the three Studio voice/runtime cases and Studio storage
startup on both viewports, for 8 total. Studio still skips its four adapter-injection fixture cases on both viewports.
No expected failures, disabled regression, retries or forced clicks were added.
The mobile independent Code reexecution screenshot and denied-storage recovery
screenshot were inspected. The final documentation head passes local public
export/manifest/residual checks on 1688 files before push; there is no remote public sync.
No performance/Actions execution, public deployment or PR merge is included.

## Merge review scope and final corrections (2026-10-17 JST)

Application/test pin: `a44dd2eba99d25f03919580b0ee35634c3c8431a`.
Initial fixes: `96465673`; final CSV-scope correction/test alignment: `a44dd2eb`.
The user authorized merge after addressing in-scope findings and leaving unrelated
extensions aside. Seven additional findings affect this PR's declared behavior:

- **4296392472**: validate required draft/version/provenance metadata, including
  optional provenance records when present. Malformed metadata is rejected at the
  native boundary while ordinary versioned envelopes roundtrip.
- **4296392484**: async import reads the live Session's persisted artifact first,
  or the latest list state if no Session remains. List updates share one synchronous
  state-write path. A deferred File.text regression saves a version while import
  validation waits, then requires that version to survive the replacement.
- **4296392506**: `breakHistoryGroup()` separates typing without flushing inputs.
  Code caret/selection handlers use it on both Hosts; the regression now requires
  focus to remain after repeated arrow movement and moving to the start.
- **4296392517**: Design preview, save adoption and reload reuse select the declared
  root route's symbol, falling back to the first declared page. A LandingPage native
  import is previewed, saved and reused after reload.
- **4296392530**: Studio normalizes unknown throws for module/runtime diagnostics;
  null and undefined evaluation failures produce addressed alerts without an
  uncaught browser error. The preview Boundary also normalizes unknown values.
- **4296392543**: public toolbar Menu marks its dialog semantics as `data-editor-menu`.
  CSV scope is explicitly marked as an export-scope dialog. Host flush guards exclude
  menus/export scope while still retaining composition, editing-dialog
  and private-input guards. Real toolbar SVG/CSV downloads are exercised.
- **4296392558**: the Slide Office provider explicitly declares PPTX unavailable
  with its reason. The ordinary export menu must expose a disabled PPTX action.

Two comments (**4296392495**, **4296392568**) request treating the developer-only
React ZIP verifier as an untrusted arbitrary-archive processor. Its current input
is the actual ZIP downloaded by host-integration.spec.ts from this reference Host;
this is not a public upload endpoint or an arbitrary-archive security certification.
Those two changes are intentionally NOT implemented here and are tracked in
issue #267: bounded expansion
and checking every executable extension. Do not feed untrusted ZIPs to this helper.
This scope decision does not dismiss the described limitations or claim they are fixed.

Initial full browser attempts retain their failures: reference Host 48 PASS / 2 FAIL /
10 fixture skips; Studio 49 PASS / 3 FAIL / 8 fixture skips. The export fixture initially
waited for CSV download without confirming its native scope dialog; completing that
flow also requires the final capture guard to distinguish the genuine export-scope dialog
from a pending native edit.
The explicit export-scope marker fixes that path. A mobile Studio async-import fixture
failed to leave the Code Editor after its save click; it now uses the same explicit scroll,
hover and single normal click helper as the other Code actions. No forced click, extra
click, sleep, timeout change or retry was added. The corrected Studio subset passes 4/4.
Final full-suite results are recorded below. Raw failed traces/screenshots remain ignored.

Final verification at `a44dd2eb`:

| Scope                                                       | Result                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| full unit, run without concurrent browser/lint/tooling jobs | 238 files, 2497 PASS / 9 existing optional skips               |
| reference Host browser, desktop/mobile, workers2            | 50 PASS / 10 Studio-only skips                                 |
| production Studio browser, desktop/mobile, workers2         | 52 PASS / 8 injected-fixture skips                             |
| lint / typecheck / production build                         | PASS                                                           |
| tooling                                                     | 61 PASS / 0 skipped                                            |
| Studio source copy/build                                    | 606 source blobs at the application pin; production build PASS |
| file size / changed-file format / diff                      | 2128 files, zero size failures; PASS                           |
| final local public snapshot export/manifest/residual        | 1688 files; PASS before push/merge                             |

The reference Host's extra two skips are the new Studio-only unknown-throw protocol
case on both viewports. Previous skips retain their stated Host/fixture boundaries.
The latest mobile Studio execution screenshot was inspected: fresh execution count one
and capability text below the preview. Evidence remains ignored under work/issue37.
Only documentation follows this tested application pin. Merge is authorized; public
Site deployment, performance measurement and Actions execution remain outside this task.
