# Template contract (#4)

Templates contain versioned domain-native content, declarative input bindings and layout
policies. Whole creation, fragment insertion and scoped presets are distinct operations.
The catalog does not own organizations, Rooms, visibility policy or agent execution.
Host adapters supply access and catalog storage. No template data executes JavaScript.

Human forms and headless clients use the same input schema, validation, expansion and
prepared request. A prepared request fixes IDs, version/hash, inputs and target dependencies.
Creation uses an idempotent request ID and ordinary Artifact storage. Cancelling preparation
creates nothing; failed writes can retry the same prepared ID. Insertion/presets use normal
Editor commands; shared application registers a checked proposal and adopts it through the
existing authority. Document insertion produces ProseMirror steps, never a snapshot restore.
Review/Viewer presets are private view settings and cannot change source bytes or revisions.

Immutable versions are separately addressable even after catalog archival. New revisions
never update existing artifacts. Pack import verifies hashes, schemas, bindings, assets and
internal references before saving; conflicting immutable versions reject. Local catalog
storage persists definitions and recent choices. Generated artifacts contain native content
and minimal template identity/version/hash provenance, without an ongoing catalog dependency.

Each domain retains its semantics: ordered Slide pages, Whiteboard Sections/membership and
connectors, Design Frames/layout/components, Document semantic blocks and Data typed fields,
formula references and views. IDs are remapped with internal references, including formula
and view field IDs. Data insertion previews explicit source-to-target field mappings; matching
names are not identity. Unsupported capabilities and external dependencies reject before apply.

Data expansion binds both bare and bracketed formula names to source column IDs before
remapping IDs or applying destination names. Relation cells, defaults and filter values
follow row ID changes; ordinary text with the same value remains literal. A mapped
fragment is remapped once while its complete source schema is available, including
relation fields reused from the destination.

Design component parts have IDs scoped to their definition. Creating a composite can
retain the first part's ID on the canvas instance; validation permits this across scopes
while rejecting duplicates within a scope. Fragment placement translates only world
coordinates on canvas elements. Component definitions and instance overrides retain
their local coordinates, including local bounds overrides.

Layout policies are bounded and explicit: Document reflow, Slide pagination or validation,
Whiteboard grid/Section expansion, Design native auto-layout, and typed Data rows/views.
Geometry/text diagnostics prevent silently clipped input. Preview uses domain renderers.
Design authoring can explicitly select a 10px minimum and instance text validation;
`measureTemplateTextFit` exposes the same deterministic preflight. Defaults and immutable
legacy definitions are preserved. See [Design text and graphics](design-reuse-graphics.md).
Save as template selects native content only; comments, versions, actors and product metadata
are excluded. The author reviews sample content and chooses text/image/list slots in the UI.

## Public integration

`@editor-platform/templates` is headless. `@editor-platform/template-ui` exports
`TemplateGallery`, `TemplateInputForm`, `TemplatePreview` and `SaveTemplateDialog`
with its own stylesheet. The independent `template-host.html` entry combines these
public contracts without importing Playground App/state. Its deterministic agent
client lives in `apps/playground/src/template-agent.ts`, outside Editor packages.

```ts
import {
  TemplateCatalog,
  builtinCatalog,
  LocalCatalog,
  prepareInstantiation,
  applyInstantiation,
} from '@editor-platform/templates';
import { IndexedDBStorage } from '@editor-platform/artifact-core';

const personal = new LocalCatalog('my-template-catalog');
const catalog = new TemplateCatalog([builtinCatalog(), personal]);
const definition = await catalog.describe('slide-comparison', 1);
const prepared = await prepareInstantiation(definition, definition.sample, requestId);
// Preview prepared.artifact.draft.content using TemplatePreview before accepting.
const result = await applyInstantiation(prepared, storage, hostAllowsCreation);
```

`storage` is a Host-owned `StorageAdapter<Artifact<NativeContent>>`. Whole creation
requires atomic `putIfAbsent`: return the existing record if the ID already exists;
otherwise insert the entire record in one transaction. Memory/IndexedDB adapters
implement it. A separate get/put pair is insufficient under concurrent requests.
The template fingerprint includes version hash, normalized input and creation
options. The same request returns the stored result; different input for that ID
returns `request-conflict` and never overwrites content. A failed atomic write
leaves the request prepared for retry. Cancel before apply creates no record;
after success, deletion belongs to the Host artifact lifecycle.

For existing content, call `prepareInsertion`/`preparePreset` with a domain snapshot,
identity and explicit target. Local `applyLocalTemplate` checks dependencies before
returning content for one Editor command/Undo entry; a repeated stale apply rejects
without another insertion. Shared `previewSharedTemplate` registers portable assets
and a normal proposal; `applySharedTemplate` uses its authority preview token.
Authority receipts deduplicate retry, including an accepted request whose receipt
was lost. Independent edits survive; changed order, target geometry or reused Data
field definitions require a new preview. UI busy guards suppress double submission.
A Host must enforce authorization at its trusted storage/authority boundary as well
as supplying UI read-only state; these browser demo flags do not implement RBAC.

