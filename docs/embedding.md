# Embedding a surface

`layout.compactBreakpoint` sets the container width (px, inclusive) at which
toolbar tools move into **More editor tools**. For example, a Host with a 240px
sidebar can pass `layout={{ compactBreakpoint: 800 }}` to `DesignSurface` so
**Open prototype** remains visible in a 1,040px editor. The default is 1,100px.
Mounted changes and container resizes both update the toolbar. Nonnegative finite
values are accepted; invalid values use the default. Zero keeps tools inline for
positive container widths. Panel drawers still use their separate 800px threshold.
This is Host view configuration and is not saved in native content or panel state.

`apps/playground/embed.html` is a separate build entrypoint. Its `src/embed.tsx` imports only public package APIs and its own container CSS; it does not import Playground App, persistence, product types or stylesheet. The example mounts all seven domain surfaces, receives selection/command callbacks and controls panel state. It is also included in the production build.

Give a surface a container with a definite height and `min-height: 0` when inside flex layouts. The surface imports its own CSS. `layout.panels` and `layout.onPanelsChange` make navigation, inspector width and focus mode controlled; omit them for local view preferences. Compact controls and overlay panels respond to the container width, including a narrow embed in a wide browser.

```tsx
const [session] = useState(() => new EditorSession(createDeck()));
const [content, setContent] = useState(session.content);
const [panels, setPanels] = useState({
  left: true,
  right: true,
  rightWidth: 280,
  tab: 'properties',
  focus: false,
});

<SlideSurface
  content={content}
  execute={(command) => {
    if (!readOnly) setContent(session.execute(command));
  }}
  select={(ids, region) => onSelection(ids, region)}
  readOnly={readOnly}
  layout={{ panels, onPanelsChange: setPanels, viewKey: artifactId }}
/>;
```

The Host owns persistence, artifact/version lifecycle, permissions, annotation storage and event forwarding. Enforce permissions in `execute` as well as supplying `readOnly` to the UI. Review, Document and File surfaces accept annotations and a `focusAddress` for their local anchor display/jump. Other surfaces deliver domain element selections for Host annotation UI. Content models remain domain-specific.

`EditorSession` is a local, single-session history adapter. Do not feed remote changes into it: Issue #3 adds a separately validated collaboration path and selective shared Undo. The example's generic TypeScript switch is only composition over independently typed surface props, not a universal content schema.

QA-18 is exercised in `tests/e2e/issue2-embedding.spec.ts`: no Playground CSS request, actual edits in visual and text editors, Host Undo/Redo, read-only content invariance, external panel controls, narrow-container overlays and screenshots for every surface.

## Pending inputs and keyboard history (#44 / #47)

Import `EditorInputs` from `@editor-platform/editor-core` and
`EditorInputsContext` / `EditorHistoryContext` from `@editor-platform/editor-ui`.
Give each mounted artifact one registry and supply the existing Host Undo/Redo functions.
Canvas, Graph, Document body and the non-editing Data grid route Ctrl/⌘+Z,
Ctrl/⌘+Shift+Z and Ctrl/⌘+Y to the existing history owner. Document gives an
injected `textEngine` priority over the context, so shared Hosts retain selective
history. Native input fields keep browser input Undo. Canvas text editing without
a bridge keeps its existing private ProseMirror history until Done/blur commits
one domain command; it does not undo unrelated canvas operations while typing.
IME composition and read-only surfaces do not invoke these editing shortcuts.

Document also supports Ctrl/⌘+K for its link dialog, Ctrl/⌘+Shift+X for
strikethrough, Ctrl+backtick for inline code (Control+Shift+C on Apple platforms), and Shift+Enter for an in-block
line break (a newline inside code blocks). These use existing marks/nodes and
commands, without a second Document history stack or content schema change.
Mark bindings also check the view's editability when a Host invokes a key handler
directly; the Surface rejects content and stored-mark transactions while read-only.
Apply link replaces the URL on selected text or the contiguous link under a caret;
stored-only links before typing reopen with their pending URL and can be updated
or removed without changing adjacent text.
The modal finishes closing before the editor restores its caret and pending marks.
Remove link is a separate action. Markdown exports use inline `<br/>` for hard
breaks so headings and list items retain their structure when imported again.
Ordinary backticks and backslashes are escaped separately from actual code spans;
literal HTML/entity text stays literal instead of becoming an in-block break.
Code spans use a delimiter longer than any backtick run in their content, with
padding where required, so a generated hard break stays outside the code span.
Keep the latest Host callbacks in mounted Surfaces. Keyboard history uses the
same entrypoint as toolbar history; it must not unconditionally flush unrelated
buffers or bypass the Host's private-input history and permission checks.

