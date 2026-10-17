# #269 Design prototype and Document local-input follow-up

2026-10-17 JST. Base main: `e8c36d488c7e98ebded7949e52d2f16a9d9d52ac` (PR #268 merged).
Published implementation: `7b311ef422b5977becaae3898cc56a052bcb2b9b`.
Local tested source checkpoint: `64386fd00e03f25cf4ae747f29428b7bdcb5c245`.
CLI authentication expired after verification; publication uses the connected GitHub API.
The PR records exact local/published file-tree equality. Commit metadata differs; tested code does not.

The owner prioritized #269 and its additional Document report, authorizing this targeted local
investigation. General performance acceptance, unrelated tuning and Actions remain paused.
No consuming application code or private input was copied.

## Changes

Design prototype visibility lives in a private controller beside the editing layout. The toolbar
only asks that controller to open. Opening, native Close, Exit and Escape do not rerender
DesignSurface: unchanged paint order, canvas targets and CanvasObjects remain retained.
The controller is outside the transient mobile overflow menu; dismissing that menu must not
unmount an active prototype. Host/native content and reference updates still propagate.
No content identity cache was added for mutable Host trees.

Document's local EditorView retains native projections for unchanged persistent ProseMirror
nodes. After initialization, only changed top-level nodes pass through the native converter in
the local-command path. The cache is private to one local view. The one-shot converter still owns
arbitrary engine attrs; annotation-decoration/shared/wire paths retain their full conversion,
replay and authority checks. Schema/reference validation finishes before the text view/native
content changes, and failed preparation does not populate the cache.

Copied Host acknowledgements are compared with the last owned emitted content before reuse.
Mutable Host identity alone never certifies ownership. Identity shortcuts require complete owned
tree checks, including hidden children/accessors; command preconditions retain their canonical
fallback. Word/character counters reuse per-owned-block results and reread mutable blocks.
Real external replacements still rebuild the text-engine state.

Native schemas, persistence, permissions, local typing grouping, Undo/Redo and shared protocols
remain unchanged. This work does not virtualize frames/paragraphs or optimize initial loading.

## Diagnostic workloads

Production React/esbuild public-API Hosts, system Chromium; desktop 1440×900 and mobile/touch
emulation 390×844. Generated bundles, screenshots, logs and samples are in ignored `work/issue269/`.
Console errors fail browser tests. No CI dispatch, public sync or deployment was performed.

- Design: 94 Frames, 89 components ×20 native parts, 31 single-frame flows, 50 extra native children
  per Frame. Native JSON: 1,144,825 bytes; about 281,462 DOM nodes at initial fit-all. This is a
  synthetic structural workload, **not** the reported 6.2 MB file.
- Document: 400 headings +400 paragraphs, 137,489 UTF-8 text bytes. Hosts acknowledge with an
  owned immutable result or a fresh mutable clone. This is **not** the reported Markdown file.
- Timings start at the actual action (`beforeinput` for text), finish after two animation frames,
  and exclude driver round trips. Three Design open/close cycles; twelve keys per Document case,
  including cold actions. No formal warm-up/repetition protocol: these are diagnostic samples,
  **not** p95 certification or proof of the 100/500 ms budgets. Dev/StrictMode and real devices
  are NOT RUN. The original consuming data/environment is NOT RUN.

## Baseline evidence

At base main, mutable Design fails the no-reprojection invariant: probe visits **9776 →19552**.
First open/close: **5712.7 /5715.6 ms**. At base main, the copy-ack Document Host fails block
retention: **0 /799** untouched native blocks on all twelve keys. Input median **33.4 ms**,
range **27.8–48.6 ms**; executeView median **3.7 ms**. These reproduce rebuilding, not the
reported consuming Host's dev-build 110–130 ms timing.

## Final verification

All application/test changes are in local checkpoint `64386fd00e03f25cf4ae747f29428b7bdcb5c245`.
Design code is unchanged since `b5a26415`, exercised in the full Design run at `56a89def`.

| Check                                            | Result                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                  | PASS: TypeScript +all three production builds                                                                                                   |
| `npm run lint`                                   | PASS                                                                                                                                            |
| `npm test`                                       | **244 files /2557 PASS, 9 existing optional skips**; 132.21s                                                                                    |
| `npx vitest run packages/document/src`           | **7 files /30 PASS**                                                                                                                            |
| Design prototype production config               | **18 PASS**: large mutable/owned Hosts, all close paths, content invalidation, ordinary flow/overlay, shared metadata/Undo and comment recovery |
| Issue269 Document production config              | **6 PASS**: four input cases +ordinary rich text/IME/table/image/Mermaid, save/reload, HTML/Markdown/PDF export and anchored-comment Undo       |
| Targeted reference production run                | **14 PASS**: live prototype source updates, resolver replacement, pending-input capture guards and visible-only output                          |
| Tooling                                          | **63 PASS**                                                                                                                                     |
| File policy                                      | **2160 files PASS**                                                                                                                             |
| Changed code/config Prettier +`git diff --check` | PASS                                                                                                                                            |

Unique targeted production coverage is **38 PASS** (18+6+14). After correcting a report-output
path error, an additional four-case Document confirmation run passed and restored the complete
measurement records used in the table below. It does not add four distinct acceptance scenarios.
Source code did not change during this confirmation. Desktop Document and mobile Design
screenshots were inspected.

Unit cases include wire parity, mutable-attrs ownership, changed-base rejection, signed zero,
hidden children/accessors, changed-node-only projection, persistent untouched blocks and
incremental counters that still observe mutable edits.

## Recorded observations

Design desktop/mutable fixed open samples: **1643.8, 1566.8, 1549.4 ms**; close samples:
**1528.4, 1479.5, 1516.9 ms**. Probe visits remain **9776 →9776**, and CanvasObject drawing
callbacks do not increase during open/close. All four desktop/mobile mutable/owned conditions
pass; genuine Host content updates still invalidate the editing/prototype presentation.

| Condition                               | Input median / range (ms) | executeView median (ms) | Untouched blocks retained      |
| --------------------------------------- | ------------------------- | ----------------------- | ------------------------------ |
| Base main, desktop copy acknowledgement | 33.4 / 27.8–48.6          | 3.7                     | 0 / 799                        |
| Fixed desktop, copy acknowledgement     | 24.4 / 15.1–56.5          | 0.1                     | 799 / 799 after initialization |
| Fixed mobile, copy acknowledgement      | 16.8 / 12.7–45.4          | 0.1                     | 799 / 799 after initialization |
| Fixed desktop, owned acknowledgement    | 19.6 / 11.2–48.8          | 0.1                     | 799 / 799 after initialization |
| Fixed mobile, owned acknowledgement     | 17.2 / 13.4–54.6          | 0.1                     | 799 / 799 after initialization |

Input timings include acknowledgement cloning/rendering. executeView timing excludes the
acknowledgement clone. Cold keys remain in the ranges; no timing threshold was weakened.
These samples do not establish consuming-application performance or formal acceptance.

## Remaining acceptance

Design still pays browser modal/inert/style work over a large mounted DOM: roughly 1.5–1.6s
for this synthetic fit-all scene. Its unchanged editing projection is no longer repeated, but the
500ms goal remains unmet/unverified. Initial loading, Frame/paragraph virtualization and the
original consuming data/dev/production environments remain outstanding. Virtualization needs
selection, offscreen editing, clipping, hit-testing and accessibility coverage. Keep #269 Open
for review and consuming-workload confirmation; general performance acceptance remains held.

## Public snapshot checks

Local documentation checkpoint `3930a3ce`: **1718 exported files**, snapshot
`322f07eb8a8b221bf90c4742bd11269b563969013ff6755c0a493783009797df`.
`npm run public:check -- work/issue269/public` passes manifest/residual checks
(1719 files including the manifest). This is a local snapshot, not public synchronization.
The PR records the final documentation tree's additional local snapshot check.
