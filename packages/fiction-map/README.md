# Fiction Map model and local Surface

Import `@editor-platform/fiction-map/model`. This entrypoint implements the local, headless native v1 contract. Its runtime import graph has no React, DOM, Canvas, Geo, Design, CAD, Worker or Host runtime dependency. The separate `/surface` entrypoint uses existing React/Canvas UI. Neither entrypoint registers an Editor or supplies storage, authorization or shared history.

## Native and limits

`FictionMapContent` has required `kind:'fiction-map'`, `schemaVersion:1`, one `coordinateSpace`, one `precision`, `layers`, `features` and `namedViews`. Public types include `FictionMapCoordinateSpace`, `FictionMapPrecision`, `FictionMapFeature`, `FictionMapLayer`, `FictionMapNamedView`, `FictionMapGeometry`, `FictionMapPoint`, `FictionMapBounds`, `FictionMapId`, `FictionMapChange`, `FictionMapBase`, `PreparedFictionMapChange`, `FictionMapPermission`, `FictionMapMetadataPatch`, `FictionMapImportOptions`, `FictionMapIdRemap`, `FictionMapResult`, `FictionMapDiagnostic`, `FictionMapCode` and `FictionMapLimits`.

Geometries are lowercase `point`, `polyline`, or explicitly closed single-outer `polygon`. A place is a point, path a polyline, region a polygon; landform accepts all three. Polygon holes/Multi/curves/shared topology are unsupported. Polygon duplicate vertices, zero area, crossing, self-contact and edge backtracking are rejected using public `geometry-core/planar`. Polyline revisits/crossings are allowed; consecutive duplicate points are rejected. Features may overlap each other. Both Polygon windings remain unchanged.

Each ID scope is unique independently. Feature layer references and named-view visible layer references must resolve exactly. Names/geometry/order changes preserve IDs. World entity references are opaque, nonunique metadata; external resolution/permissions/version pins remain with the Host. Coordinates such as x=180/y=90 have no Geo/CRS84 meaning.

All objects are closed records. Optional means absent; explicit undefined/null is rejected. Input uses plain own enumerable data properties and dense arrays. Accessors, hidden/symbol keys, cycles, coercion and functions are rejected. Repeated object references are copied per occurrence. Strings retain case/Unicode form, reject unpaired surrogates and C0 controls (description permits TAB/LF/CR). IDs/ref strings are 1–512 UTF-16 units; names 1–128, unit name 1–32, description 0–4096, category 0–64. Nonempty fields cannot contain whitespace alone. Style supports optional hex RGB color, positive CSS-pixel lineWidth through 64, and boolean label; no runtime rendering behavior is implemented here.

`fictionMapLimits` is frozen. Inclusive guards:

| Boundary                               | Limit                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| Every coordinate/bounds/view axis      | ±2²⁰; points and saved views also stay inside document bounds                           |
| Polygon                                | 64 non-closing / 65 raw points                                                          |
| Polyline                               | 64 raw/logical points                                                                   |
| Layers / features / named views        | 10 / 200 / 10                                                                           |
| Document logical/raw geometry points   | 1000 / 1200; Polygon closure excluded only from logical count                           |
| Canonical native JSON / raw UTF-8 JSON | 65,536 bytes each; keys, punctuation, metadata, refs and views count                    |
| Native containers/values               | Depth 6 (root=1), 20,000 total container/primitive occurrences                          |
| Change request                         | 262,144 canonical UTF-8 bytes, depth 8, 40,000 values, 400 create/update/delete entries |
| Affected feature IDs                   | 400, union of old/new document IDs; candidate still at most 200                         |
| One admission pass                     | 31,020 vertex pairs + 31,020 edge pairs = 62,040, at most 1000 edges                    |
| Append source + candidate              | Two passes / 124,080 pairs; each pass independently bounded                             |

These are functional resource guards, not measured latency, heap or UI guarantees. The independent planar library ceiling of 1000 per ring never increases the Fiction Map ring limit.

## Admission and codec

- `createFictionMap()` returns an owned frozen empty native with bounds [0,0]..[1024,1024], yAxis down, unit name map-unit and precision d=A=0. Readers never fill missing fields.
- `validateFictionMap(unknown)` returns `FictionMapResult<FictionMapContent>`. It copies and freezes a private snapshot; input never becomes canonical by reference.
- `parseFictionMap(string | Uint8Array)` checks raw UTF-8 size, syntax, depth/value bounds and duplicate object keys **before JSON.parse**. Key identity uses decoded JSON escapes: `"name"` and `"\u006eame"` collide in the same object. BOM/invalid UTF-8 are rejected.
- `serializeFictionMap(unknown)` returns `FictionMapResult<string>` with Artifact Core canonical JSON. Encode the string as UTF-8 for files. Signed zero serializes as zero; field order is canonical, array order is preserved. Unknown values are admitted first.