```tsx
const inputs = useMemo(() => new EditorInputs(), [artifactId]);
const pending = useSyncExternalStore(inputs.subscribe, inputs.getSnapshot);

function save() {
  // React-controlled buffers can update the Host content during this flush.
  flushSync(() => inputs.flush());
  return persist(readCurrentCanonicalContent());
}

<EditorInputsContext.Provider value={inputs}>
  <EditorHistoryContext.Provider value={{ undo: hostUndo, redo: hostRedo }}>
    {surface}
  </EditorHistoryContext.Provider>
</EditorInputsContext.Provider>;
```

`getSnapshot()` returns stable `{ dirty, composing }` counts. Show pending input
separately from canonical draft persistence. Save, export and artifact/view transitions
must call `flush()` and stop on `EditorInputError`, then read the **latest canonical**
content. Catch the error and display its boundary label; `focus()` reveals the invalid
buffer. Failure recovery must reveal it directly rather than calling another flush.
Do not treat blur as a reliable substitute for keyboard Save.
Nested private controls must update their registered parent's draft directly:
preparing a parent before a child commits only React state would capture stale input.
FieldSettings decimals and Dashboard widget titles use this single-parent boundary.
The reference Host uses this boundary for Markdown/HTML as well as native export.
It waits for shared acknowledgement and refuses pending/rejected edits before
reading confirmed Document content. Leaving a shared session also flushes registered
Surface inputs and waits for acknowledgement before closing. Slide add/delete and
navigation retain the active editor/selection when input or command acceptance fails.
Blank and preset-layout Slide additions share this boundary. They prepare the new
slide from the refreshed canonical content, append it through the existing command,
and change the active page only after the Host accepts it.
Unfocused CommitInput fields reconcile clean canonical updates but retain invalid or
rejected drafts until correction, successful acceptance or explicit Escape.
Starting collaboration also flushes first and seeds the shared session from the latest
canonical record, preserving immutable saved versions. Put the registry above any Host
controls that can unmount a Surface. The independent Host flushes before Surface changes
and shared Detach; invalid, composing or refused input keeps the editor mounted. Its local
native sessions and Undo history survive Surface switches for the lifetime of that Host,
without adding persistence. Shared Detach checkpoints accepted pending operations before
suspending, so Attach can resume them even after an offline detach. Unlike Leave, Detach
does not require authority acknowledgement before suspension.
Template/reusable authoring follows the same input preflight, checks shared
pending/rejected/preview conditions, and retains its canonical/confirmed starting
source and selection IDs for both preview and saving. Later source changes do not
silently mix into that dialog. The reference Host shares its current-record reader
with text/CSV/Office capture. Async text capture checks artifact/session/registry
identity and newly pending input after confirmation. Surface-owned Document
MD/HTML/PDF downloads read one fresh snapshot after the guard succeeds.
Data chart SVG/PNG similarly capture the refreshed native Data and private view,
then recompute filtered rows from that pair before rendering/rasterization. A
registered input can change filter membership or accent during the guard; a
render-time row list or view closure is not a valid post-flush export snapshot.
Slide, Whiteboard and Design graphic builders follow the same rule, including
current page/Section/selection and Design padding/background/scale. They render
their domain-specific SVG/page data from the captured state before asynchronous
rasterization; an input flush cannot leave them reading an older render's content.

`useEditorInput({label, read, prepare, focus})` registers a Surface-owned buffer.
`prepare()` validates without editing native content and returns a synchronous function
that submits through the existing Host; return `false` or throw on refusal. All buffers
preflight before the first commit. This registry does not create a second document or
history, persist private buffers, or roll back commands already accepted by a Host if
another boundary later refuses. A Host must finish its ordinary shared acknowledgements
before persistence and handle authority failures through its existing Session.
On partial commit refusal, stop the outer save/export/transition and keep accepted
native changes plus failed/unexecuted drafts. Retry commits only still-dirty inputs;
do not restore an old snapshot to imitate rollback.

