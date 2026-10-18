# Status and limitations

## Geo workspace

The local Playground registers Geo with immutable versions and native map references.
CSV/GeoJSON preview, atomic Point/Line/simple Polygon editing, map/table selection,
styles/metrics/legends, named views, fixed PNG/Slide output, staged reimport,
asset photographs and version comparisons use native commands and retained resources.
Saved Data joins pin both inputs and require explicit refresh adoption. Slide map
references default to fixed; following newly saved Geo versions is an explicit choice.
See [the Geo guide](../docs/geo-guide.md) for workflows, bounded resources and renderer
limitations. This adds no shared Geo domain, background tiles or geocoding.

## Artifact reference embeds (#264)

Data tables/charts and Profile-backed Graphs can be embedded into local Document,
Slide, Design and Whiteboard. Creation explicitly chooses fixed or follow; only saved
versions are published. Hosts inject permission-aware reads, notifications and source
navigation. Runtime refresh does not mutate destination history; saves/exports capture
one exact revision per source. Missing targets, permission loss, offline caches and stale
responses are distinct states. Native closure/hash validation, static graphic manifests,
and a public-only independent Host are included. Shared references and Office/React
reference export fail closed. Existing static images/charts retain their meaning.
See [contract](artifact-references.md) and [actual checks](verification/issue-264/README.md).
Performance acceptance remains paused; this does not publish an updated extension.

## Design reusable text and graphics (#255–#257)

Design reusable authoring accepts explicit overflow/minFontSize settings down to 10px;
Document/Slide defaults remain 16px. `measureTemplateTextFit` shares insertion preflight.
New instance-aware templates check substituted text and expand instance-owned bounds
when requested; legacy definitions retain their prior layout behavior and hashes.
`makeDesignVector` stores bounded SVG path geometry and source/name/version/license on
native shapes. Existing fill/stroke token styles, mode changes, transactions and
SVG/PNG rendering apply to these icons. SVG fallback typography uses Noto Sans CJK JP;
explicit element/run fonts retain priority. See the [contract](design-reuse-graphics.md)
and [verification](verification/issues-255-257/README.md) for checks and limitations.
An icon catalog, arbitrary SVG markup import and semantic React vector conversion are
outside this scope. Performance measurement/acceptance remains paused.