`CatalogAdapter` exposes list/getVersion/put/archive; an external adapter can replace
local storage. Atomic `putMany` is required for pack import. The Host filters visible
entries and enforces writes, rather than putting organization policy in definitions.
`TemplateCatalog` merges adapters, validates exact versions and rejects conflicting
hashes. Archive affects discovery only. Selection keeps the exact immutable version.

## Definition and portability limits

Schema v1 supports explicit value/text/rich/list/table/chart/asset paths and bounded
repeat prototypes, including page chunking, grid spacing and stable before/after
anchors. It cannot execute scripts or an arbitrary layout program. Inputs return
`TemplateError` diagnostics with slot paths; geometry overflow can also identify a
native target. Optional images are removed when empty. Asset inputs accept portable
image data or manifest IDs, with an 8 MiB encoded-character limit by default; remote
and blob URLs are rejected when saving. Existing fit/crop settings belong to native
image elements. This is deterministic layout validation, not full typography analysis.

Slide/Document/Whiteboard legacy drafts use the existing native migrations. Other
supported v1/v2 domain data remains compatible with its model; unknown schemas and
capabilities reject before writing. A domain migration does not increment the
immutable template version. Published built-in changes require a new template
version. `scripts/build-templates.mjs` materializes reviewed source into the checked-in
`builtins.json`; do not use it to silently rewrite an already published version.

Save as template exposes existing text/image/list targets. New versions are authored
explicitly, including their slots; there is no automatic old-slot migration after
structural edits. Fixed content and user-selected sample values remain in the pack;
no automatic detection of personal information is claimed. Save includes no artifact
history, annotations or actor metadata. A selected fragment includes native required
internal dependencies; unsupported external dependencies fail validation.

Data identity/reference mapping follows its typed schema. Column/row/view/filter/
widget IDs, formulas, relation bindings, view fields and Graph record placement
are remapped on creation/reuse. Timeline date bounds, ordinary cell/default/option
strings, search/filter text and widget titles remain literal values even when equal
to a native ID or stored under a column named `id`, `from`, `to` or `formula`.
Data entity validation uses the same enumeration; it never treats date windows as
connector endpoints. Retained template versions and source content are unchanged.

Presets accept domain-specific fields, never a whole-content merge. Numeric/style
values are validated before apply. Document selection changes marks while preserving
text-engine IDs; page margins require artifact scope. Data formats affect numeric or
formula columns and chart settings affect selected views. Preview reports skipped
Data fields and selection-only Document margin. Review/Viewer `prepareViewPreset` is
async, validates the exact definition and returns private settings only. Their settings
persist in the Host, outside source bytes, revisions and shared content Undo.

## Office-origin native reuse (#16)

PPTX/DOCX imports enter this same catalog and lifecycle after the user confirms the
native preview and addressed losses. Office master/style inheritance and original
Office bytes are not retained by a template. GUI authoring offers existing editable
text, image and line-list targets; an image's incidental text cannot become an
editable text slot. A list input replaces its whole nested list. Advanced rich,
table/chart/repeat bindings remain declared headless capabilities, not automatic
slot inference. Host agents supply structured inputs and use the same prepare API.

When the author replaces a text/list sample, its native prototype is updated too;
old source text/runs/items are not hidden in the saved definition. Fixed content,
labels and deliberately retained default/example values remain the author's
responsibility. The preview reminds authors to review individual case information.
Comments/history/actor/Host data and original Office bytes are not copied from an
Artifact. This is not automatic personal-information detection.

`templateLimits` publishes the reuse budgets: each image data URI has at most
8 MiB encoded characters, with 16 MiB across manifest assets; each definition is
at most 24 MiB UTF-8 JSON; packs are at most 32 MiB UTF-8 JSON / 100 definitions.
Pack export and import both enforce those bounds. Expanded native content has a
64 MiB JSON bound; recursive processing accepts at most 200,000 values and depth 64.
Input fields can lower the image bound, but cannot raise it. Fixed images are
checked as well as slots. Invalid/oversized packs fail before atomic writes.
These checks do not modify published template versions or hashes.

A source accepted by the larger Office input limits can fail template save; the
error is explicit and no catalog entry is written. Existing native artifacts remain
independent of the catalog and can be shared, saved/reloaded and exported by another
Host. Both-domain evidence is tracked in #16 verification.

Slide fragment authoring can pass `slideSelection` addresses (`pageId`, `elementId`) to
`selectTemplateContent` / `saveAsTemplate`. Scoped selection and group expansion stay within
each addressed page, where object IDs are unique. Whole-artifact authoring keeps the whole
content and its reference rejection. Omitted addresses preserve the existing ID-only behavior.
The Slide Surface supplies its active page as the optional third `select` callback argument;
Hosts must retain that value on selection addresses before opening scoped authoring.