Data Form retains drafts by record; Graph attributes retain drafts by element. Each
Surface batches its hidden buffers into one source command. Invalid/stale input blocks
Save, retained deleted-target input can be copied/discarded, and composing input blocks
Save/switch without serialization. Input Undo remains private; explicit apply/flush
makes canonical history. Canvas text uses the same contract and native command after
ProseMirror composition is finished. Other Hosts must opt into these public contexts;
this does not certify every existing JSON/settings widget as a save boundary.

## Structured Graph (local mode)

`/graph-host.html` is a separate production entry for the public Structured Graph
Issue #3. `apps/graph-reference` imports public packages and its own CSS, without
Playground App/model/styles or product/framework dependencies. It demonstrates native
Graph, existing Data, a fictional Definition Adapter and an editable Profile source. This reference Host uses
explicit Save; save before switching source or reloading. IndexedDB, publication and
production durability belong to the Host.

Native import rechecks current access, target identity, source revision, artifact bytes
and request order after asynchronous file/hash validation. Edits and Undo during the
wait remain canonical; a stale import refuses without replacing that content or history.
Only the latest import request can install its result.
Use `readGraphArtifactFile(file, resolveProfile)` before reading a browser File: its
16,000,000-byte metadata gate runs before `file.text()`. `readGraphArtifact` also
checks UTF-8 bytes for direct string callers.

For a native graph use `GraphSession`, or route `graphCommand` through the existing
Host session with `guardGraphCommand`. `@editor-platform/structured-graph/model`
exports model, Profile validation, commands, session and Adapter contracts without
React/DOM imports. The main entry adds `GraphSurface`/`NativeGraphSurface` and package CSS.
`createGraphNode(profile, type, id)` supplies bounded scalar draft values; complex
or unsatisfiable fields remain absent with nonblocking required diagnostics.
The Surface combines its `readOnly` prop with `profile.graph.readOnly`; editing
tools are omitted and the Inspector displays attribute values, while selection and
camera controls remain usable. The trusted Host must also reject content edits.

Graph reading Hosts can configure these public props (also accepted by `NativeGraphSurface`):

| Prop                | Default                                  | Behavior                                                                                                                                               |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `showInspector`     | `true`                                   | Hide the built-in Inspector while retaining input buffers; connect a Host panel with `select`/`selectedId`.                                            |
| `initialView`       | `'origin'`                               | `'fit'`, `'origin'` or `{x,y,zoom}`; applied once per graph when the canvas is measurable.                                                             |
| `fitOnFilterChange` | `false`                                  | Refit when the `visibleNodeIds` set changes; equivalent arrays and ordinary content edits preserve the camera.                                         |
| `nodeSize`          | 200px width, automatic height (min 70px) | Optional fixed `{width,height}` or `(node) => ({width,height})`, 40–4000 logical px per axis. Supplied invalid sizes retain the fixed 200×70 fallback. |
| `visibleEdgeTypes`  | all                                      | Render only these relation types, composed with `visibleNodeIds`. `[]` hides all edges.                                                                |
| `highlightAdjacent` | `false`                                  | Emphasize the selected node and its direct neighbors/edges in the complete graph.                                                                      |

Camera, sizes, filters and emphasis do not change content, native versions or Undo.
Validation, diagnostics and selection notifications continue to use the complete graph,
including hidden nodes and edges. `Fit graph` includes the actual node sizes, routes
and normally visible labels. Without `nodeSize`, node text wraps within 200px and its
rendered height grows to show the complete label, including explicit newlines and
unbroken strings. Fonts, labels, type captions, overlays and edit controls can change
the measured height. Initial/filtered Fit waits for these measurements; subsequent
font loads or ordinary edits do not reset a manual camera. Use Fit again when needed.
Explicit `nodeSize` remains fixed and may intentionally clip content; the Host must
provide sufficient dimensions when it wants full text inside those fixed bounds.
Full `title` and accessible names remain supplementary. Automatic height is private
browser layout, never written into native positions or history, and does not move
nodes to resolve overlaps; existing routing refusal warnings still apply. Headless
`graphNodeSize()` retains its 200×70 fallback; it does not measure browser fonts.
Edge labels use available positions on routes; crowded labels appear on line hover,
keyboard focus or selection. Profile `edges[type].ui.edgeStyle` may declare
`{color: '#1d4ed8', dash: [6,4]}` to distinguish relation types. Only 3/6-digit hex
colors and up to eight positive finite dash lengths (each ≤64) are accepted; `[]`
means solid. Retain/increment Profile versions through the existing Host contract.
Explicit camera x/y are CSS pixel translation; zoom is clamped to 0.001–2.
Nonfinite coordinates or nonpositive zoom fall back to the origin. Zoom out also
reduces fitted views below 25% (halving down to the 0.001 minimum).
See [the reading design](graph-reading-design.md) and
[verification](verification/issues-224-228/README.md) for scope and limits.
Native object edits merge declared children and retain unmapped members at every
nesting level. The canonical guard also rejects unknown-member overwrite, null,
removal or array replacement that would lose retained data, including headless batches.
Initial node/edge metadata may be supplied by trusted creation or restoration;
subsequent editing cannot change those undeclared values.

