# Editor Platform v2.3 — SORA Studio

Five fictional SORA artifacts exercise list → open Editor → save/back → reopen.
The Site's sharing policy is owned by Sites. This static application cannot query
live authenticated policy and displays “共有設定はHostで確認”. Editing data is stored
in this browser; public Site access does not share that data with other visitors.

| Artifact                 | Native / Host boundary                                                       | Output                                                                    |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| SORA企画書               | Public SlideSurface / SlideContent, six initial pages                        | Artifact JSON, individual SVGs; native local PNG/PDF                      |
| ビジネスモデルキャンバス | Public WhiteboardSurface / WhiteboardContent, nine sections                  | Artifact JSON, SVG                                                        |
| 製品サイト               | Public DesignSurface / DesignContent plus merged #24/#29 Design–React bridge | Artifact JSON, generated TSX/CSS ZIP, generated React reused on Host list |
| 音声認識ソフト           | Explicit Host extension: bounded single-file TSX with existing EditorSession | Artifact JSON, TSX and voice sample outputs; isolated Host execution      |
| 開発タスク               | Public DataSurface / StructuredData; Kanban and Grid use the same records    | Artifact JSON, CSV                                                        |

React UI remains a separate upstream Editor from Design. This demo's product page
uses native Design semantics and its public React conversion/export path; it does
not represent the full registered-original ReactUiSurface. Unsupported semantics
produce diagnostics. Code is not Review/CodeDiff. Kanban has no second task model
or private Undo stack. Shared editing, comments, proposals, reuse management and
Office/PPTX/DOCX capture are outside this Host's declared capabilities.

## Lifecycle

One ArtifactEditor per artifact ID retains the existing EditorSession and its
revision/Undo/Redo while the Surface unmounts. Two artifacts of the same kind remain
independent. Save returns artifact ID/kind/native content, commits a retained version
and writes browser storage. Save failure retains the draft/history and supports retry.
“編集を保持して戻る” retains unsaved edits in this tab. “取消” requires an explicit
discard choice. Explicit Session close ends local history; page reload starts new
history from saved native content. Selection/panels are private view state.
Imported and duplicated artifacts remain browser-unsaved until a successful storage
write, including before opening a Session. They participate in the unload warning;
a failed save leaves the warning active.

Native JSON contains the Artifact envelope, draft and all retained versions, not
private history. Import checks domain, kind/schema, immutable hashes and version
identity before replacement. Same-ID dirty sessions and conflicting historical
versions are rejected. Browser storage is not cloud durability; storage denial,
quota, manual clearing or closing an unsaved tab can lose unsaved work.

Old Slide/Whiteboard/TSX drafts migrate with their IDs. Old Kanban tasks become one
StructuredData dataset with native Kanban/Grid projections. Legacy keys are kept.
The earlier independent React prototype uses a different model; its data is retained
and available as JSON backup, without claiming automatic conversion to native Design.

## Execution

TSX runs only in an opaque iframe with `sandbox="allow-scripts"`, restrictive CSP,
blocked network/form submissions and exact frame/token/generation checks. Every
successful run, including rerunning identical code or resetting the sample, replaces
the iframe realm so previous globals/listeners/timers cannot survive. Original
code, compilation and microphone service belong to the Host. The voice simulation
uses predetermined text. Real microphone use requires a Host confirmation click
and browser permission; SpeechRecognition availability/service behavior depends on
the browser. No microphone or audio-service acceptance is claimed by fixture tests.

## Source and verification

Canonical Host sources and Site build/test support live in `apps/studio-demo` of
the source checkout. The independent Host uses public package exports without
Playground state/CSS or SORA models. `vendor/editor-platform/origin.json` pins the
reviewed platform commit and each copied Git blob SHA, including Host/build/test
sources. Source is pushed before a compiled archive is saved/published. The existing
Site/project ID and access policy remain unchanged.

Node 20+, React 19.1.1: `npm run build`, `npm test`.
`REQUIRE_PINNED_SOURCE=1 npm test` requires final commit provenance.
Desktop/mobile production workflows are run from the platform checkout with
`HOST_STUDIO_URL=http://127.0.0.1:8877 E2E_SUITE=host npx playwright test`.
See VERIFICATION.md and the platform's `docs/verification/issue-33-36/README.md`.
Generated dist/JSON/ZIP/screenshots/logs are ignored. Actions remain manual-only;
performance acceptance #22 and additional measurement/tuning remain paused.

## Local build from canonical source

The platform's `scripts/sync-studio-source.mjs` prepares the source-only checkout.
Build it with `node scripts/build.mjs` using the platform's installed dependencies.
The old pre-Host `src/preview.jsx` is optional archival material; current Studio
builds its Code and Artifact previews without it. The archived prototype tests
require their original archival sources and are separate from current Host tests.
No build or source synchronization publishes the Site or changes its sharing policy.