Expected input/domain failures return `{ok:false,diagnostic}`. Success is `{ok:true,value}`. Diagnostics contain stable code/source/JSON Pointer path and optional indices via the planar cause, ID, limit and actual. Only the first diagnostic is returned. Structure/budgets precede reference/coordinate/domain checks, then deep geometry and precision. Polygon diagnostic order remains the public planar order: adjacent duplicate, repeated vertex, all-collinear zero area, ascending edge pairs. A symmetric bow-tie has self-crossing before algebraic area zero. Exceptions for programmer invariants/OOM/arbitrary Proxy execution are not disguised as invalid geometry.

## Exact numeric and geometry APIs

No epsilon or implicit quantization is applied. Document precision always supplies nonnegative finite `minEdgeLength` and `minPolygonArea`, both defaulting explicitly to 0. Positive values add inclusive Euclidean length/absolute area thresholds in map units/unit²; topology still rejects zero edges/degenerate rings. Domain-private dyadic BigInt helpers compare squared lengths and shoelace area exactly for represented binary64, including subnormals. Values lost before the call cannot be recovered. Optional physical conversion is metadata only; metric display/overflow formatting belongs to D2.

- `validateFictionMapGeometry(unknown, precision, bounds)` admits/freeze-owns a standalone geometry and returns Result. Use this for geometry that did not come from native admission.
- `isFictionMapPointNear(a,b,radius)` returns Result<boolean> for explicit finite nonnegative map-unit radius, including equality. Near does not merge or mutate points.
- `snapFictionMapPoint(point,precision,bounds)` requires an explicit snapGrid: step is a power of two in [2⁻²⁰,2²⁰], fixed origin (0,0), common axes. Exact quotient rounding uses ties-to-even. It returns a point candidate or snap-out-of-bounds; it never clamps or makes all native points implicitly grid-bound.
- `hitTestFictionMapGeometry(ownedGeometry,point,radius)` returns Result<boolean>. Polygon hit is interior union closed Euclidean boundary band: radius 0 includes both interior and boundary. Polyline uses segment distance, Point a closed disk. Concave empty AABB areas remain empty. Query coordinates are within the hard plane bound but may lie outside document bounds. The geometry must come from native/standalone admission; a caller-frozen clone is not a certificate. Query is at most 64 edges and does not revalidate the ring.
- `translateFictionMapGeometry(ownedGeometry,dx,dy,precision,bounds)` returns a fully validated geometry candidate. Binary64 addition constructs each coordinate once. A nonzero delta lost at any point, out-of-range coordinate or invalid result rejects the entire geometry.

D2 must map camera/y-axis/CSS-pixel widths to per-geometry world query radii, preserve native IDs/paint order and apply visibility/permission filters. Pure hits do not certify actual SVG interaction. MVP AABB marquee/selection frames remain an explicit limit; `onSelect(ids)` cannot reconstruct the query rectangle. No common Canvas changes or precise marquee adapter are supplied.

## Commands and one local history

A `FictionMapChange` may create/update/delete features, supply the final complete featureOrder, layers or namedViews arrays, or replace coordinateSpace/precision. Update is a complete existing-feature replacement with stable ID. ID sets cannot overlap; no nested batch/partial success exists. Layer deletion and all feature/view reference updates are one final-state transaction. A profile/bounds/y-axis change revalidates all affected geometries; metadata-only changes reuse the immutable base geometry proof.

High-level constructors return Result<Change>, never execute or own history: `createFeature`, `updateFeatureMetadata`, `deleteFeatures`, `moveFeaturesToLayer`, `translateFeatures`, `replaceGeometry`, `replaceLayers`, `replaceNamedViews`, `setCoordinateSpace`, `setPrecision`. Metadata patches use set/clear; clear cannot remove name or overlap set. Style set replaces its entire object. Constructors preserve unrelated fields. Changes remain candidates until prepare; translate constructor performs cheap coordinate construction and prepare performs deep geometry validation once.

```ts
import { EditorSession } from '@editor-platform/editor-core';
import {
  createFictionMap,
  prepareFictionMapChange,
  commitFictionMapChange,
  undoFictionMap,
} from '@editor-platform/fiction-map/model';

const content = createFictionMap();
const session = new EditorSession(content);
const base = { content, revision: session.revision };
const candidate = prepareFictionMapChange(base, {
  layers: [{ id: 'l', name: 'Places', purpose: 'settlement', visibleByDefault: true }],
  create: [
    {
      id: 'p',
      layerId: 'l',
      name: 'Town',
      featureKind: 'place',
      geometry: { type: 'point', coordinates: [180, 90] },
    },
  ],
});
if (!candidate.ok) throw new Error(candidate.diagnostic.code);
// A real Host supplies the current trusted policy; this example is single-user local.
const result = commitFictionMapChange(session, candidate.value, () => true);
if (!result.ok) throw new Error(result.diagnostic.code);
const nextBase = result.value; // Feed owned result directly into the next prepare.
const undone = undoFictionMap(session, () => true);
```