```tsx
const [session] = useState(() => new GraphSession(createRelationGraph(), relationProfile));
const [content, setContent] = useState(session.content);
<GraphSurface
  content={content}
  profile={relationProfile}
  stamp={session.stamp}
  select={onSelection}
  readOnly={readOnly}
  onEdit={(intents, base) => {
    session.readOnly = readOnly;
    setContent(session.execute(intents, base));
  }}
/>;
```

For external JSON inject `GraphAdapter<Source>` into `GraphBinding<Source>` with
`read()` and the source's canonical `execute(command)`. It owns no history/source
copy. Always supply a source revision and enforce access at execute; proposal apply
also rechecks source bytes, Profile/Adapter pins and sidecar layout. Use the trusted
Adapter's `diagnostics` to connect the domain validator. Definition layout uses Host
`getLayout`/`setLayout`, while overlay/camera/selection remain private view state.

For Data use `DataSession` (or `guardDataCommand` at every canonical apply boundary)
and register `DataSurface.renderGraph` with `DataGraphSurface` from
`@editor-platform/structured-data-graph`. Supply the same Data session revision.
Grid/Form/Graph commands and Undo operate on that one session. Data and Graph core
packages do not import each other. Relations are one nullable row ID per relation
column in the same dataset; unsupported inverse mappings reject instead of creating
a second Artifact or embedding JSON in cells. Persisted positions live in
`StructuredData.graphView`; private filters do not remove hidden-target relations.
Use `assertDataReadable` to open legacy Data without discarding unresolved references;
the common command guard permits their repair and refuses new invalid references.
Graph projection requires resolved references. Long record IDs map to bounded stable
graph IDs; resolve them using `dataRowId(nodeId, canonicalData)`.
Column IDs use `dataFieldId(columnId)` consistently in attributes, relation types,
labels and diagnostics. Resolve projected fields with `dataColumnId(fieldId, data)`;
original IDs and unshown values remain canonical, including empty, reserved and long IDs.
For newly inserted rows, the common guard requires the exact `makeRow` defaults for
read-only cells and no stored formula cell. A violating CSV/headless batch refuses
atomically; readable protected values on existing legacy rows remain unchanged.
For local saved-version restoration, use `await restoreDataVersion(versionId, read)`
from `@editor-platform/structured-data`. Flush `EditorInputs` first and stop if input
cannot be committed; only then prepare and execute the restore. Accepted input stays
in native Undo history before the restore. `read` must return the Host-owned current
`{ artifact, revision, readOnly }`, never command-supplied content. The factory verifies
version ownership and content hash, then pins the complete Artifact, revision and
access again at execution. Execute the returned command intact through `DataSession`
or `guardDataCommand`. It restores exactly that saved content with the same Undo/Redo;
an arbitrary `host.restore` name or a copied command grants no exception. This is a
trusted local Host API, not a shared authentication or remote-message credential.
Repeated select options are deduplicated only in the projected Graph enum; the
canonical Data options and unshown values remain unchanged.
Existing shared Data transactions include graph view metadata during row/field deletion
and selective Undo, using row-specific position resources. Concurrent row deletions
retain the existing row-order precondition; the Graph Surface itself remains local-only.
Position values accept only finite bounded x/y, and Data History Compare describes
layout, label-field and view-presence changes. Use public `updateColumn`/`removeColumn`
commands for authorized schema edits of read-only fields; the guard still protects
their current values and refuses mixed unlock/value changes. Keep the command object
intact through wrappers so its internal schema intent reaches the common guard.
The fictional Definition Adapter merges declared object children and retains hidden
children. Clearing an object containing unmapped data refuses atomically.
Its derived edge IDs remain bounded and disjoint from native node IDs, including
512-character and reserved-prefix source IDs; original Definition IDs never change.
An unresolved or wrongly typed mapped reference explicitly refuses projection and
shows a diagnostic. The reference Host still displays and exports the original source;
it does not silently omit the relationship or claim in-Graph repair support.
When previewing a proposal, pass graph, Profile, stamp and diagnostics from the same
`proposalView ?? projection` result. Preview has a distinct display stamp so clean
Inspector buffers refresh; apply still checks the original proposal base.

