# Artifact Host integration — Issues #33–#36

Design v1, 2026-10-09; substantial Host capability addition, following the
[proposal template](editor-proposal-template.md), [development guide](editor-development.md)
and [acceptance conditions](editor-acceptance.md). Verification is recorded separately.

## Purpose and scope

The existing Sites Studio at source `695f1b5` remounts local Sessions on navigation,
uses a separate Kanban array/history, and hardcodes private access labels despite
the Site's public policy. Its React prototype is not the merged #24/#29 implementation.
Fix the actual Studio, and provide a product-independent public Host boundary and
minimal Host that reproduce the lifecycle without importing Playground state/CSS.

Representative operations are open/edit/save/return/reopen, switch/Undo/Redo, and
native Design-to-React export reused by the Host. Failure cases are invalid commands
or imports, storage failure/retry, and unsupported exports/read-only commands.

No new universal content or Kanban domain is introduced. Slide, Whiteboard, native
Design and StructuredData retain their own validators/commands. Code is explicitly
a Host-owned single-file TSX extension, not Review/CodeDiff or a new native Editor.
SORA samples, navigation, identities, storage and execution remain Host-owned.

## Capabilities and registration

| Experience   | Native model / public Surface or adapter                                             | Planned local capability                                                                          | Unsupported entrance                                                  |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Slide        | SlideContent / SlideSurface                                                          | native editing, history, JSON, SVG                                                                | Office export reports unsupported                                     |
| Whiteboard   | WhiteboardContent / WhiteboardSurface                                                | native editing, history, JSON, SVG                                                                | shared mode unavailable                                               |
| React/Design | DesignContent / DesignSurface plus public design-react-core conversion               | native edits, bounded semantic page, history, native JSON, independent TSX/CSS, Host output reuse | unsupported native semantics diagnosed; no arbitrary original imports |
| Code         | Host schema v1: stable file ID, filename and source / explicit EditorCommand adapter | text edits, history, JSON, TSX, sandboxed Host execution                                          | non-React imports rejected; no shared/code-diff claim                 |
| Kanban       | StructuredData / DataSurface and existing Kanban/Grid projections                    | typed cells, stable records, history, JSON/CSV                                                    | no second task dataset/history                                        |

All are local-only in this Host; shared editing, annotations, external proposals,
template/linked-reuse management and Office import/export are not declared here.
Existing platform capabilities are not removed or retroactively certified. Native
IME/physical devices and other browsers require separate evidence. Functional
verification is distinct from paused performance acceptance and product-side trials.

## Content and lifecycle

`@editor-platform/editor-host` connects an existing `Artifact<T>`, its domain
validator, `EditorSession<T>`, Host permission callback, StorageAdapter and optional
format adapters. It does not interpret T, execute code, implement RBAC or own routes.
Draft and all retained versions validate before opening; async native envelope import
also checks immutable canonical hashes. Each Host retains one controller per artifact
ID, including two artifacts of the same kind. Session/revision/history are in memory;
reload restores saved native content and starts a new local history. Selection and
private view state belong to the controller, outside content/version/history.

UI and headless edits use the same command boundary. Validate a private command result
before committing it to the existing Session. Read-only is checked at execution,
Undo/Redo and persistence boundaries. No remote update enters snapshot history.
Navigation flushes ordinary native text inputs; composition and unconfirmed forms
block navigation with a visible recovery action. Explicit import is one undoable
command. Return keeps the draft/history. Cancel discards the draft and closes the
Session only after an explicit discard choice; explicit close releases listeners and
private state. Deletion is Host-owned and closes before removing storage.

Save captures a content/revision snapshot, persists via the existing StorageAdapter
and optionally commits an immutable version. A failed write retains draft/history;
retry is explicit. A delayed success records the saved snapshot without overwriting
newer edits; concurrent save/close is rejected. Native JSON is an Artifact envelope,
not a private history dump. Domain format adapters retain distinct output formats.

## Access metadata and security

Sites/Host policy remains authoritative. The static Studio has no authenticated
runtime API for reading live Sites audience. It therefore displays the neutral
“共有設定はHostで確認”, separately from browser-local data and lack of collaboration.
A public metadata adapter supports private/public/other Host scopes, monotonically
refreshed revision, expiry, unknown/stale fallback and explicit invalidation. Never
infer access from localStorage or bake a build-time policy into a live guarantee.
Publishing uses the same Site/project and does not mutate its public policy.

Code execution remains in an opaque sandbox with `allow-scripts` only, restrictive
CSP, exact window/token/revision checks and listener disposal. Native Design output
is rendered by a separately bundled Host preview from generated public bridge TSX;
its opaque transport is a Host adapter, not the standard #24 separate-URL protocol.
Generated TSX is independently built and used without Editor/history runtime.
JSON size/kind/schema validation and retained-version hashes precede replacement.

## Implementation and verification

| Stage              | Files                                               | Conditions / scenarios                                                        |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pure boundary      | editor-host and tests                               | N02–N05, N08–N10: atomic failure, separate IDs, permission, save race, hashes |
| Minimal Host       | independent entry and domain adapters               | N01/N06/N07: five capability declarations, public imports only                |
| Studio integration | existing Site sources                               | list → edit → save/back → reopen; keep/discard; two same-kind Sessions        |
| Domain adapters    | native Design bridge, Code sandbox, Data projection | C07/C08: independent output; Grid/Kanban same record; preview error retained  |
| Access/docs        | metadata adapter, README/status/verification        | N12–N14: stale fallback, policy unchanged, accurate limits                    |

Use local production desktop/mobile Playwright with browser errors failing the run;
inspect representative screenshots. Source, not dist/ZIP/JSON/screenshots/logs, is
committed. Site source provenance is pinned to the reviewed platform tree. The
installed Sites workflow helper is absent, so source credentials are passed only via
hidden stdin to an ignored Git helper and kept in child-process memory. Publication
must use the exact pushed source commit and its unchanged archive.

Performance measurements/tuning, Actions execution, consuming-product integration
and actual-material trials remain outside this change. Unrun conditions stay NOT RUN; no new acceptance
standard is introduced.