`base.content` must be the owned snapshot returned by create/validate/parse/commit/Undo/Redo. A plain `session.content` copy or caller Object.freeze is not an admission certificate: validate it once when adopting a genuinely external current snapshot, pin its revision, then retain the owned returned base. Do not admit the entire map on pointermove or every React render. Successful commit/history results include content/revision/changed and can be used directly as the next base.

`prepareFictionMapChange(base, unknown)` privately copies the request and revision, validates the final candidate and returns an opaque, frozen `PreparedFictionMapChange`. `previewFictionMapChange(prepared)` returns its immutable native candidate without granting authorization. There are no writable proof fields, serialized tokens or publicly constructible certificates.

`prepareFictionMapImport(base, source, options)` uses `{mode:'replace'}` or `{mode:'append',remap?}`. Replace preserves source IDs; append requires canonically identical coordinateSpace and precision, admits source references independently and appends in source order. Explicit remap has optional layers/features/namedViews arrays of `{from,to}`; absent entries mean identity. Rewrite internal references atomically, preserve World refs, reject missing/duplicate from, colliding final to or attempts to bind invalid source refs to existing target layers. Import has no automatic ID generation or unit transform.

`commitFictionMapChange(session, prepared, canEdit)` uses a synchronous trusted boolean permission gate, sessionId+sequence and canonical base/policy equality, then repeats current checks and final capacity/reference checks inside `immutableCommand.apply`. Gate functions must be synchronous and side-effect-free; reentrant native updates are detected and preserved rather than rolled back. The gate can be called twice on a normal commit. A normal change executes once, a canonical no-op never executes/clears Redo, and both consume the Prepared. Reuse/concurrent use is rejected. Permission denial and stale/failed publication leave native, all history and revision unchanged; no rollback command is executed. Programmer errors propagate.

`undoFictionMap(session,canEdit)` / `redoFictionMap(session,canEdit)` use existing peekHistory and synchronous validation callbacks. Unrecognized history candidates receive admission; known frozen candidates reuse their certificate. Candidate-owned precision is restored with native. Permission/validation failure does not pop history. No second history stack exists. Do not send remote/shared changes through this local Session.

## Verification scope

Unit fixtures cover B1–B4, represented-value independent Fraction oracle cases, headless packaged imports and guard mutations. See the D1 verification record for exact source, executed commands, failures and unrun scope. Browser UI, camera/CSS paint consistency, touch/OS IME, Host persistence/version/reference integration and performance acceptance are separate D2/D3 work. This package makes no Geo compatibility or public release claim beyond leaving those implementations unchanged.

## Local Canvas Surface (D2)

Import `FictionMapSurface` / `FictionMapSurfaceProps` from `@editor-platform/fiction-map/surface` and import `@editor-platform/fiction-map/styles.css`. Provide the owned `base`, a synchronous `onCommit(prepared)` that calls D1 against the Host's current Session/live permission, and optional `onUndo`, `onRedo`, `canUndo`, `canRedo`. Adopt every successful Result as the next controlled base. `readOnly` / `lockedFeatureIds` restrict UI operations; they do not replace trusted Host checks.

The Surface defaults to conservative display-only label decluttering, prioritizing selected labels. Its “Avoid label overlap” toggle reveals all labels when disabled. This does not change native geometry, history or static export policy; labels with no free candidate are omitted, with the feature list as an alternative.

Optional `selected` + `onSelectionChange` and `view` + `onViewChange` control ephemeral state; omit a pair for local ownership. `createId` optionally replaces public `newId`. Selection, camera and local visibility do not change native/history. Style the viewport with `--fm-viewport-height` (default 560px desktop / 420px narrow). No Playground CSS or store is needed.

The Surface provides Point/Polyline/Polygon creation, move/nudge, separate PathHandles vertices, metadata/Point coordinate Inspector, layers/local visibility, labels, overlap choices, deletion and one Host-owned Undo/Redo. Object resize/rotate are disabled. SVG painting handles normal clicks; pure queries map actual camera/y-axis/CSS widths for overlap candidates. Marquee/frames remain AABBs, explicitly labelled. Canvas generic snap/grid are disabled; no implicit domain snapping/repair is performed.

The Surface contract specifies rendering/input/cancellation, supported edits and limitations. `npm run fiction-map:build` then `npm run fiction-map:preview` starts the dedicated independent local Host, without registering Fiction Map in Playground/Artifact Host. That fixture isolates local interaction; normal Playground/Artifact Host integration is now implemented separately below. See D2 verification for source, failures, screenshots and NOT RUN.

