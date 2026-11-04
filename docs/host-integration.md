# Artifact Host integration

Issues #33–#36 share the Host boundary, while preserving Slide, Whiteboard, Design
and StructuredData models. Code is an explicit reference Host extension. The pure
`@editor-platform/editor-host` package wraps the existing Artifact, EditorSession,
commands and StorageAdapter. It does not own application routing, identity, access
policy, SORA content, code execution or a universal node model.

Hosts projecting objects through `CanvasStage` can opt out of resize per target
with `resizable: false` and cancel stale object previews with the optional opaque
`objectRevision` token. See the [Canvas interaction contracts](../packages/canvas-ui/README.md)
for identity, selection and cancellation rules. Native command permission and
revision checks remain Host-owned.

A pointer revision precondition belongs to that pointer operation. Clear it on the
matching `pointerup`/`pointercancel` even outside the Canvas parent, **after** the
synchronous Canvas command callback. The [R2 Host fixture](../tests/fixtures/canvas-r2/host.tsx)
and [R0 Host fixture](../tests/fixtures/fiction-map-r0/host.tsx) use a window bubble
listener, matching pointer ID and start timestamp, with listener cleanup on unmount.
Object terminal events must propagate to that listener; a Host intercepting them
must finish its own precondition cleanup after processing the command. Point input
keeps its separate preconditions and does not seed the object record.

Do not clear a command precondition on capture release or in an earlier capture
handler: normal commit releases capture before calling `onTransform`, so stale
commands still need validation then. After a canceled pointer finishes, a fresh
Arrow command uses the current native revision without requiring another click.

## Adapters and actual connection

| Experience   | Previous Studio                          | Current public connection                                                             | Declared output / limit                                                                                                    |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Slide        | Public native Surface, tab-local history | SlideContent / SlideSurface, existing commands                                        | Artifact JSON, SVG pages; local native PNG/PDF; no Office capture adapter                                                  |
| Whiteboard   | Public native Surface, tab-local history | WhiteboardContent / WhiteboardSurface                                                 | Artifact JSON, SVG                                                                                                         |
| React/Design | Independent React composition prototype  | DesignContent / ordinary DesignSurface plus design-react-core and #24 React contracts | Semantic native ProductPage TSX/CSS ZIP; generated page reused by Host; arbitrary original source imports unsupported here |
| Code         | Independent demo source/history          | Host CodeContent v1 / public ArtifactEditor and EditorCommand                         | JSON, TSX, opaque Host execution; React-only single file, ≤150,000 source characters; not Review/CodeDiff                  |
| Kanban       | Independent tasks array/history          | StructuredData / DataSurface Kanban and Grid                                          | JSON/CSV; same stable rows/fields/history, no second task model                                                            |

All five adapters declare local Undo, native JSON, explicit format names, preview
availability and `shared: false`. This reference Host does not expose annotation,
proposal, reuse or shared editing management. Existing upstream capabilities remain
separate. ReactUiSurface is a distinct Editor from Design; the Studio exercises the
merged Design–React bridge, not the full original-component authoring Host.

## Minimal public API use

```ts
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import { isDeck, insertObject } from '@editor-platform/slide/model';
import type { Artifact, StorageAdapter } from '@editor-platform/artifact-core';
import type { SlideContent } from '@editor-platform/slide/model';

const adapter = {
  kind: 'slide',
  validate: isDeck,
  capabilities: {
    undo: true,
    nativeJson: true,
    formats: [],
    preview: 'none' as const,
    shared: false as const,
  },
};
// Storage and current permission come from the consuming Host.
const artifact = await loadHostArtifact(nativeJson, adapter);
const host = new ArtifactEditor(artifact, adapter, storage, () => permission.edit);
const detach = host.attach(() => render(host.snapshot));
host.execute(insertObject(artifact.draft.content.slides[0].id, 'text'));
const result = await host.save({ commitVersion: true, author: hostIdentity });
// result: artifactId, kind, revision, artifact (native draft + versions), dirty.
receiveSavedArtifact(result);
detach(); // Surface unmount; Session/Undo/Redo stay alive.
// Explicit end, only when saved or after an explicit discard decision:
host.close('require-saved');
```

