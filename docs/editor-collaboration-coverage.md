# Normal editor operation coverage (#5)

All shared mutations use the normal component's command callback or injected text
engine. The same pure model commands serve toolbar, keyboard, context menu, Inspector,
pointer and clipboard entrypoints. `prepareEditorCommand` rejects changed fields it
cannot represent. The table distinguishes shared document state from private view state.

The initial `4dd7156` checkpoint had three review failures despite passing its existing
suite. R5-01–03 add multi-level own Undo/Redo, deferred new text
input and scoped geometry dependencies, with explicit regression evidence.

| Domain / commands from #2                                                                                                | Normal entrypoints                                                           | Shared representation / conflict rule                                                                                    | Evidence                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Slide insert/delete/duplicate/reorder pages; size, background/image, title, notes, hidden, theme/layout                  | Page rail, page menu, Inspector, keyboard                                    | Stable page/child IDs; atomic per-page fields/order; duplication pins source entity history                              | EI-Q02/03/10/12; editor-transactions unit tests                 |
| Slide shapes/text/images/chart/table snapshots; patch/delete/duplicate/copy/paste                                        | Icon/shape picker, canvas, context menu, clipboard, Inspector                | Domain object insertion/removal/fields; order/existence CAS; IDs fixed before retries                                    | EI-Q02/03/12; existing #2 canvas/R2 regressions                 |
| Slide move/resize/rotate/flip, group/ungroup, align/distribute/match-size, stacking, lock/hide                           | Drag/handles, arrows/shortcuts, Arrange, Inspector/context                   | One atomic transaction; geometry/topology dependencies; independent color changes survive geometry Undo                  | EI-Q03; R2 model/menu regressions; prepared geometry unit tests |
| Document text/marks/headings/paragraphs/list/checklist/link/code/table/block/image/embed; paste/composition/find-replace | ProseMirror input, toolbar/block menu, Inspector, clipboard, keyboard        | Actual engine steps/rebase; stable block IDs; mapped selection/comments; page metadata separate CAS                      | EI-Q04/10; editor-text; document engine and existing #2 tests   |
| Canvas text, multi-line paste, inline marks, Japanese composition; Inspector text                                        | Double click, inline formatting, Inspector                                   | Actual per-element PM steps; no whole-string shared register; structural conflicts retain pending text                   | EI-Q04 across Slide/WB/Design; editor-text unit tests           |
| Whiteboard nodes/shapes/freehand, transform/group/arrange/stack, duplicate/delete/paste                                  | Toolbar, infinite canvas, layer rail, context menu, Inspector                | Atomic node changes; group/geometry dependencies and stable IDs                                                          | EI-Q05; editor-domains; existing WB/R2 tests                    |
| WB Sections title/background/bounds/membership and connector endpoints/ports/routing/style/labels                        | Section rail/actions, Connect selected, canvas, Inspector                    | Section membership/endpoints validated; delete/paste transacts related nodes/connectors together                         | EI-Q05; editor-domains unit tests                               |
| Design Frames/elements/parents/layers/clip/constraints/auto-layout; styles/components/instances/overrides/detach         | Toolbar, canvas, layer/components/style panels, Inspector, context/clipboard | Domain element/component/style collections; parent/reference validation; computed geometry CAS; explicit override fields | EI-Q06; editor-domains; existing Design/R2 tests                |
| Data cells/Form/Kanban edits, rectangular paste, row insertion/deletion/reorder                                          | Grid keyboard/editors/paste/context, Form Save, Kanban move                  | Per-row/per-column cell resources; atomic multi-cell transaction; type/formula/read-only/schema validation               | EI-Q07; editor-transactions/editor-domains; existing Data tests |
| Data column name/type/default/required/options/formula/format/order and named view save/delete                           | Field/schema menus, headers, view panel                                      | Schema dependency guards; invalid formulas/refs/types reject; named view values are shared                               | EI-Q07; editor-domains; existing Data tests                     |
| Data active projection/search/filter/sort/group/chart settings before Save view; canvas camera/page/tool/panels          | View controls, page/outline rails, zoom/pan and panels                       | Private view state; explicit named view Save is the shared mutation                                                      | EI-Q05/07/13/14                                                 |
| Review/File add annotation/reply/resolve/reopen                                                                          | Side/line/page/region selection, comments panel                              | Shared threads; fixed source/version/side/page/region anchors; source bytes/content remain immutable                     | EI-Q08; #3 fixed-anchor and #2 PDF/image/review tests           |
| Save/version history/restore/native and format export                                                                    | Header, Ctrl/Cmd+S, History, export menus                                    | Confirmed immutable versions; conditional restore; no remote snapshot Undo; ordinary exports omit sync/auth/presence     | EI-Q10/12; recovery tests                                       |
| Human/agent/template operations, preview/apply/reject/cancel/retry                                                       | Public prepare/text API, normal preview panel, reference C demo              | Same checked operation boundary, reads/stamps/token, idempotent apply, explicit new proposal after dependency conflict   | EI-Q02/09/11; #3 proposal unit tests                            |
| Read-only/revoked/expired writes, disconnect/reload/lost ack                                                             | All commands, text, shortcuts, proposals, assets, Undo and save              | Current trusted principal checked on commit; pending/rejected retained; same ID receipt recovery                         | EI-Q11/12; recovery/text/foundation tests                       |

## Capability states

Geometry writes require their target's geometry and relevant parent/subtree membership.
Alignment/transform commands declare all selected references, including an unchanged
alignment anchor; Design auto-layout includes ordered siblings and child geometry.
Whiteboard Section hit-testing reads Section regions; moving a Section also reads its
members. Independent moves on the same page, separate pages or unrelated Frames can
commit together. Same-object geometry, related layout and membership ABA still reject.
The old test that required independent sibling moves to conflict has been replaced by
an acceptance test and separate computed-dependency rejection tests.