## D3 Host, saved images and references

- `/host`: `adoptFictionMapBase`, `fictionMapHostAdapter`, `parseFictionMapArtifact`, `verifyFictionMapArtifact`. Admission validates a private owned snapshot and pins/rereads the same Session revision and canonical content. It does not create a Session. Envelope input has a separate 16 MiB / depth 16 / 1,000,000 value guard; every draft/version still obeys the native 64 KiB contract. Decoded duplicate JSON keys and retained version hash mismatches reject the entire envelope.
- `/artifact-surface`: `FictionMapArtifactSurface` accepts an existing public `ArtifactEditor<FictionMapContent>`. The Playground wrapper uses its existing per-Artifact EditorSession. D1 commands and validated Undo/Redo use that same history through the structural `FictionMapSession` port. ArtifactEditor exposes `peekHistory` and optional synchronous history candidate validation; existing consumers can omit it.
- `/native-input`: `FictionMapNativeInput` stages a bounded native content file, calls public prepared import and preview, and explicitly commits through the same supplied live Host callback. It registers a pending-input boundary, refuses other dirty/composing inputs, and retains stale/permission/resource checks. No Artifact identity or second history is created. Candidate IDs are producer-owned; replacement can remove absent IDs.
- `/saved-views`: `FictionMapSavedViews` creates or edits explicit native extents/layer IDs; starts from document bounds/default layers, pins an owned base on first input, and commits through the existing D1 prepare/commit boundary. Editing keeps the view ID and is one Undoable command. It does not save private camera or local layer overrides.
- `/render`: `renderFictionMapSvg`, `FictionMapRenderOptions`, `FictionMapOutputView`, `FictionMapSvg`, `FictionMapRenderError`. Pure SVG uses admitted native, document bounds or `{kind:'named',id}`, ordered layers/features, labels and native styles. No Surface DOM is captured.
- `/image-export`: `exportFictionMapPng` rasterizes that SVG with the existing Canvas export foundation. Supply `isCurrent` and optionally `signal` to reject stale completion. Same source/renderer/font environment is deterministic; cross-platform PNG bytes are not guaranteed.
- `/output-panel`: `FictionMapOutputPanel` selects immutable saved versions only. Generic Host draft image export is deliberately unsupported (`formats:[]`); native JSON export remains supported. SVG/PNG panels never fall back to current draft.
- `/world-panel`: `FictionMapWorldPanel` and optional `FictionMapWorldHost` display consuming-Host resolution diagnostics. `checkAccess` runs before/after resolution; notifications invalidate visible labels. The normal Hosts have no World service and say so. This is not a World database or authorization engine.

Images require integer dimensions 1..4096 per axis, at most 16,777,216 pixels and at most 2 MiB SVG. Background defaults to opaque white; `transparent` or explicit hex RGB is supported. Uniform projection centers the fixed extent with letterboxing, clips to that extent and honors y-up/down. Projection overflow or projected coordinate magnitude above 2²⁴ rejects with `unprojectable-view`; native validity alone does not imply every output view is projectable. Stroke widths and labels are output pixels, using a fixed system font stack; Point radius is 7 pixels. These are bounded output rules, not performance guarantees.

`@editor-platform/reference-adapters` exports `fictionMapReferenceAdapter`. Targets use `fiction-map-document` / viewId `document`, or `fiction-map-view` / the exact named view ID, with optional unique `featureIds` (1..200). Feature IDs are not node IDs. References are fixed-only, with exact Artifact/version/hash snapshots; no implicit draft/latest fallback. Permission failures remove pixels; offline may show a verified snapshot with a warning. Missing targets never rebind to a different ID.

Dirty Inspector/layer/view inputs, composition and unfinished drawings reject save/version/export/switch until explicit Apply/Finish or Cancel. Preview never becomes native automatically. See the D3 Host contract and D3 verification for connected entrances, failure boundaries and NOT RUN.

## Restore and D4 acceptance

There is no `ArtifactEditor.restore` method. A consuming Host uses the existing public composition, preserving one history:

```ts
const saved = editor.readSaved(versionId);
editor.importContent(saved.content);
```

Admission, current permission and registered input boundaries still apply; the old version is not rewritten. `undoFictionMap` / `redoFictionMap` validate candidates on the same Session. An ArtifactEditor may throw its existing Host permission/input error before a D1 result callback runs; callers must handle those Host errors as well as unsuccessful model Results. `host-acceptance.test.ts` covers re-open, restore, Undo/Redo, immutable versions and permission rejection.

[User guide](../../docs/fiction-map/user-guide.md) / D4 matrix. D4 now exercises actual Novel/Comic fixed-reference workflows through common-mode insertion and dedicated-mode rendering, plus public-Host feature subsets and failure states. This does not complete native OS IME/device acceptance or real World services.
