# Local CSV/GeoJSON import workbench — domain slice

Private local-file preparation → explicit mapping/axis/type policy → diagnostics/counts → explicit
all/partial commit through existing createGeoImporter + geoEditorCommand + controlled controller.
No stable package export/shared contract, new dependency, storage or history implementation.

The UI reads the user-selected File only after the Host source-byte size check. UTF-8 parsing,
coordinate/shape/type validation and immutable preview sealing stay in geo-core. Every property/
column must be mapped under the existing importer contract. Mapping is manual, not guessed.
Format and CSV axis/null-coordinate policy are explicit. GeoJSON remains CRS84 lon/lat only.
No automatic repair/CRS conversion/geocoding. Scalar field IDs stay fixed during mapping preparation;
internal feature/row IDs are assigned once per sealed preview. Names are not identities.

A changed file/mapping invalidates and releases the preview. Cancel/revoke invalidates late work.
Partial consent applies only to the shown problem rows; confirmation rechecks exact exclusions,
source bytes/pin and fresh revision/authority. Applied import is one native command/Undo. All
original source refs remain. Rejected rows/reasons are listed after partial commit. Source-backed
editing/save is explicitly unavailable: there is no stripping source metadata to reuse source-free
save. Null and unsupported-edit geometries are preserved by the existing import validator.

`ImportWorkbenchHost` is a private integration seam, not a proposed shared API. #76 supplies
trusted current authority, source pin identity and commit/retention through existing public
controller and Storage boundaries. `commit` must return refused with native/history unchanged,
or applied after holding exact originals; it must not throw/report failure after native commit.
Admission must preflight the complete Basic/controller/native budgets before committing.
Do not treat the UI's File object or importer registry as durable storage/retention.

The package-local `/import.html` test Host starts an ordinary existing EditorSession and registry.
It uses a bounded ephemeral source manifest registry and holds copied originals until scope close,
including Undo/Redo. Manifest pins are canonical hashes of explicit synthetic source manifests;
no production immutable ArtifactVersion/closure guarantee. No Save grant/Storage is installed.
Map/table read the imported native layer; Point local-frame restrictions remain explicit.
This harness does not validate #76 installed source adoption or durable original retention.

Test-only budgets: source100000 bytes; parser201 records (CSV header counts as a record) to allow
200 data rows; feature counter400 accommodates candidates plus accepted features in the existing preview envelope (it counts both arrays). This is not a400-row file promise. Pending plans1,
columns16 and staged manifests10. These are functional test policies, not deployment/performance
budgets. Existing installed source-free Host100-feature /64KiB profile is a separate constraint.

Minimum retention recommendation and decision request
uses the actual accepted #123 Host Storage boundary; #125 same-kit/source-free saving is already
accepted. #129 linked table continues to #76 installed adoption. This branch stacks the import UI
on that table domain source; neither standalone PR counts as the complete M1 workflow.

Review correction — preparation ownership: the private `source` callback now takes a per-prepare
AbortSignal and returns `{source, release}`. Cancel, mapping/file change, prepare failure and scope
disposal abort that operation and release its preparation lease; a late returned lease is released
without replacing the current one. Successful commit releases preparation **after** Host adoption;
committed original bytes are retained separately for native/Undo/Redo and are not deleted by that
release. No shared Save/Storage contract changes.

The volatile test Host reserves a monotonic source ID and one of ten preparation slots before
its first await, checks reservation ownership after each await, and never derives identity from
Map.size. Abort/failure/release removes only that exact reservation; a completed cancelled digest
cannot publish or overwrite another stage. Failed IDs are not reused. Adoption has a separate
ten-original bound and remains scope-local. Hashing itself is not cancellable; its late results
are ignored and do not reacquire the released preparation slot. Scope close releases stages and
originals; this is still not durable retention.

Each mapping's Remove handler is retired exactly once, clears its DOM handler and checks removed /
closed / current index before mutation. A saved callback or detached element cannot invalidate
another mapping's preview; disposal also retires remaining handlers.