`Artifact<T>` and `StorageAdapter<Artifact<T>>` retain the native T. A validator checks
initial/draft/all retained version content; `loadHostArtifact` additionally validates
canonical hashes before opening JSON (64 MiB UTF-8 limit). Save and native JSON
export enforce the same serialized envelope limit, including retained versions. An
exported `hostNativeArtifactByteLimit` exposes that byte budget to consuming Hosts
for preflight estimates; an estimate never replaces the serializer's final check. An
oversized save fails before storage, preserving the previous saved record and dirty
draft; retained versions are never silently pruned. Retained version IDs,
parents and draft base are checked. Public commands are applied to private Session
input and domain-validated before commit, including mutating invalid commands.
Commands retain transaction/read context. Change listeners can read native content,
revision, dirty/saving state and selection; listener failures do not corrupt accepted
changes. Formats are adapter-specific, and unsupported requests return an addressed
`EditorHostError` rather than an empty successful export.

The native byte budget is an admission limit, not a storage quota guarantee. The
reference application's `BrowserArtifactStorage` uses localStorage and can fail
well below it. Hosts handling large artwork can inject the existing artifact-core
`IndexedDBStorage` with their own database name, or another durable adapter. A
storage quota failure remains `save-failed`, retains the draft and previous saved
record, and must not be reported as saved.

The reference application in `apps/artifact-host` uses only public packages and its
own CSS/models, without Playground state/CSS or SORA schema. Run
`npm run artifact-host:dev`; production output is built by `npm run build`.
`/access.html` is an explicitly labelled access-metadata fixture, not actual Site
policy configuration. `apps/studio-demo` supplies the separate SORA Host sources,
voice execution adapter and original-storage migrations for the actual existing Site.

## External tools: saved notification, saved read and proposal review

Issue #400 adds the part of the boundary an external tool needs (AI, MCP or any
Host automation) so a product Host no longer reaches into Playground state or injects
source at build time. The tool, its triggers, duplicate suppression, authentication
and approval policy stay in the Host; the Editor adds no agent runtime and no second
save or Undo path. `apps/artifact-host/host-api.html` is an independent fixture Host
that uses only these public entrypoints for Document and Structured Data.

| Playground internal connection (not public)                            | Public API                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| App save flow and `recordsRef` after a save                            | `ArtifactEditor.onSaved(listener)` — only after `StorageAdapter.put` succeeds                                   |
| Stored record / version list read from App state                       | `readSaved()` (persisted draft) and `readSaved(versionId)` (immutable version with its hash)                    |
| ProseMirror `textContent` of the visible editor                        | `readText('saved' \| 'draft')` with the adapter's `text` reader; Document: `@editor-platform/document/text`     |
| `requestProposal` → `previewProposedCommands` → `ProposalDialog` state | `propose(proposal)` returns a review with the native preview; `proposals` lists pending reviews                 |
| `applyProposal` (canonical base and local revision checks)             | `acceptProposal(id)` / `rejectProposal(id)`; `onProposalResolved(listener)` returns the outcome and dirty state |

The existing `ArtifactEditor`, input boundaries, permission callback,
`previewProposedCommands` and `transaction` are reused; domain models stay separate.

