# Geo inspector author verification — 2026-10-12

This is author evidence for a bounded read-only text inspector, **not independent PM
review**, production Editor acceptance, M0 completion or M4 completion.
Design and ownership: [README](README.md). Related issues: #97 / #76.

## Exact source and environment

| Item                    | Evidence                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| Base                    | #103 `221aefe9c517eb48fba23d026b17b7e3fffab392`                                                    |
| Contract handoff source | `e1d7990c9ef2305bbccb5cd1c054bf74c44c2603`                                                         |
| Copied Geo domain       | #104 `aa6a140e4a08d62b6b430040608ce8633c74923b`, only `packages/geo-core/src`, byte-identical      |
| Tested source           | **`d3fc6a9953221fb0c090aace7593b22865447304`**                                                     |
| Final documentation     | Subsequent commit adds only this report; source/config/fixtures unchanged from tested source       |
| Current main checked    | `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`                                                         |
| Environment             | Debian GNU/Linux 13, Node 24.19.0, npm 11.9.0                                                      |
| Browser                 | Chromium 151.0.7922.173, Playwright 1.63.0; desktop 1280×900 / narrow 390×844                      |
| Host                    | Package-local independent source consumer, production Vite build + localhost preview               |
| Assets                  | Synthetic native schema 1, one layer / three features / one source; no font/source/tile fetch      |
| Backend                 | Actual #103 ReferenceRegistry; test-only permissions and ManualClock; no storage/resource provider |

`git diff --exit-code` verified no changes from the base to artifact-core, editor-core,
extension-contract, extension-runtime, extension-sample, Animation, Video, apps, root
manifest/lock or workflows. Only Geo domain adoption and `packages/geo-inspector` change.
The owner can compare #104's geo-core tree directly without re-reviewing a rewritten copy.

## Commands and results

Executed from repository root at the tested source:

| Command                                                                                                                 | Result                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm ci --ignore-scripts --cache /tmp/geo-npm-cache --no-audit --no-fund`                                               | PASS at pinned base; 462 packages, no manifest/lock update                               |
| `npm run lint`                                                                                                          | PASS, root ESLint                                                                        |
| `npm run typecheck`                                                                                                     | PASS, root strict TypeScript                                                             |
| `./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src/draft2` | PASS, 164 tests in 9 files: 59 Geo domain, 8 inspector, 97 unchanged draft.2 runtime     |
| `./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts`                                         | PASS, independent production Host bundle                                                 |
| `./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts`                              | PASS, 8 scenarios × 2 viewports = 16 tests; browser error/external-request checks active |
| `npm run check:files`                                                                                                   | PASS, no large/generated evidence violations                                             |
| `git diff --check`                                                                                                      | PASS                                                                                     |

Raw logs: `/tmp/geo-inspector-final-{lint,types,unit,build,browser,policy}.log`.
Screenshots: `/tmp/geo-inspector-evidence/desktop.png` and `narrow.png`; both visually
inspected for clipped content, overflow, text hierarchy and keyboard focus. Native `details`
and labelled `dl`/sections provide semantic structure. Screenshots/build stay outside Git;
no external artifact upload is authorized or claimed. Timing printed by tools is not a
performance measurement or acceptance result.

## Functional traceability

| Scope / original criteria                     | Exact behavior verified                                                                                                                                                                                         | Result and limit                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| UC1 / FR03 / AC03 subset / N02,N08            | stable layer/feature/row IDs, typed `001`, 0/null/boolean, source external ID presented without remapping; domain tests retain command atomicity/Undo                                                           | PASS for inspection and inherited domain regression; linked map/table selection and inspector editing NOT RUN                     |
| UC1/UC3 / FR02 / AC04 subset                  | null geometry retained and labelled unknown; MultiPoint including ±179°,80° retained as native coordinate text; longitude/latitude explicitly CRS84                                                             | PASS native text; no projection/rendering, polygon editing, topology certification or polar display claim                         |
| FR01/08/10 / AC02/08 subset / N02,N09,N12     | numeric schema 1 admitted; string `1`, schema 2 and wrong kind refused; actual Basic.read calls native validator; getter/sparse preparation rejected before clone/hash                                          | PASS for read/prepare refusal; full retained-version/resource validation and migration NOT RUN                                    |
| FR01/10 / AC02 subset                         | exact 65,536 UTF-8 bytes (including multibyte character) and 4,096 nodes accepted; 65,537 bytes / 4,097 nodes refused with `DataLimit`; depth 24 invalid native reaches validator, depth 25 fails copy boundary | PASS actual #103 runtime; no changed limits. Browser oversize keeps full native and history, shows refusal and no partial Surface |
| UC1/UC2 / FR08/09 / AC08–10 subset            | package admission pin, computed native hash, declared source content and raw byte hashes shown separately; fixed source version, CRS and attribution shown                                                      | PASS provenance inspection; no source byte verification, receipt, save, PNG or export capability                                  |
| FR06/07 / AC07 subset / N03,N05,N11           | Enter/Space on feature details, focus and expansion leave JSON/hash/revision/Undo/Redo unchanged; narrow layout has no horizontal page overflow                                                                 | PASS readonly private state; IME, camera, saved views and actual devices/assistive technology NOT RUN                             |
| FR10 / AC11 subset / N09,N12                  | malicious-looking scalar stays JSON string text; no img/script/iframe/canvas/input nodes, no external request; absent edit/save/inputs/resources grants; untrusted/wrong pin/missing lifecycle refused          | PASS this reference Host/definition; not a sandbox for malicious third-party extension code or production authentication          |
| FR10 / AC12 subset / N06,N09                  | ready revoke removes DOM immediately; beforePrepare/beforeMount/afterMount revoke rejects ready, drain remains incomplete until owned pending work settles, then no late DOM                                    | PASS actual lifecycle; no detached unowned acquisition before disposable registration                                             |
| FR10 / AC12 subset                            | replacement keeps only new Surface after old late work; changed revision before insertion rejected; fixed capture remains idle until next interaction, then old Surface invalidated                             | PASS fixed-capture semantics, no invented live-follow subscription                                                                |
| FR10 / AC12 subset                            | afterDispose delay observable as incomplete; released cleanup drains; failed cleanup reported in drain.failed                                                                                                   | PASS lifecycle cleanup, not async durable-save acceptance                                                                         |
| UC1/UC2 / FR01/05 / AC01/05 domain regression | inherited CSV/GeoJSON sealed import (19) and readonly typed key join (15), alongside native validator/commands (25)                                                                                             | PASS exact #104 source locally; not inspector UI integration or complete UC flows                                                 |

N01/N02/N09/N12/N14 are evidenced only for this declared inspector scope. N06 is a
public **source-entry** independent consumer with no playground dependency; installed
package consumer/export wiring is NOT RUN. N07 normal Host creation/save/reload and full
N10 persistence are NOT RUN. N08 native selection notifications are not provided. N13
regression covers Geo + draft.2 plus root static checks, not every Editor's browser suite.
C01–08 and S01–06 are not declared inspector capabilities; no corresponding grants or UI.
C09 durability/large assets and C10 devices/screen readers remain unverified.

## Failures, omissions and next owner gates

Initial development checks failed on two test expectations: the platform `contentHash`
returns raw hex rather than Geo source metadata's `sha256:` prefix, and scalar display is
JSON text with escaped quotes. Expectations were corrected to the actual explicit
representations. Final tested-source checks above all pass; no remaining observed test
failure in this scope. Node printed a NO_COLOR/FORCE_COLOR warning; browser error
listeners did not observe errors.

NOT RUN: root full unit/E2E/build suite, normal shared Host, installed/package-export
consumer, real mobile hardware, Firefox/WebKit, screen reader/native IME, production
permission/authentication, verified package archives, storage/retained resources,
async saves, source/network providers, map renderer, image/export fidelity and all
performance checks. No CI run/dispatch/re-enable, package publication, main merge or
release was performed. Workflows remain manual-only; disabled verification workflows
remain disabled. Branch run list is checked after push.

The #76 owner must review/activate `package.proposed.json`, lockfile/public consumer
wiring and actual package verification. No new generic contract is requested here.
For larger Geo documents, storage/resources, renderer or durable native versions, a new
specific capability/design decision is needed; never relax Basic or silently truncate.
The #101 proposal approval at 08:41 and #103 handoff supersede the earlier investigation's
"not yet approved" status, but do not certify this Geo integration for a product Host.
The parent PM still owns independent review and #97 acceptance reconciliation. M0's
remaining design/backlog and the original UC/FR/AC and M1–M4 obligations stay open.
