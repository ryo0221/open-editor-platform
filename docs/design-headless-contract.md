# Design headless operations (#294 / #295)

Design extension, design version 1, 2026-10-19 JST. Base main `076d0159`.
This adds typed JSON proposals and strengthens native commands in the existing
Design domain; no new Editor, universal node model, agent runtime or history.

Public entrypoint: `@editor-platform/design/model` (Node-safe, without React/CSS).

```ts
const add = insertElement('text', {
  id: 'heading', parentId: 'frame', index: 1,
  bounds: { x: 40, y: 50, width: 240, height: 80 },
});
session.execute(add); // add.elementId is stable even when id was omitted
const preview = previewDesignIntents(session.content, [
  { type: 'update', id: add.elementId, patch: { text: 'New heading' } },
], { baseLocalRevision: session.revision });
session.execute(prepareDesignIntentApplication(preview.intentProposal, {
  readRevision: () => session.revision,
  writable: () => hostCanEdit(),
}));
```

The example assumes an existing frame and a Host-owned `EditorSession`. A Host
may instead submit the prepared command through its existing trusted native
authority, using that authority's canonical proposal/permission boundary.

## Scope and ownership

Hosts provide artifact identity, current content/revision, access policy, storage
and execution. Design provides deterministic commands, bounded intent parsing,
preview, diagnostics and a command prepared for explicit adoption. The existing
EditorSession or shared authority remains the sole owner of editing/history.

Element and instance insertion accept an optional ID, bounds, parent and insertion
index. Missing IDs are generated once when creating the command, exposed on that
command as `elementId`, and retained across preview/apply. Existing calls with an image source
string remain valid. Index is the position in the native flat elements array,
from zero through its current length. Parents must be existing frame/group
containers. Duplicate IDs, invalid bounds/indices and missing references reject.
Bounds use native absolute/world CSS pixels, including when a parent is supplied.

The JSON batch declares insertion, instance insertion, update/properties,
transform, delete, reparent, instance override/reset, component creation/update,
part update, interactions and prototype settings. Unknown operations/fields and
executable/non-JSON values reject. A batch is at most 1,000 intents and uses the
existing 32 MiB / 200,000 values / depth 64 JSON budgets. This is a functional
input ceiling, not performance acceptance.

`parseDesignIntents(unknown)` returns an owned immutable normalized batch,
including generated element/component IDs. `designIntentCommand(unknown)` is a
single ordinary transaction, without a preview requirement for trusted Host use.
Intent discriminants are `insert`, `insert-instance`, `update`, `properties`,
`transform`, `delete`, `reparent`, `override`, `reset-instance`,
`create-component`, `update-component`, `update-component-part`,
`set-interactions` and `set-prototype`. `set-prototype.settings: null` clears
metadata; `set-interactions.interactions: null` clears an explicit interaction.
Omitted `reparent.parentId` moves to the root. React insertions still require the
registered React integration; these intents do not import arbitrary JSX or code.
Duplicate, group, align, layer arrangement and detach remain native-only in this
intent version; unsupported JSON discriminants reject explicitly.

`override.partId` accepts either the existing scalar part ID or an array of 1–16
native IDs from the outer component to the addressed leaf. IDs are opaque and
never split on punctuation. For example, `{ type: 'override', id: 'card',
partId: ['section', 'title'], patch: { text: 'New title' } }` edits that nested
instance-local label through the same command, preview and adoption boundary.
Empty/overlong paths and non-ID values reject. Other intents that declare
`partId` continue to accept a scalar only.

UI and headless callers use the same native command factories. Writes validate
their targets, values and resulting native shape before returning. Invalid
commands and multi-command failures leave content, revision and Undo/Redo
unchanged. Existing saved versions are never rewritten.
Structured patches reject undeclared keys in native envelopes, including layout,
constraints, crop, typography/text runs, vectors and embedded-reference metadata.
Declared dictionaries (public props, slots, breakpoints) and retained foreign
domain content keep their own schema semantics. Generic patches cannot change an
element's type or add/replace/remove its React component identity, import or slots;
use registered React insertion/revision/slot commands for those operations.
Existing React props/bindings edits remain supported. Parent patches check the
destination and its ancestors/subtree for locked/hidden content, using native
reparent semantics. Template-only instance definitions remain editable without
inventing an element-level component reference absent from schema 1/2.

Preview returns the existing baseContent/content/proposal shape plus a portable
`intentProposal` and prototype diagnostics. Only `intentProposal` is JSON data;
the common `proposal.commands` contains trusted functions and is not a wire format.
`DesignIntentProposal` pins `schemaVersion: 1`, ID, summary, normalized intents,
`baseContentHash`, `resultContentHash` and optional `baseLocalRevision`.
Preview is pure; adoption recompiles
the retained intents and checks current content fingerprint, any supplied local
revision (including ABA) and current Host writability inside command execution.
Adoption is one existing transaction. Reject/cancel means discarding the preview.
Preview data is not authorization; trusted Host/authority enforcement still applies.
If a local revision is present, apply requires `readRevision`; Undo back to equal
content does not revive the old proposal. Without one, only content equality is
checked and ABA/session identity must be protected by the Host. All callbacks
must read current trusted state. Results are checked against the preview hash.
Mutation after preparation cannot change its captured intent payload.

`guardDesignCommand(command, writable?)` also validates the result of a trusted
arbitrary command and checks writability inside execution. It does not grant
permissions or make a callback supplied by untrusted content authoritative.
Validation failures include `DesignCommandError` with `code`, `message` and
optional `path`, and existing lower-level JSON budget diagnostics. Invalid
factories can reject during preparation; invalid/stale targets reject on apply.

Existing malformed prototype destinations remain readable and diagnosable after
deleting a frame. Explicit interaction/prototype writes validate newly submitted
frame references; unrelated edits do not rewrite retained broken links.

## Capability and acceptance matrix

| Capability | Scope / acceptance evidence |
| --- | --- |
| N01–N05 model, validation, versions, commands/history | Node tests for stable IDs, exact placement/order, ownership of inputs, invalid patches and atomic batches |
| N06/N07 independent and ordinary Host | Public-only independent Host and existing ordinary Design editing in production Chromium |
| N08/N11 selection, keyboard, mobile | Existing Surface behavior, exposed inserted ID and desktop/mobile inspection; no new gestures/IME engine |
| N09/N12 permissions and untrusted data | Bounded JSON parser; commit-time access/revision/target checks and unchanged failure histories |
| N10 native persistence | Existing schema 1/2; save/reload/JSON roundtrip, preserved prior native data |
| N13/N14 reproducibility/docs | Lint/typecheck/unit/build, focused desktop/mobile regressions and verification report |
| C03 headless/proposals | Typed JSON, pure preview, stale/ABA/revocation and one-step Undo/Redo |
| C04 shared | Commands continue through existing trusted native transaction/proposal adapters; no separate shared intent runtime |
| C01/C02 text/annotation | Existing native text/anchor behavior; no new text engine or annotation feature |
| C05/C06/C08 template/reuse/React | Preserve native contracts and existing regression coverage; no new authoring/bridge capability |
| C07/C09 formats/large assets | No new formats, asset fetching or storage/durability promise |
| C10/performance/release | Physical devices, native IME, other browsers and new performance acceptance remain NOT RUN; no Actions dispatch, product trial, public sync or deployment |

Actual PASS/FAIL/NOT RUN/N/A outcomes and reproducible commands are recorded in
[the verification report](verification/issues-294-295/README.md).