See [the contract](structured-graph-contract.md) for limits and ID mapping, and
[verification](verification/open-issue-3/README.md) for measured functional coverage.
Graph has no shared/annotation/template/reuse/Office/React-export registration.
Consumers must not route remote content through the local Graph/Data session history.

## Shared mode (#5)

The same independent Host can receive a `SharedEditorSession` instead of a local
EditorSession. It routes commands/history through the injected adapter, supplies
Document/Canvas text bridges, presence and export guards, and leaves camera/panels
private. EI-Q14 uses independent contexts to edit the same Slide from `/` and this Host.
See [the adapter and lifecycle example](editor-collaboration-integration.md).

## Graph source and definition ownership (#43)

`GraphSurface.sourceActions` is a Host-owned `GraphSourceActions` contract:
`owner`, `readOnlyReason`, `onOpenSource(elementId)`, `onOpenDefinition(elementId)`
and `onEditDefinition(request)`. Without an editing callback, the definition viewer
shows the owner/reason and the full Profile. Node values remain the attribute form;
field types/names and relation constraints belong to the definition editor.
`DataGraphSurface.openSource(rowId?)` / `openDefinition(columnId?)` navigate to
canonical records/Fields even when projection cannot render. No Graph copy is saved.

For an owned editable Profile, `GraphDefinitionSource` holds `{graph, profile}` as a
separate Host source envelope. `previewGraphDefinition(source, change)` reports value
conversions and all resulting diagnostics. The built-in editor sends a
`GraphDefinitionRequest` with an exact source fingerprint, change and preview.
At apply the Host checks current access/base and **recomputes**
`prepareGraphDefinition(source, request.change, writable)` through its existing
`EditorSession<GraphDefinitionSource>`. Do not trust a request's preview as authority.
The command pins the whole source, increments the owned Profile version, preserves
unmapped data, and rejects unsupported field removal or invalid migrations.
History and persistence include the definition and migrated values together. Native
Graph artifact JSON remains unchanged; native Graph Profile resolution is still Host-owned.
`/graph-host.html` demonstrates this source, Save/Commit/Undo/Redo/reload and refusal.

`GraphSurface.locale` accepts `ja` (default) or `en`. `formatGraphDiagnostic` formats
code/args using current target names, field labels and corrective actions; IDs remain
in details and native data. Profile field UI can supply enum `{value,label}` options.
Routing/ports/highlights and drag previews are rendering/private state. A retarget/drop
submits one ordinary intent batch; both Data endpoints use one source transaction and
an occupied source relation refuses. Selected handles paint above other hit strokes.

## Audit #53–#73: inputs, views and Viewer source contracts

`EditorInputBoundary.read()` may expose `canUndo`/`canRedo`, and `history(direction)`
may consume a private view edit. `EditorInputs.history()` routes this before the
Host's existing native Session history; the snapshot reports the combined private
availability. A rejected `CommitInput.onCommit` returns `false`, retaining the
buffer and failing save/export/switch. Hosts that wrap React command execution must
flush synchronously at the input boundary before reading canonical content. Treat
export menus as menus; check actual input composition and pending proposals rather
than rejecting all open dialogs.

`DataSurface.initialView`, `onViewChange` and `onViewDraftChange` expose private
projection/preferences and unsaved widget status. Widget draft Undo/Redo is bounded
to 100 edits and clears on accepted named-view save. Ordinary Host Undo handles it
before native history; save/export/artifact switches flush it with `saveView`.
The reference Host keeps the last projection/filter/sort/chart/hidden-column settings
per artifact in its local browser storage. Reopening reconciles columns and takes
widget definitions from the native named view. It does not silently accept a cached
unsaved widget layout. Storage failure retains in-session preferences. Selection and
Session Undo history are not persisted across browser reload; preferences can be
lost when browser storage is cleared. None of these preferences changes contentHash.