- **Saved notification.** `HostSavedEvent` carries artifact ID, kind, `versionId`
  (the draft's base version, the new one when `commitVersion` was requested),
  `committed`, the `revision` captured when the save started, and the
  `currentRevision`/`dirty` at the time it is sent. A failed or oversized save sends
  nothing. A slow save never overwrites newer edits; its event says `dirty: true`.
- **Saved read.** The tool reads persisted content only. An unknown version returns
  `version-missing`.
- **Proposals.** An adapter opts in with `capabilities.proposals: true`. `propose`
  requires edit permission, a unique ID and, when given, a `baseLocalRevision` equal to
  the Session revision (`proposal-stale`). Commands that throw or produce invalid native
  content return `proposal-invalid` and nothing is registered. The review's `preview`
  is computed on a copy; the draft is unchanged. A later draft change marks the review
  `stale`. `acceptProposal` is the single path for ordinary review UI and headless
  callers: it checks permission (`read-only`), flushes input boundaries (a pending input
  throws and keeps the proposal), refuses a stale revision (`proposal-stale`, outcome
  `stale`) and applies one `origin: 'proposal'` transaction, one Undo unit. `propose` keeps a frozen
  copy of the submitted commands, so later changes to the caller's object never reach
  accept, and accept commits only when the result equals the reviewed preview
  (`proposal-invalid` otherwise, the proposal stays pending). The
  accepted result is an unsaved draft change (`dirty: true`) until the Host saves.
  Rejecting changes neither content nor history. Closing the Session withdraws open
  proposals.
- **Changed elements.** An adapter that sets `changedElements(before, after)` gets
  `changedElementIds` on an accepted result: the stable IDs whose content the reviewed
  preview changed, added or removed, once each. Document uses
  `documentChangedElementIds` (`@editor-platform/document/proposal-diff`): block,
  paragraph, list-item and table-paragraph IDs, including every item or table paragraph
  inside an added or removed list or table. Other domains can use
  `changedElementsFromDiff(proposalDiffAdapter)`. Artifact-level settings and saved view
  changes are not listed. A Host records which parts came from a proposal (provenance)
  from these IDs. A reader that throws refuses the accept (`proposal-invalid`) and keeps
  the proposal pending. Without `changedElements` the field is absent.
- **Document text.** `documentText(content)` returns text with each native hard_break
  as `\n`, segments joined by a blank line, and stable segment IDs (paragraph, heading,
  code block, list paragraph, table-cell paragraph). Every character is one engine
  position. `findDocumentText` finds a unique range inside one segment,
  `locateDocumentText` converts a whole-text range, and `documentTextEditCommand`
  applies replacements through engine steps, keeping the first replaced character's
  marks and refusing changed (`expected`), overlapping or cross-segment ranges.
  Embedded blocks have no text segment. ProseMirror `textContent` has no character for
  hard_break and must not be used to address native text.
- **Listeners.** `attach`, `onSaved` and `onProposalResolved` each return their own
  release function; releasing twice is harmless and `close` clears all. Listener
  failures go to the observer error callback and events are copies.

Declared scope: Document supports text read and range proposals; Structured Data
supports native command proposals (for example `setCell`) and declares no text reader
(`readText` returns `unsupported`). Schedule was not connected through this API in
#400 (NOT RUN); its external apply plan remains the separate Schedule Editor–Host
contract.

## Session, input, save and close

### Final proposal assertion and exact apply observation

`ArtifactEditor.propose(proposal, hooks?)` accepts optional `HostProposalHooks<T>`:

- `beforeApply()` is a synchronous, void-returning final assertion. Preview does not
  call it. The owned commit commands retain it, including when a caller extracts a
  command from review and invokes `execute`. It may run once per command; it must be
  pure and idempotent. Throwing, returning a value/Promise, losing native permission,
  or changing the target revision refuses the proposal before its commit. Do remote
  preflight before entering this synchronous boundary; it is not a distributed lock.
- `onApplied(event)` observes one successful `acceptProposal`, before Surface/change
  subscribers can edit again. `HostProposalApplied<T>` contains Artifact/kind,
  proposal/transaction IDs, exact before/after local revisions, a copy of the accepted
  content, and the adapter's `changedElementIds` when supplied. Domain adapters may
  use qualified address keys. Later changes to the hooks object do not replace the
  captured callbacks. The accepted proposal is removed before observers run.

The retained preview owns independent base/content copies, even when a command
retains the object it returned. Accept checks the actual command result against
the reviewed content, validates it, then derives changed IDs inside the same atomic
commit boundary. The diff reader receives independent copies; its returned ID list
is copied too. A failed diff or a permission/revision change during inspection
refuses the commit. These checks finish before apply/Surface notifications.

This is an unsaved local apply observation. Reject/stale/failed apply and Undo/Redo
do not emit another apply receipt. The existing `onProposalResolved` outcome retains
its semantics; after a reentrant subscriber edit its revision can already be newer,
so use `onApplied` when exact accepted content/revision is required.
Executing an extracted command enforces its final guard but does not accept the
proposal or emit `onApplied`. For formal generation adoption the Host must reconcile
the successful `acceptProposal` result with its apply observation; ordinary native
editing alone does not establish generation adoption or saved usage.

The Host owns durable recording. Synchronous throws and rejected observer Promises
go to `onObserverError`; they do not undo the native commit or make it a failed apply.
Capture the event first, then retry recording idempotently using the transaction ID
and the Host's preallocated operation ID. No event is replayed after a crash/reload.
Do not infer a lost request association merely from equal image bytes.

To record an immutable saved version, observe `onSaved` after successful storage,
require `committed`, and inspect `readSaved(event.versionId)` with its real hash and
content. Independently establish whether the applied operation remains in that save.
An apply receipt alone, or a save after a pre-save Undo, is not saved usage. Persisted
draft saves must not be attributed to their unchanged base version. These callbacks
do not make the native store and a Host receipt store atomic.

`ArtifactEditor.proposalTransactions` exposes copies of the proposal transaction IDs
in the current local native history branch. The IDs follow the same Undo/Redo entries;
ordinary edits retain them, Undo before an apply removes them, and a new Session starts
empty. This is ephemeral general proposal ancestry, not persisted provenance or a
second history. `onSaved` additionally captures `proposalTransactions` and `baseVersionId`
with the saved revision, before asynchronous IO. Later input cannot rewrite that witness.
A consuming Host must still verify the real saved target/content, or a confirmed retained
base usage after reload. The IDs alone do not prove that an image still uses that result.
`withdrawProposal(id)` removes a pending review without a native content/history edit.

The Host retains one controller per artifact ID. Attach/detach removes Surface
listeners only. Switching kind or selecting another artifact does not reconstruct
EditorSession; two same-kind artifacts have separate history. Selection and
`viewState` are private, outside native versions/content/history. Reload starts new
local history from saved native content. Explicit close clears listeners, registered
input guards, selection, view state and history. Host deletion must close first and
then invoke its storage removal policy; Studio does not expose artifact deletion.

`registerInputBoundary(flushOrThrow)` lets ordinary text input commit before save,
switch, export or Undo. Composition/unconfirmed native dialogs block those actions
with a recovery diagnostic. Native editor input guards are inherited, including
OfficeExportHost's existing canvas text guard. Unmount unregisters the buffer.
A failed flush retains the edit buffer; confirm/cancel it before retrying navigation.

Save captures native content and revision, optionally commits an immutable version,
and awaits StorageAdapter.put. Failure retains draft/history and returns `save-failed` for storage failures or
`invalid-artifact` for an oversized native envelope.
A failed/uncertain put retains the exact candidate (including its immutable version ID).
Retry reuses that candidate; if later input changed, resolve the old candidate before
saving the newly captured content. A superseding draft-only write creates no version.
The uncertain put remains dirty and blocks require-saved close even when bytes equal
the previous draft. This does not make a blind storage adapter a distributed CAS:
consuming Hosts still own storage conflicts and commit-time authorization.
Concurrent saves/close return `save-busy`. A delayed success updates the saved baseline
without overwriting newer Session edits; `result.dirty` requires another save.
The trusted Host checks permission at command/Undo/Redo/save boundaries and its storage
must enforce authorization at actual commit time. Disabled controls alone are not an
authorization boundary. No remote edits may enter this local snapshot history.

Studio “編集を保持して戻る” keeps the Session in this tab; “保存してアプリに戻る”
returns the saved native envelope and ID to the list; “取消” requests an explicit
modal discard decision. Save failure supports retry through the same button. Native
JSON opens a new Session after full validation, refuses replacement of dirty/pending
or read-only sessions, preserves nonconflicting retained versions, and rejects version conflicts.
The public `importContent` API instead replaces the current native draft in one Undo
transaction. Import does not silently persist. Imported and duplicated artifacts are tracked
as browser-unsaved even before a Session is opened or while its native draft is clean.
The unload guard retains that state across failed saves and clears it only after
StorageAdapter.put succeeds. Seed samples alone do not trigger this guard. Browser storage is local, quota-limited
and not cloud durability; tab close/reload cannot retain unsaved in-memory history.

## Proposal freshness

A proposal generated from other Artifacts records what it read. `ProposedCommands.reads`
holds the target Artifact with the committed version its draft was based on, and each
referenced Artifact with one exact immutable version ID. These are the existing
`ArtifactVersionRef` IDs; there is no second version scheme. The Host or Runtime that
builds the proposal records them. The Editor never discovers references itself.

```ts
import { applyHostProposal, previewHostProposal } from '@editor-platform/editor-host';
import type { CurrentRead } from '@editor-platform/artifact-core';

// The Host answers for each referenced Artifact under the reviewer's current access.
const read = (artifactId: string): CurrentRead | undefined =>
  !canRead(artifactId)
    ? { status: 'forbidden' }
    : exists(artifactId)
      ? { status: 'available', versionId: currentVersion(artifactId) }
      : { status: 'missing' };
const review = previewHostProposal(host, proposal, read); // check + whole result, or check only
const check = applyHostProposal(host, proposal, read); // rechecks, then one Undo transaction
if (!check.fresh) showStale(check.stale); // keep the proposal for discard or regeneration
```

`checkProposalReads` in `@editor-platform/artifact-core` is the pure check. It returns
the stale reads with their reasons: `version-changed`, `missing`, `forbidden`, or
`unverified` for an Artifact the Host did not answer for (`draft-changed` comes from
the Host helpers). The Host helpers take the
target's state from the Session itself. A new committed version, a draft changed since
`baseLocalRevision`, or a read-only permission makes the target stale. The check covers
the whole proposal, so a partial change over several rows is adopted completely or not
at all. A stale proposal changes neither content nor versions.

Regeneration, grouping save notifications and reasoning about business dependencies
belong to the Host. A local check is not an atomic guarantee: a reference can change
after `applyHostProposal` returns, and the final consistency and access enforcement
stay with the trusted Host or authority. Shared proposals carry the same IDs in
`Proposal.external` and are checked at the authority commit point
([collaboration contract](collaboration-contract.md#proposals-and-intent)).
Verification.

## Outputs, execution and access

The list renders a saved Slide through its public native SVG exporter. Design edits
produce actual generated TSX/CSS through the public bridge; accepting conversion is
explicit, and saving returns that native content to the Host, which independently
compiles/reuses the output. React files contain no Editor/history runtime. Unsupported
native semantics/dependencies are diagnosed; generated output is not editable
original source. Independent React-side modifications must remain in their consuming
project; the Studio does not synchronize those modifications back into native Design.

Code compilation and execution are Host-owned. The reference compiler accepts React
and generated local modules, rejects external/dynamic imports and bounds sources.
Execution occurs only inside an opaque `allow-scripts` iframe with CSP blocking network
and forms. Exact frame/origin/token/render-revision checks and cleanup protect transport.
The standard #24 separate-URL protocol remains distinct from this reference Host
transport. Syntax/runtime errors preserve source and can be corrected/rerun. The voice
extension offers simulation; real microphone use remains explicit and browser-dependent.
Each successful Studio Code execution, including an unchanged source rerun or sample reset,
creates a fresh iframe realm. A frame/opaque-origin checked ready handshake sends the initial code exactly once;
previous globals, timers and listeners do not receive a new render envelope. Custom
Code surfaces contribute their natural height so Host capability text does not overlap
their controls at narrow widths.

`HostAccessAdapter` supplies trusted scope/revision/expiry/source, optional policy-change
notifications and abortable reads. `HostAccessDisplay` invalidates before refetch,
rejects older/conflicting revisions, and falls back to neutral wording after expiry,
unknown metadata or failure. This is display metadata, not access enforcement.
Static Studio has no authenticated live-policy endpoint and always uses the neutral
“共有設定はHostで確認”. Browser-local storage wording is separate from Site audience.
The existing Site remains public with policy revision 2; no access-policy update is
performed. Other scopes are tested only with fixtures.

See the [design](host-integration-design.md) and
verification record for tested scope, failures,
NOT RUN conditions and source/publication provenance. Native OS IME, physical devices,
other browsers, real microphone and cloud/shared operations are not certified here.
Actions stay manual-only; #22 performance acceptance and measurement/tuning remain held.

Code source history groups consecutive typing only. Caret/selection changes, blur,
execution and Studio sample replacement delimit groups. Both reference Code runners
replace the opaque iframe for every successful execution, including unchanged source;
previous globals, timers and listeners cannot receive the next render envelope.
Studio startup runs beneath its error boundary so unavailable browser storage renders
a recovery diagnostic instead of an empty application.

`breakHistoryGroup()` separates source typing without invoking input flush or blur;
caret/selection changes use this path. Toolbar menus carry `data-editor-menu` so
flush distinguishes them from unresolved editing dialogs. Native import reads current
Session/list state after asynchronous validation and retains newly saved versions.
Declared Design root pages determine the preview entry and saved reuse symbol.
PPTX is explicitly unavailable in this reference Host.

Analysis uses the optional `EditorHostAdapter.preflight(artifact)` hook for async domain verification at load, save and native export. See the [Analysis Host guide](analysis-notebook/guide.md). The hook verifies every retained version without rewriting it.

Estimate also registers `verifyEstimateArtifact` as its async preflight and reprojects retained CAD/BIM quantities before admitting results. The Host supplies `EstimateBimEvaluator` for kernel quantities, honors its AbortSignal, and owns Data publication permissions, receipts, persistence and retry through `WorkPublicationHost`.
Its pure calculation model remains separate from Data and CAD/BIM; see the Estimate Host guide.

## Fiction Map local bridge

Fiction Map uses the existing per-Artifact Session and storage lifecycle. `adoptFictionMapBase` validates an owned native snapshot and pins canonical content/revision. `FictionMapArtifactSurface` accepts the existing ArtifactEditor directly; the minimal public history bridge (`peekHistory`, optional synchronous candidate validator for Undo/Redo) enables D1's validated commands without exposing a second history. Existing consumers may omit the validator.

Hosts retaining a mounted Surface while masking revoked read access can supply
`FictionMapArtifactSurface.mayRead(): boolean`. Saved-image output checks that live
grant and its observed access generation after asynchronous work, independently of
`host.readOnly` (which can remain true for a viewer). Revocation followed by restoration
invalidates an earlier output; a newly requested authorized output can proceed.
The Host must also remove unauthorized content from the displayed document and
retain pending input/leave guards; this callback supplies no DOM masking or identity service.

Draft and all retained versions require D1 admission and retained hash verification. Generic draft image export is unsupported for this adapter; the explicit saved-version output panel produces SVG/PNG from an immutable version and saved view. Input boundaries reject unresolved Inspector/composition/drawing text rather than silently saving it. See the D3 contract and verification.
