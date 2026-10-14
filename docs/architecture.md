# Architecture

Editor Platform owns artifact lifecycle and editor interactions. It does not know host-product workflow, projects, approvals, chat or semantic references. Hosts subscribe to typed events and retain opaque references outside artifact content.

Editor Platform also owns artifact editing/merge/conflict semantics, transactions,
selective Undo/Redo, anchor mapping, proposal content checks and in-document presence.
Collaboration Platform owns organizations, Rooms, members/invitations, authenticated
identity, access policy/enforcement and Room–Artifact relationships. A trusted Host
adapter supplies authorized sessions/scopes and transport/expiry notifications;
the Editor authority/codec validates editing integrity without owning RBAC policy.
Authorization is enforced at the trusted submission/commit boundary, not just in UI.

Issue #3's `/collaboration.html` is a verification Lab, separate from the normal
editor's local/shared modes. Issue #5 connects
the existing Issue #2 UI and agent API to the shared contract; it preserves the icon
toolbars and editing operations. The sequence is #3 corrections/completion → #5 →
#4 template application.
Lab completion does not establish normal-editor collaboration. See the
[Host boundary](collaboration-host.md) for integration responsibilities.

## Packages and dependencies

| Package                        | Responsibility                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact-core`                | Draft/version envelopes, immutable commits, canonical SHA-256 hashes, schema-versioned serialization, memory/IndexedDB storage adapters                    |
| `editor-core`                  | Pure commands, atomic transactions, undo/redo, selections, anchored threads, typed events, external operation proposals and geometry primitives; no React  |
| `document`                     | Semantic block/inline model, ProseMirror adapter, commands, Markdown/HTML/PDF interchange and text comparison                                              |
| `structured-data`              | Independent schema and stable rows, validation, arithmetic parser, CSV/JSON interchange and eight projections                                              |
| `review-surfaces`              | Independent text-pair review and file models; line/range/page/image-region selection                                                                       |
| `canvas-ui`                    | Stateless canvas rendering projections, local viewport state, pointer/keyboard interaction and image-download utilities; no persisted universal node model |
| `whiteboard`                   | Nodes, connectors, Groups and explicit Sections with their own commands, diff and SVG export                                                               |
| `design`                       | Frames, elements, parent groups, component definitions and instances; layout/layers, diff and SVG export                                                   |
| `slide`                        | Decks, ordered slides, slide objects and copied chart snapshots; presenter mode, diff and SVG/PNG/PDF export                                               |
| `collaboration-core`           | Pure operation/receipt/proposal contract, ordered authority, optimistic client, local/fault adapters and selective Undo                                    |
| `collaboration-adapters`       | Domain codecs, ProseMirror replica, asset references and example HTTP transport                                                                            |
| `apps/collaboration-reference` | In-memory reference Host with demo sessions; production auth, durable storage and scale remain external                                                    |
| `apps/playground`              | Integration host: artifact library, local persistence, history/compare, import/export, inspector and deterministic external runtime demo                   |

The package dependency graph is acyclic. Domain models use Artifact Core and Editor Core. Visual React views also use Canvas UI. Domain packages do not import each other's models. Public imports use `@editor-platform/*` entrypoints; models and views live in separate modules. Workspaces expose TypeScript source for a bundler-aware host, rather than separately published JS bundles.

Grid, Form, Chart, Kanban, Dashboard, Timeline, Roadmap and Summary project the same structured-data model. Filtering/sorting/grouping is view state. A slide chart is an immutable data snapshot copied by the playground host, not a shared or live structured-data object.

## State and storage

Content edits run through pure commands and transactions. An editor session holds up to 100 local snapshot undo states, isolates caller-owned inputs/outputs and records session-local revisions. This history must not ingest remote edits. Issue #3 supplies a separate shared-operation authority, resource preconditions, ProseMirror rebase and selective Undo in `collaboration-core` / `collaboration-adapters`. See [the shared contract](collaboration-contract.md). Commits copy/freeze content, link the parent version and record schema version, SHA-256, actor, timestamp and reason. Hashing sorts object keys by deterministic code-point order. Drafts remain separate and mutable. Restoring a version creates a content edit in the current draft; it never rewrites history.

Storage adapters retain JSON-serializable artifact records. IndexedDB is the playground default. Writes are queued to retain order; failures remain Not saved until retry succeeds. Delayed immutable saves merge the new version into the latest draft/annotations instead of restoring an older record. Metadata/comments are stored separately from content undo history. Reload restores artifacts, draft content, versions and annotations; selection and undo stacks are session-local. Camera/panel preferences persist privately outside content hashes.

Native JSON retains schema versions, stable IDs, versions and annotations. The importer checks domain shape and version content hashes, assigns a new artifact ID and rebinds comment anchors to that identity. Ordinary Markdown, CSV, HTML and SVG exports omit internal element IDs. CSV materializes formulas and does not preserve the typed schema; native JSON is the full-fidelity interchange format.

## Integration and external operations

Surfaces accept content, a command executor and selection callbacks. `EditorEventBus` exposes selection, artifact, version, command and annotation events. The playground host accepts toolbar/context-menu actions, an optional inspector slot and an opaque external-reference callback. No product-specific data is required or inserted into ordinary exports.

`ExternalOperationRequest` exports artifact/version/selection references and opaque input. `ProposedCommands` supplies a summary, optional source and commands. `previewProposedCommands` works on a copy. The playground rejects proposals when draft content has changed; apply uses one normal transaction and remains undoable/versionable.

The deterministic uppercase demo lives in the playground host. Platform packages do not create prompts, select models/providers, run agents/tools, generate output, orchestrate retries/cancellation or own permissions/cost/audit. Command objects are trusted host application code. Imported JSON is data, not executable commands.

## Rendering and security

HTML is sanitized with DOMPurify and rendered in an iframe with an empty sandbox and restrictive CSP. The React preview is a trusted demo adapter; there is no arbitrary JSX compiler. Images are rendered as images. Mermaid uses strict security and isolated syntax-error states. Formulas use a recursive-descent arithmetic parser rather than JavaScript execution.

Visual models retain separate semantics. Canvas UI receives temporary target bounds and a render callback; it does not own domain content. Canvas move/resize gestures commit once at pointer release. Selection supports marquee, Shift-click, eight resize handles, rotation and keyboard movement/delete. Properties provide numeric editing. Whiteboard connector endpoints meet shape boundaries. Design component definitions can drive multiple independent instances. Slide presentation hides content-editing controls and makes the canvas read only.

Shared UI is packaged in `editor-ui`; surface CSS belongs to its public package entrypoint. A separate `/embed.html` Host exercises all seven surfaces without Playground state or CSS. See [embedding](embedding.md) and [domain-specific invariants](surface-semantics.md).

## Build and validation decisions

Node.js 20.20.2, npm workspaces and strict TypeScript are used. Vite consumes Mermaid's shipped ESM chunks and lazy-loads diagrams. Rollup tree-shaking is disabled because its interprocedural analysis of this dependency graph stalled; esbuild minification and dynamic chunking remain active. The R2 review-correction build took 9.04 seconds; the Issue #3 review-correction build took 8.29 seconds on the prepared cloud machine. The largest shared JS chunk is approximately 424 kB gzipped, with a separate collaboration entry; Vite reports a chunk-size warning. Mermaid and the PDF.js worker load separately. Further bundle splitting remains possible.

Playwright runs desktop/mobile Chromium flows, a separate Firefox/WebKit independent-host flow and an optional serial production-scale suite and rejects all console errors and uncaught exceptions. DOM trace snapshots are disabled because snapshot instrumentation attempts script execution in script-disabled sandbox frames. Screenshots/network tracing and the application sandbox remain enabled. Vitest verifies lifecycle, storage, domain commands, serialization, validation, formulas, projections, diffs and host events.

## Non-goals

Authentication, production servers, AI generation/runtime orchestration, complete spreadsheet/design/presentation compatibility, third-party execution, and host-product integrations remain outside this platform.

## Issue #2 schema and editor API additions

| Domain         | Current content schema / compatibility                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document       | Version 2 adds rich inline spans, semantic nested lists, cell paragraphs/merges/widths and page settings. Version 1 plain blocks remain readable; immutable historical versions are not rewritten. |
| Data           | Version 2 retains typed stable fields/records and adds explicit named view definitions. Private projection state and unsaved Form drafts remain separate.                                          |
| Slide / Design | Version 2 adds typography/runs, visual styles, page/layout/table/chart or Frame/component/constraint metadata. Version 1 native fixtures still roundtrip.                                          |
| Whiteboard     | Version 3 separates Sections from nodes/Groups and persists explicit root membership. Legacy Frames become draft Sections; old saved-version hashes remain unchanged.                              |
| Review / File  | Version 2 adds fixed source-side revisions or original-byte retention. Version 1 fixtures remain readable.                                                                                         |

`EditorLayout` exposes controlled/uncontrolled panel state through `EditorLayoutProps`; surfaces define their own typed public props and carry package-owned CSS. `CanvasStage` accepts domain-specific transform previews and rich text commits; its temporary render projections are never persisted as a universal model. Bulk inspector typography patches merge only changed properties into each selected item, including its rich runs, and display mixed values explicitly.

Document retains ProseMirror steps/inverses/maps at its engine adapter boundary while the public content remains semantic blocks. Canvas text uses a private ProseMirror edit buffer and its local history; committing produces one platform command. ProseMirror and the added `prosemirror-history` package use MIT licenses. Platform Undo and edit-buffer Undo have distinct lifetimes, avoiding duplicate application.

Readable comparisons describe domain names, geometry/text/style, schema fields and record values; embedded image bytes are represented by a short display fingerprint instead of dumped into the review UI. The fingerprint is not an integrity hash; immutable version integrity still uses SHA-256.

## Shared sessions

ADR 003 fixes the authority/text-engine strategy.
The independent `/collaboration.html` entry uses supported serializable operations;
it never silently runs unsupported single-user commands. Native collaboration backups
are separate from ordinary exports and prior ArtifactVersion schemas. Existing saved
version hashes are unchanged. Tokens, presence and private view state stay outside
content and immutable snapshots. The HTTP reference emits snapshot-bearing events
and retains history in process memory; it is an executable adapter example, not
a production persistence or authentication service.

## Normal shared session (#5)

See [the normal integration responsibility diagram](editor-collaboration-integration.md).
SharedEditorSession owns content, pending/confirmed state, per-element text engines and
selective history. It replaces local snapshot ownership in shared mode. Existing pure
commands are prepared once into atomic domain-specific changes; toolbar, Inspector,
shortcut, context and clipboard operations share that boundary. Assets travel by
ID/hash in operations; ordinary exports retain the domain schema without sync metadata.

## Native templates (#4)

`templates` contains the versioned catalog, shared typed input contract, native bindings,
portable assets, authoring and checked preparation/application. `template-ui` owns
reusable gallery/form/preview/author controls. Definitions keep each domain's native
content; they introduce no common persistent node graph. `template-host.html` is a
separate public-package Host, and its deterministic agent is Host-owned.

Whole creation is a Host lifecycle action with a stable request ID and atomic
StorageAdapter.putIfAbsent. Fragment/preset application creates ordinary checked
operations and proposals; shared sessions retain authority deduplication and selective
Undo. Document presets use mark steps preserving engine identity. Display-only
Review/Viewer settings never enter native content or shared history. Catalog visibility
and write policy are Host responsibilities. See [template contract](template-contract.md).