`prepareCsvExport(data, {rowsScope, columnsScope}, view?)` is public and shared by
native and Host CSV UI. `all`/`filtered` rows and `all`/`visible` columns are explicit;
filtered/visible require the current view. Preview exposes row/column counts and
stable IDs. Values, relations and formulas are evaluated against the full source
before hiding fields. Output uses native column order, UTF-8 and CRLF with CSV quotes.
Shared Host capture reads `sharedSession.confirmed.content` after input flush and
the pending/rejection guard; a local library record is not advanced by shared edits.
`previewCsvAppend` accepts an explicit CSV-index-to-native-column-ID mapping and
uses the target schema, Select options and relation IDs for all-row diagnostics.
Explicit and name-matched formula targets report a blocking mapping diagnostic;
formula values are computed rather than accepted from CSV. Choose an editable target.
Read-only targets also block both automatic and explicit mappings. Rows wider than
the header (or first row without a header) report every extra value at its original
row/column, including empty trailing values; they cannot silently truncate an append.
Apply only a diagnostic-free result through the existing guarded row command.

`ReviewSurface.onSelectionClear` fires when visible file/source revision changes;
`onVisibleSourceChange` supplies its ID/name/old/new revision. Hosts must clear their
selection too and validate current target/revision/line ranges at comment submission
(`assertReviewSelection`). `resolveAnnotationSource(address)` may return retained
`{name, revisionId, side, text}`. The Surface verifies that exact source and line
range; missing/failed resolution shows a reason. Selecting any annotation, including a current one, invalidates a
prior asynchronous source lookup; a late response cannot replace the latest selection.
`onRemapAnnotation` is an explicit Host-owned annotation update, never an inferred
line jump or a ReviewContent history.
For legacy line anchors, `reviewAddressRevision(address)` supplies the same
`legacy:<file ID>:<side>` fallback as `reviewRevision(file, side)`; use it when
retrieving retained versions instead of comparing with an absent revision ID.
For a multi-file annotation, determine status from the displayed file's address and
replace only that address on remap. `remapReviewAnnotation(annotation, address)`
preserves other file/artifact anchors and thread metadata; a missing target is refused.
Validate the new current source/lines with `assertReviewSelection` before persisting it.
File replacement may change the source ID. `remapFileAnnotation(annotation, address)`
replaces one obsolete address belonging to the current artifact and preserves its
other anchors and thread metadata; a missing artifact anchor is refused.
The PDF viewer labels search results as partial when a page exceeds 10,000 matches
and explains the navigation limit. Narrower queries can expose the remaining text.

Hosts route Undo/Redo through `EditorInputs.history(direction)` before native Session
history and include `getSnapshot().canUndo/canRedo` when enabling controls. This applies
to independent Graph Hosts displaying Data as well as to the main Playground.

`FileSurface.onSelectionClear` fires on original-source replacement/Undo.
Replacement first shows the current file and annotation impact, then stages the
chosen file. Cancel leaves original bytes, comments and history unchanged.
Optional `onOpenAsNew` and `onRemapAnnotation` let a Host create a separate artifact
or explicitly rebind an orphan to a selected current region. Encoding defaults to
UTF-8 or a detected UTF-8/UTF-16LE/UTF-16BE BOM; the picker also accepts explicit
UTF-8, UTF-16LE/BE and Shift-JIS. Decoding failures preserve the original and explain
how to select an encoding or convert it.

File PDF search indexes at most 500 pages / two million characters and keeps the
original 32 MB input limit. It selects/copies existing PDF text and searches Japanese
phrases across text runs, without changing source bytes or native annotations.
Image PDFs have no searchable text; OCR and any new text annotation region are
Host extensions. Document searchable PDF uses the existing fixed Japanese font
route `/office-fonts/NotoSansCJKjp-Regular.otf` (OFL license and pinned SHA-256).
Missing/mismatched fonts and unsupported glyphs fail explicitly. Preview/export
share heading/next-block layout; oversized figures fit a page and long tables may
span pages. Body/table/list/code/HTML text remains searchable in native reading
order, while figures/Mermaid remain rasterized. Tagged PDF is not supported.

`OfficeExportHost.formats` declares PPTX and DOCX independently, with a disabled
reason. Existing configured Office Hosts default to both supported; surfaces without
an Office Host default to neither. These capabilities do not authorize pending IME,
proposals, unsupported content or a stale source.

