# geo-core (experimental M0)

Private pure TypeScript geographic contract prototype. Not a registered editor, a stable public API or a production storage format. See contract and current limits and acceptance evidence.

Import through `src/index.ts` for this independent experiment. Core has no package dependencies, DOM, HTTP or map engine. `geoEditorCommand` structurally implements the existing EditorCommand contract and uses its local Undo; it does not create a separate history. Caller supplies current trusted revision, edit authority and explicit budgets. Source/resource hashes are declarations pending Host verification.

The second M0 slice adds bounded UTF-8 CSV/GeoJSON preparation and an in-process sealed-preview registry. `createGeoImporter` retains original source bytes for explicit confirmation; its digest scopes and limits are provisional and do not certify durable resource closure. See import verification for exact tested scope.

The third M0 slice adds frozen native input capture and a deterministic read-only key join. It preserves both input pins/column namespaces and blocks disallowed duplicate/type/missing-field cases. It adds no command, source refresh, history or external resource resolver. Subsequent work prioritizes Extension/independent Host readiness.

The data export candidate adds bounded
GeoJSON and JSON-scalar CSV preparation, explicit losses and a version/source
receipt with output-byte SHA-256. Confirmation requires live Host authorization
before and after hashing; the Host verifies native hashes and required resources.
This is an experimental exchange format, separate from native saving and PNG.
