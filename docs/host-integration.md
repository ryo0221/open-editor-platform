# Artifact Host integration

Issues #33–#36 share the Host boundary, while preserving Slide, Whiteboard, Design
and StructuredData models. Code is an explicit reference Host extension. The pure
`@editor-platform/editor-host` package wraps the existing Artifact, EditorSession,
commands and StorageAdapter. It does not own application routing, identity, access
policy, SORA content, code execution or a universal node model.

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
canonical hashes before opening JSON (16 MiB UTF-8 limit). Save and native JSON
export enforce the same serialized envelope limit, including retained versions. An
oversized save fails before storage, preserving the previous saved record and dirty
draft; retained versions are never silently pruned. Retained version IDs,
parents and draft base are checked. Public commands are applied to private Session
input and domain-validated before commit, including mutating invalid commands.
Commands retain transaction/read context. Change listeners can read native content,
revision, dirty/saving state and selection; listener failures do not corrupt accepted
changes. Formats are adapter-specific, and unsupported requests return an addressed
`EditorHostError` rather than an empty successful export.

The reference application in `apps/artifact-host` uses only public packages and its
own CSS/models, without Playground state/CSS or SORA schema. Run
`npm run artifact-host:dev`; production output is built by `npm run build`.
`/access.html` is an explicitly labelled access-metadata fixture, not actual Site
policy configuration. `apps/studio-demo` supplies the separate SORA Host sources,
voice execution adapter and original-storage migrations for the actual existing Site.

## Session, input, save and close

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