`CanvasStage.overlay` renders world-coordinate content above painted native nodes.
Whiteboard uses it for selected connector endpoints with an enlarged hit target,
candidate feedback and cancellation; it never changes sticky geometry.
`applyFramePreset` chooses fixed native frame dimensions explicitly, optionally
fitting direct children for row/column layouts. Absolute/no-layout fitting is refused;
the fixed-size option retains child geometry. Native Design elements expose their
HTML meaning and image
alt text, and strict React diagnostics return to that Inspector without detaching.
See [audit scope](issues-53-73-audit.md) and its verification record for tested limits.

Document print/PDF checklist markers use `[x]` / `[ ]` for checked/unchecked state, so generated markers do not require glyphs absent from the fixed CJK font. Native checklist content is unchanged.

## Large native text

`DrawingView` keeps the full native text and assigns it to the SVG text's `aria-label` while
omitting screen text lines far outside the existing native clip, with four maximum-font ems of
overscan. Fit sizing and vertical alignment still use the complete text; expanded text keeps
every line. Low-level
`drawingPrimitives` / `textPrimitives` default to full output; `{ visibleTextOnly: true }` opts
into screen pruning. Native/SVG/Office exports retain full text.

In `CanvasStage`, each `CanvasObject` is a button named by `CanvasTarget.label`; its descendants
are presentational. The inner text's `aria-label` does not add its full text to that button's
accessible name. Design, Slide and Whiteboard canvas objects retain their existing target labels;
this change does not establish full-text screen-reader access through those objects.

Documents above 200 native blocks let supported browsers skip offscreen text layout/paint.
Every ProseMirror node remains mounted for search, native selection, editing and history.
Active text stays rendered, and ordinary find/outline/DOCX diagnostic navigation uses the
editor's native selection scroll. Print renders all content; browsers without the CSS features
render normally.
The Host keeps its existing content/command contract. See [targeted checks](verification/issue-269/completion.md).

## Design frame prototypes

Design retains the full native model for selection, editing and export while culling bounded
offscreen CanvasObjects with 128 CSS-pixel overscan. Selected objects, transform previews and
active text editors stay mounted. Expanded text and image failure UI remain mounted. Hosts supplying
`extension.render` retain all CanvasObjects because that callback can paint beyond native bounds.
At fit-all, all visible drawings still render.
Large Design layer trees window their rows; search covers the complete tree, Arrow Up/Down and
Home/End reach unmounted rows, and an active rename field remains mounted while scrolling.

`CanvasStage` offers this as opt-in `virtualize` plus `CanvasTarget.paintBounds` in world pixels.
Only supply a conservative bound for all painted content; omitted bounds always render. Slide and
Whiteboard retain their existing default rendering. This option never filters semantic targets.

`DesignSurface` includes ordinary interaction/flow settings and an Open prototype action.
A Host can also embed the separate viewer using public packages and the existing UI CSS:

```tsx
import { DesignPrototypeSurface } from '@editor-platform/design';
import { addAnnotation } from '@editor-platform/editor-core';
import '@editor-platform/editor-ui/styles.css';

<DesignPrototypeSurface
  content={design}
  artifactId={artifact.id}
  annotations={annotations}
  onFlowComplete={(event) => host.recordPrototypeRun(event)}
  onCreateAnnotation={(address, body) =>
    host.saveAnnotation(addAnnotation({ addresses: [address] }, body, host.actorId))
  }
/>;
```

The viewer requires a container with a defined height. `startFrameId` and `flowId` are
initial choices; the toolbar selects/restarts a run. `onAnnotationAnchor` can instead
route a stable native address to a Host comment composer. Instance parts use their native
instance ID plus a canvas Region in world pixels. The viewer never executes edit commands
or stores completion records. Host enforces annotation permission and persistence.
Pass the same callback props through `DesignSurface.prototype` for its prototype dialog.

Pure APIs are exported from `@editor-platform/design/prototype`: `setDesignInteractions`,
`setDesignPrototype`, `diagnoseDesignPrototype`, `startDesignPrototype`,
`activateDesignPrototype`, `applyDesignPrototypeAction`, `nextDesignPrototypeTargets` and
`designPrototypeTargets`. Editing commands go through the Host's existing Session and
permission boundary. Native fields and compatibility are defined in the
[prototype contract](design-prototype-contract.md).