[PR #258 corrections](verification/issues-255-257/review-258.md) make resized-instance
text expansion follow projected geometry, enforce shape-only vector overrides, keep
foreign vector fields out of Slide/Whiteboard rendering, normalize fractional initial
bounds and show geometry/attribution in version comparisons. Full units and the scoped
desktop/mobile and production browser regressions are recorded separately from the
initial acceptance.

[Additional PR #258 corrections](verification/issues-255-257/additional-review-258.md)
clip paths to their declared view box, keep geometry native-owned, preserve indexed
placement and reject sparse path arrays. Instance-aware templates reject text still
hidden by a fixed clipping frame after expansion; frame geometry stays unchanged.

[SVG follow-up corrections](verification/issues-255-257/serialization-review-258.md)
give each primitive occurrence its own resource ID, preserve native ancestor clipping
when projected IDs collide and restrict path separators to SVG whitespace.
Whiteboard Section/connector labels and Data charts use the common Noto SVG fallback.

[Input/XML corrections](verification/issues-255-257/input-xml-review-258.md) reject
XML-forbidden provenance characters, accept compact arc flags and keep empty text
placeholders unchanged. Projected text diagnostics resolve to their bound input keys,
including nested overrides, singleton templates and duplicate local part IDs.

[Typography/layout corrections](verification/issues-255-257/typography-layout-review-258.md)
include effective line height, rich runs and padding in instance text preflight,
reproject component auto-layout after size overrides and reject non-record/inherited
vector fields that would be lost in native JSON. Legacy textScope behavior stays intact.

## Design frame prototypes (#246)

Optional native interactions and `prototyping` metadata add click/tap navigation,
state switching, back, overlays and named flows to Design. Ordinary Inspector commands
use the existing local/shared execution boundaries. `DesignPrototypeSurface` owns
private navigation/progress and reports completion or anchored-comment requests to Host.
Schema 1/2 without these fields stays unchanged; old readers ignore the new semantics.
The [contract](design-prototype-contract.md) and
[verification report](verification/issue-246/README.md) record actual checks and limits.
Performance acceptance remains paused. No product record storage or publication service
is added.

A [retained-comment retry correction](verification/issue-246/retained-retry.md)
reconciles the original rejected operation through existing proposal ownership.
Unrelated rejected input still blocks Save/Leave; uncertain retry acknowledgements
reuse the same proposal. The report preserves fail-first and follow-up evidence.

An optional numeric AABB tree connects through CanvasStage to Design and Whiteboard;
their exact rotated predicate, native models and public Editor contracts remain
unchanged. Normal Hosts use the existing TS selection path. The independent Host
opts in and verifies fallback/selection. At tested source, 144 related units,
8 desktop/mobile cases and 2 existing canvas cases pass; lint/build/typecheck,
Rust build/unit/clippy and tooling pass. An earlier broad unit filter encountered
six Office timeouts; full-repository acceptance is not claimed. See
[design and build](spatial-wasm-design.md) and
[functional verification](verification/issue-247/README.md) for exact pins and results.
Performance measurement/acceptance remains held and CI stays manual-only.

Graph reading adds optional Inspector visibility, initial/filtered Fit, Host node
sizes, full label names, relation filters, adjacent emphasis and collision-aware
edge labels with Profile line styles. Readonly surfaces show values and viewing
controls. Display state stays outside content/history; validation still uses the
complete graph. [Design](graph-reading-design.md), [embedding](embedding.md) and
[verification](verification/issues-224-228/README.md) define checks and limits.

The audit additions cover Document table navigation/read-only semantics/searchable
Japanese PDF, File text-layer search and confirmed encoding-aware replacement,
Host-resolved Review annotations, Timeline/Dashboard view operations, explicit CSV
scopes and target-schema diagnostics, format-specific Office capabilities, Whiteboard
endpoint overlays, native Design semantics/frame constraints and accessible chart
aggregates. [Scope](issues-53-73-audit.md), [embedding contracts](embedding.md) and
[verification](verification/issues-53-73/README.md) describe tested capabilities and
limits. Tagged PDF/OCR and Code execution are not supplied by the Platform.
The [review follow-up](verification/issues-53-73/pr52-review-followup.md) retains
rejected Design text, inherited formatting, multi-file anchors and image metadata;
fits row-frame children; and corrects overlapping Graph hits and private view history
in the independent Graph Host. Its verification is reported separately.
The next review fixes formula-target CSV mappings and retained inputs before version
restoration. Legacy annotation lookup, File remapping with foreign anchors and PDF
searches above 10,000 hits per page were initially deferred and later corrected.

The [new review triage](verification/issues-53-73/pr52-review-triage.md) corrects six
ordinary paths: shared Form version save, tabbed PDF text, visible Graph routes and
Whiteboard targets, replacement re-decoding and independent definition JSON errors.
New reference Definition edges retain canonical IDs; four older unresolved findings
were already fixed. The latest completion initializes and validates the first-column
Graph label, retrieves saved legacy Review sources, retains File anchors on remap
and marks partial PDF results. Field decimals/widget titles are parent-owned inputs,
Host CSV captures confirmed shared Data, and absolute frames disable child fitting
while allowing fixed resizing. Actual checks and limits are in the triage report.

The preceding eight ordinary-use findings are corrected: Document Markdown/HTML use
flushed canonical/confirmed input, shared-session exit confirms Surface drafts,
Slide add/delete retain refused edits, blurred invalid drafts survive updates,
CSV blocks excess columns and read-only mappings, annotation navigation invalidates
stale source requests, and the independent Host supplies keyboard history.
Concurrent Graph route removal during endpoint dragging and explicit duplicate
component IDs remain excluded rare cases (three unresolved threads).

The preceding selected follow-up fixes collaboration-start input loss, independent Host
Surface-switch/shared-Detach input loss, and image-first publication slot selection.
Invalid/composing or refused input blocks transitions. Local native sessions/history
survive Surface round trips within the Host lifetime; offline shared Detach retains
accepted operations in the existing checkpoint for Attach recovery. Saved versions
remain unchanged. Identical size-preset reapplication on a Hug frame stays a known
constraint with an explicit fixed-size alternative, alongside the two previously
excluded rare conditions. Exact scope and checks are in the triage report.

The preceding ordinary follow-up aligns Document Surface MD/HTML/PDF snapshot capture,
template/reusable authoring input checks and retained source for preview/save, and
Graph connection selection/stamp validation during submit and Host flush. Host text/
CSV/Office capture share the canonical reader; text export rechecks context and new
pending input after confirmation. The separate native publication command correction
checks primitive fields and non-image slot targets without the optional extension.
Partial commit refusal retains accepted native edits and failed/unexecuted buffers;
the registry does not add rollback. Existing known constraints stay unchanged.

The preceding source follow-up fixes Data chart SVG/PNG capture, numeric/boolean
Graph edge labels, PDF indexing-error notices and image-safe Design semantics at
UI/publication/conversion boundaries.
Slide/Whiteboard/Design graphic capture uses refreshed content/scope/settings.
A typed Data reference adapter also fixes
date-range template save/creation and linked view reuse while preserving literal
values, destination records/schema and immutable retained definitions. Local
verification and held scope are recorded in the
[review record](verification/issues-53-73/pr52-review-triage.md).

The current three-comment follow-up unifies blank/preset Slide additions at the
input/acceptance boundary, reads legacy null Data Graph labels without rewriting
drafts or immutable versions, and aligns inherited Canvas typography across local
and shared engine documents, display and native serialization. Selected false
overrides survive peer edits, checkpoints and selective Undo. The existing three
held condition kinds remain outside this scope; current checks are in the triage report.
Common Canvas/SVG output applies decorations per run so partial removals remain visible.

The snapshot includes the native Document, Data, Review, File Viewer, Whiteboard,
Design and Slide domains; Office export and bounded import; templates, linked reuse
and tokens; registered React UI; the declared Design/React bridge; and local native
Structured Graph with Data Grid/Form/Graph integration and external Adapter contracts.
The Graph reference Host uses fictional public source data. Real Workflow integration
is consuming-side work. Graph shared/annotation/template/reuse/format-export capabilities
are unavailable. The [Graph verification record](verification/open-issue-3/README.md)
separates source functional checks from unrun environments and public snapshot checks.
[Additional review fixes](verification/open-issue-3/review-40-followup.md) cover hidden
Definition children, asynchronous import, explicit read-only field settings, strict
Data layout and its comparison, and row-specific shared position transactions.
Concurrent row deletions retain the existing row-order precondition.
[Further review fixes](verification/open-issue-3/review-40-followup-2.md) enforce
new-row protected defaults, map arbitrary Data column IDs, seed bounded native nodes,
align proposal diagnostics and honor whole-Profile read-only UI state.
[Latest review fixes](verification/open-issue-3/review-40-followup-3.md) restore verified
saved Data versions, retain native hidden attributes, deduplicate projected select
options, gate file metadata before reading, bound derived Definition edge IDs and
explicitly refuse unresolved references while retaining original source export.

Source usability updates add endpoint gestures and obstacle-avoiding routes, owned
Profile definition migration, pending-input save boundaries, in-place Canvas text
with fitted line boxes, separate input/document Undo, native React publication
settings, adjacent Slide copies and Whiteboard body search.
[Scope and Host APIs](issues-42-51-usability.md) and the
[source verification record](verification/issues-42-51/README.md) describe the
tested subset. Native OS IME, other engines/real devices and consuming Host trials
remain separate. Fixed/derived Profiles and unsupported shared publication commands
display their owning Host and non-editable reason.

The shared-editing reference stores its authority in memory. Production authentication,
durable storage, organization policy and deployment scale are Host responsibilities.
React implementations/build/isolated preview and runtime execution remain Host-owned.
Office interchange reports bounded format losses and does not promise arbitrary
roundtrip fidelity. Design/React regeneration uses declared semantics and explicit
conflict checks, with reference-Host cross-artifact limits.

The retained source performance baseline has three unmet 100 ms browser gates;
formal acceptance remains held and further performance measurement/tuning is paused.
Exporting this snapshot does not change that status. Historical internal issue numbers
in technical contracts describe implementation context, not issues in this repository.

Verification of a public snapshot is reported on its synchronization PR. A source
check, public-tree check, Office rendering, full browser regression and performance
acceptance are distinct results. No consuming-product trial is asserted here.