New canvas input is also supported before its insertion is confirmed in Slide,
Whiteboard and Design. Text submits after insertion acceptance; rejected insertion/input
remain available for explicit re-preview or discard. Same-actor inverse pairs allow
multi-level Undo/Redo without weakening foreign-writer or proposal-history protection.

The entrypoint table above describes both local and shared implementations. Permission
rejection is a separate state from an unsupported operation:

| Operation family                                   | Local adapter                       | Shared adapter with write grant                                          | Read-only / revoked / expired                             | Shared unsupported                                                                                 |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Document body, canvas text and marks               | Existing local engine/history       | Injected engine steps and selective history                              | UI is read only; commit rejects; pending text is retained | Function-based whole-Document replacement and raw canvas text fields reject; use the public engine |
| Slide/WB/Design/Data commands listed above         | Existing pure domain command        | Prepared atomic domain transaction                                       | UI guards plus trusted commit rejection                   | Unknown extension fields/actions reject explicitly                                                 |
| Review/File annotations, replies and resolution    | Local annotations                   | Shared thread operations                                                 | Trusted annotation permission required                    | Source replacement is excluded from the shared artifact                                            |
| Review comparison source / File source replacement | Existing local import/create UI     | Disabled with immutable-source explanation                               | Same immutable-source rule                                | Typed `unsupported-operation` at the action boundary                                               |
| Version save/restore, Undo/Redo and proposals      | Existing local paths                | Confirmed save, conditional restore, selective Undo and checked proposal | Trusted grant required; no shortcut bypass                | Pending/rejected save is blocked with a reason; this is a state precondition                       |
| View state / ordinary exports                      | Existing local controls and formats | Private controls; confirmed native export, settled format export         | Private navigation remains available                      | Pending checkpoint is a separate recovery export                                                   |

Slide chart/table snapshots, themes/layouts and presentation navigation retain their
existing #2 scope. Their stored page/object changes use the same prepared transaction;
presentation navigation stays private. No new full chart engine or office-format
fidelity is implied. #4 template application is implemented; see the template contract and the #6 checkpoint.

## Animation schema 2

The ordinary Animation Surface uses `animationEditorCodec`, existing command
preparation and native canvas ProseMirror text steps. Stable-ID field changes,
explicit structural conditions and authority validation support selective Undo;
whole existing entity replacements cannot bypass native text preparation.
`animationEditorCodec.apply` and `applyReadonly` return deep-frozen content, and
`readFrozenAnimation2` returns an admitted frozen input itself. Callers copy such
content with `readAnimation2` before mutating it.
Root resource edits require the global grant. Playback and preview inputs remain
private. Shared export requires settled confirmed content. Legacy Animation in a
draft or saved history refuses shared admission; it does not fall back to local
editing. The reference service is not production authentication or durable storage.
See [capabilities and limits](animation/production-2d-design.md) and
[normal peer/authority evidence](verification/issue-74/README.md).

## Explicit boundaries

- Review comparison-source replacement and File source replacement are local creation/
  import operations. A shared review/viewer fixes its original. Their shared UI disables
  those source mutations; headless content actions reject `unsupported-operation`.
  Shared annotations/replies/resolution remain available.
- Document function-based whole-content commands reject `unsupported-operation`; normal
  Document views and headless integrations use its public ProseMirror engine. Canvas
  raw `.edit` text/runs fields also reject; public preparation converts compatibility
  text edits into engine steps. Unknown domain/root/element fields reject at preparation
  and trusted action validation, including future extension commands.
- The deterministic **agent demo** now prepares an actual change for each of the five editable domains under Issue #6. The public proposal
  protocol and preparation/text APIs support all declared domain operations. Other Hosts
  supply their own proposal producer; no generation engine is bundled.
- Save/restore and format exports do not imply pending input was saved. Save refuses
  unresolved pending/rejected input, format exports show a reason, and native JSON uses
  confirmed content. Checkpoint export retains pending/rejected operations and text.
- Sent intentions cannot be cancelled as if unsent: query their receipt. Missing or
  compacted text history/structural replacement requires review; arbitrary offline merge
  is not promised. Same-block text Undo or dependent geometry/order edits may explicitly
  conflict. Presence is transient and may be omitted until its revision is current.
- Production membership/RBAC, durable storage, asset garbage collection, large-scale
  transport and full office/design-product parity remain outside this change. #4
  templates and the later #6 practical-release checks are separate implemented milestones.

Every mandatory baseline row has an active shared path. An existing #2 regression proves
that a domain command/UI remains usable; it does not by itself prove every possible
concurrent ordering. The EI flows and pure adapter tests add concrete concurrent cases.

## Issue #6 follow-up coverage

R6-01/02 reproduce delayed Undo with a new edit and failed history sync followed by
reconnect/save/restore. R6-03–05 cover asynchronous recovery, failed-write retry and
pending exit capture. The separate Host verifies successful retention before detach
and a live editor after failed retention. These representative cases run on Chromium,
Firefox and WebKit. Prepared projection/envelope tests add mutable/immutable ownership,
snapshot metadata/codec invalidation, held same-cell rebasing and sent-byte invariants.
See final source and all results.

Design prototype interactions and optional `prototyping` root settings are prepared
through the existing Design editor transaction codec. They use native element/override
fields and a single root settings register, with authority permission checks and selective
Undo. Concurrent changes to the same root settings register conflict explicitly. Prototype
navigation, overlay history and flow progress remain private and submit no operations.
See [the prototype contract](design-prototype-contract.md) and its
[focused verification](verification/issue-246/README.md); this addition does not establish
new production transport or durability guarantees.
