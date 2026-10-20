# #29 / #260 / #278: dependency and everyday-use follow-up

The later [local Animation connection](../../animation/playground-slide-integration.md)
addresses #278 item 4 using the existing rectangle/group v1 scope. The open-Animation
statements below describe this earlier checkpoint, not completion of the larger #74 epic.

The later [#38 / #261 follow-up](../issues-38-261/README.md) identifies and patches
the Rollup stall recorded here and removes the ordinary drivers' tree-shaking workaround.
This record's failures, source and results remain historical.

Verified locally on 2026-10-18 from main
`4fd797227e81cd477a8073903fe9092386be31c7`, on `fix/next-priority-issues`.
Application and regression source: **`a89e7c62373a460f29459b26e4a255894a97e1e0`**.
Node 24.19.0, npm 11.9.0, Playwright 1.63.0 and system Chromium
151.0.7922.173 were used. Mobile means Chromium touch/viewport emulation.

This completes the remaining registered-dependency fixture acceptance for #29
within the existing public contract, repairs #260's stale workspace lock regression
and addresses #278 items **1, 2, 3, 5 and 6**. #278 remains open for Animation
(item 4, related to #74). #38's default-Vite and consuming-product work remain open.

## #260: installed bytes and reachability

The patched manifests concealed two stale lock entries:
`packages/document/node_modules/mermaid` and
`packages/office-export-ui/node_modules/mermaid` still installed 11.12.0.
The old KaTeX/parser/lodash branches remained reachable from those copies.
`npm ci` reproduced the invalid workspace installation. A plain lock-only install
did not repair it; removing the obsolete workspace records and regenerating the
lock pruned their stale transitive branches. The declared pins were unchanged.

| Evidence                                                 | Result                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Previous lock SHA-256                                    | `5051bf5788637f7b1c63f7ec1f6d2f84aae62bd08f3816765cddf7f7975be338`   |
| Corrected lock SHA-256                                   | `2c0f2c5d0c46973ab04c759d4f0689cbfc61264004f6d5f4b9fd774821a7b3e9`   |
| Fresh `npm ci`, resolution from root / Document / Office | Mermaid **11.17.2** from each workspace                              |
| `npm audit --json --omit=dev`, before                    | **12 package records: 4 high, 7 moderate, 1 low**                    |
| Same audit, after                                        | **3 high package records**: PDF.js, image-size, propagated pptxgenjs |
| Mermaid math / sanitizer in actual application graphs    | Core entry, KaTeX **0.18.2**, DOMPurify **3.4.16**                   |
| Main / worker / Node PPTX graphs                         | No image-size parser or PDF viewer/scripting runtime                 |

The three raw findings retain their bounded
[dispositions](../../third-party/security-dispositions.md). PDF bytes are user-controlled,
but the custom core canvas/TextLayer integration has no scripting manager or action
executor; `isEvalSupported: false` alone is not the rationale. The pinned PPTX runtime
does not import its declared image-size dependency. Direct consumer imports or a changed
viewer/export integration require reassessment. This is **not an audit-zero claim**.

The new build plugin validates all lock copies and actual installed versions in Vite's
main/worker module graphs. It rejects Mermaid's prebundled entry, the unused image parser
and standard PDF viewer/scripting modules. Generated JSON inventories stay in `dist/` and
`dist/artifact-host/`, including hashed worker inventories. Six tooling cases include
stale nested copies, actual-version mismatch, prohibited paths and a real esbuild
metafile of the pinned Node PPTX entry. Runtime notices already list the patched versions;
copyright, license texts and retained history are preserved.

Security browser checks cover ordinary Document math and a scripted PDF rendered without
executing its action, plus a Mermaid loose-config/HTML-label attempt. The latter waits
for the changed diagram, checks that the editor remains visible and the injection flag
stays false, and inspects the resulting SVG for executable nodes/handlers/JavaScript URLs.
Legitimate sanitized SVG HTML is not categorically forbidden.

## #29: representative dependencies in ordinary Design

Open `/?design-dependencies=1`, create Design and enable React Web settings. The normal
Library/tree/Inspector/canvas uses a separate immutable environment with `DependencyBadge`.
Its unchanged default-exported implementation imports the named `Card`, scoped CSS and
a PNG through pinned aliases, requires the original theme Provider and exposes a named
`footer` slot. The former default environment and original registry hashes are preserved.
Saved content retains its environment, including after reload without the query option.

`design-react-dependencies.spec.ts` authors the native two-page source through ordinary
UI and mixes the default component with existing registered originals and a native
ProductCard. It edits public props, binds label/callback and supplies the named footer.
It checks source implementation hash, import and full native persistence before preview
and actual ZIP download. Deleting the fixture CSS from a copy makes independent build
fail with that dependency's path.

The fixture driver builds **component, page and site** entries independently with strict
TypeScript and Vite. The standalone component is the native ProductCard with its original
named imports; page/site additionally include the default badge and named slot. Browser
checks at **390 / 1024 / 1400px** cover CSS, loaded PNG, Provider theme, callback-driven
redraw and no horizontal page overflow. Site navigation and controlled form submission
also run. Native import retains instance IDs, exact versions, props, named slot, binding
and environment; original source bytes remain unchanged.

The existing ordinary Design suite additionally checks revision/import, unsupported
slots/props/dependencies, regeneration conflicts and preserved independent edits, shared
authority/selective Undo and mobile editing. The fixture is trusted local Host source,
not arbitrary package or uploaded-source execution. Cross-artifact regeneration remains
local-only in the reference Host; its one-publication limit and the public contract's
other restrictions remain.

### Default Vite observation retained under #38

A diagnostic attempt removed the independent driver's **existing** `treeshake: false`
setting. Its new component-mode Vite build remained active at high CPU for over
65 seconds and was explicitly terminated. This attempt failed; it is not proof of
the original consuming-product failure's cause. The existing setting was restored
for the three successful independent builds. It is not a universal recommendation
or a resolution of #38. No performance acceptance, tuning or benchmark was run.

## #278: five targeted usability changes

| Item                 | Change and functional evidence                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: save confirmation | The confirmation action is `この版を保存`; opening/cancel leaves zero versions, committing creates exactly one. The header action remains `Save version`.                                                                                                        |
| 2: empty source list | Opening the embed menu discovers saved sources. Existing fixed default and explicit placement remain; actual placement retains the source artifact identity. Refresh, scope reset and stale-response checks remain in place.                                     |
| 3: bound text        | Inspector explains the data source/path and opens/focuses its preview input. Primitive fields use the canonical fixture command; complex values retain the JSON editor. Undo/Redo, save/reload and the original binding are checked.                             |
| 5: Japanese samples  | Product and contact examples are added alongside English examples. Japanese heading/button/input text, controlled form callback and persisted preview text are checked. This does not translate the entire editor or Host callback messages.                     |
| 6: canvas text       | Native canvas text is available as `aria-description`, retaining existing element names and selection behavior. The browser checks the accessible description for Japanese text, including path-painted text. Manual screen-reader certification is not claimed. |
| 4: Animation         | **Not implemented in this batch.** Playground registration and reference embedding remain under #278 / #74.                                                                                                                                                      |

Eight added production cases pass across desktop/mobile. Screenshots of automatic
reference placement and Japanese input editing, and nine independent output images,
remain outside Git. The mobile editor retains its existing vertically stacked panels;
no native-device or OS input-method certification is inferred.

## Verification and retained limitations

- `npm ci`: PASS; all four pinned Office font files verified.
- `npm run build`: PASS for main, isolated React preview and independent artifact Host.
- `npm run typecheck`, `npm run lint`: PASS.
- `npm test`: **2,650 PASS, 9 existing optional skips, 256 files**.
- `npm run test:tooling`: **90 PASS**, including six new dependency cases.
- `npx playwright test --config playwright.next-priority.config.ts`: **8 PASS**.
- New ordinary Design dependency scenario: **1 PASS**; independent component/page/site builds included.
- Existing Design regression excluding the already-run new scenario: **20 PASS**.
- Selected production React/UI/shared/failure/acceptance, security, independent embedding,
  persistence and Slide cases: **20 PASS**, including one mobile case.
- Selected reference discovery/placement/scope/read-only regressions: **22 PASS** across
  desktop/mobile. The dependency scenario was rerun after requiring the missing-CSS
  failure to name its actual dependency, and passed again.
- Changed-file Prettier, `git diff --check`, `npm run check:files`: PASS; file policy
  checks 2,296 files. Final tooling rerun after the export-policy update: **90 PASS**.
- Ordinary Office Mermaid image export: **1 PASS**; fixed Japanese glyph image,
  editable native text, explicit source consent and unchanged native artifact.

These are **72 distinct production Chromium cases** in total. Rerunning the strengthened
dependency scenario does not add another distinct case.

The first build exposed an unsupported `disabled` prop on CommitInput; the implementation
now uses a disabled fieldset and the canonical command guard. An initial lint failure for
a missing Node URL import was corrected. Those failed checks were followed by successful
build/typecheck/lint. The failed default-Vite attempt above is intentionally not converted
to PASS.

Raw audit/build/test logs are `/tmp/editor-next-*.log` and
`/tmp/editor-next-audit*.json`. Independent ZIP/build inputs stay in ignored
`work/issue-29-dependencies/` and `work/issue-29/independent-host/`.
Screenshots/traces are in `/tmp/editor-next-priority-results/`,
`/tmp/editor-next-design-dependency-results/` and production Playwright output folders.
The default-Vite failure has its own log and `/tmp/editor-next-default-vite-attempt-results/`.
No generated ZIP, output module, build or image is committed.

Firefox/WebKit, physical devices, manual screen readers/IME, consuming-product trials,
deployed Site revalidation and the entire repository browser suite are **NOT RUN** in
this batch. Existing fixed #17/#24 performance acceptance is unchanged. Actions,
unrelated performance collection, public synchronization and deployment remain paused.
