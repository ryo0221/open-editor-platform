# Point/scalar editing domain experiment

Authorized second slice of #97 after accepted #113 readonly domain and #114 installed map.
Scope: source-free local Point → stable-ID selection → longitude/latitude + **one** typed
scalar → atomic Apply/Cancel → existing Core Undo/Redo. **No Save capability.** This source
module is not added to the readonly package public entry or manifest. #76 owns future public
packaging/Host wiring; this PR only provides a package-local domain conformance fixture.

## API and ownership

- `model.ts`: `PointTarget`, target-pinned `PointDraft`, `draftFor`, `preparePointEdit`.
  Preparation is pure. One existing `geoEditorCommand` holds replaceGeometry + setAttribute;
  `applyGeoCommand` owns clone/validation/atomicity. No new transaction/history implementation.
- `buffer.ts`: one `PointInputBuffer` implements existing `AtomicSurfaceInputs<GeoDocument>`.
  Target layer/feature/field and base revision remain pinned while pending/composing. Preparation
  does not clear state; only successful committed/no-op callback or explicit Cancel does.
- `surface.ts`: `createGeoPointEditorSurface(document, editor, prepare, history)` consumes the
  existing controlled controller and domain preparation/history ports. Owns DOM, private selection
  and input buffers only. No raw session, extra Undo, source retrieval or storage backend.
- `definition.ts`: distinct `example.geo-point-editor` definition, optional edit/Inputs + required
  lifecycle, read/edit requests only; no save/resource request. `pointEditPort` is the UI/non-UI
  preparation/execution and source-free history boundary. Trusted Host supplies **existing public**
  `createControlledSurfaceController` via factory injection; no runtime implementation is copied.
- Missing edit or Inputs gives readonly fields/history. Post-open grant loss revokes the entire
  scope; a new readonly open is explicit. Scope cleanup is registered before factory/DOM work.
  Aborted input registration belongs to runtime teardown, avoiding a second revoked unregister.

The immutable accepted readonly definition, its permissions and public entry remain unchanged.
Source files are provisional domain APIs, not a new shared contract or stable package export.
No new third-party dependency or root/manifest/lock/Core/shared Host change is needed here.

## Declared profile and refusal

The source document must have no SourceSnapshot and no feature sourceRef for edits/history.
A target must be a Point in a layer that passes the accepted local display rule: both Point
spans ≤5°, every Point latitude has absolute value <70°. The **result** must pass the same
rule; out-of-map moves are rejected atomically by the common preparation/execution path.
Null/Line/Polygon/Multi may remain in the document but cannot be edited by this slice. IDs,
field schema, other features/attributes and unsupported geometry stay unchanged. Source-bearing
native documents can be inspected read-only; this is not complete source-backed editing.
The Host must provide a source-free scoped history for this profile, not attach unrelated
pre-existing product history and claim it was verified.

All non-UI draft values enter as `unknown`. Before semantic reads, trim/Number, spread,
clone or command construction, `draft-boundary.ts` checks exact root/target/revision shapes
through own property descriptors. Only ordinary Object.prototype records with enumerable
data properties and required primitive types are accepted. Accessors, arrays (including sparse),
hidden/unknown/symbol/prototype-hook keys and custom/null prototypes are refused, without
calling getters or coercion hooks. The boundary creates detached frozen root/target/revision
records and subsequent preparation/command construction uses only those fixed values.
Like the existing geo-core guard, this is not a sandbox for Proxy traps or modified intrinsics.

The **provisional input profile** separately bounds each numeric string to 128 UTF-16 code
units, scalar text to 4096 units, and the complete owned draft JSON to 8192 UTF-8 bytes
(including metadata and JSON escaping). IDs use the existing 128-unit Geo ID rule. Length/type
checks precede JSON byte counting, trim and Number; only already bounded owned records are
serialized for the byte check. Numeric strings that collapse to a small finite number still
must fit the raw-input bound. Oversize UI buffers are retained and refused, never truncated.
These are test-profile parsing-work limits, not permanent production capacity contracts;
existing native and controlled-view budgets are unchanged and still apply after preparation.

Numeric input is explicit finite decimal/exponent syntax: blank, whitespace-only, NaN/Infinity,
hex, junk, out-of-range coordinates and invalid numeric scalar are rejected. String values
remain literal text, booleans accept `true`/`false`, null uses an explicit checkbox; null is
not zero or empty string. Exactly one existing field is edited, never a schema rewrite.
Pure preparation and execution both validate. The proposed controlled snapshot is checked
against pinned draft.2 65536-byte / 4096-node / depth24 limits before commit, including envelope
metadata; this is stricter than checking native bytes alone. No shared limit is relaxed or
production scale promised. The fixture is deliberately small.

Dirty input or **any** active/ended composition blocks target/field switching and other canonical
operations until Apply/Cancel. An empty cancelled IME session remains pending. Cancel while
composing is refused; after composition ends explicit Cancel rebinds the original target's
current snapshot. Replacement form generations remove listeners and ignore retired callbacks,
so a late composition/input event cannot land on another selected feature. Stale revision or
invalid input preserves buffers; failed apply never clears them. A validated no-op returns
`command: null`, preserves revision and Redo, then clears the pending group via committed callback.
Native IME on real OS/device remains NOT RUN; synthetic composition is not that certification.

## Dependency and evidence boundary

Domain base #113 `b384f1a7ac8691f7dedef127d3e1ff60b6d7abf0`; shared contracts/runtime remain
accepted #111 `d4da53d9615aba484ed79748d75688e442611bec`. Parent reports #114
`89a047313c244e18e2f284fa7ee7e13c2294e022` independent installed-map acceptance; **that is the
next shared adoption base**, not a reason to rewrite domain APIs or retroactively certify edits.

`test-host/edit-fixture.ts` supplies a local synthetic EditorSession/Inputs, existing actual
ReferenceRegistry/controller, and test-only recovery settings (discard, no retained checkpoint
codec). These are harness details, not production storage policy or an independent installed
Host integration. Browser entry `/edit.html` is added only to the package-local test Vite build.
No save backend, new export format, shared conformance consumer or package public export is added.

[Author evidence](verification.md) records exact source, functional failures/fixes and limitations.
Readonly #113 regression/BFCache remains separate from editable installed/navigation acceptance.
Source-free saving starts only after this edit gate and remains unimplemented here. M0/M4 and
original full UC/FR/AC requirements remain open.

## Explicit retained-source profile (follow-up, exact-pin integration only)

The omitted-profile behavior is unchanged: every source-bearing document is refused.
`profile.ts` adds a **trusted Host configuration**, not a document flag or new shared
capability. `GeoPointEditProfile` has `kind: 'retained-source-closure'` and synchronous
`check(content, intent: 'edit' | 'history'): boolean`; only literal `true` authorizes.
The callback receives a detached frozen native copy. Host verifies the exact original
resource/version/hash closure and current scope. For `history`, it must also guarantee
originals for **every reachable Undo/Redo state**, not just the supplied current native.
Host must revoke/invalidate a scope if it cannot maintain that invariant. Async proof
work must finish before opening/authorizing this synchronous profile.

Optional parameters preserve existing callers and the existing capacity callback position.
The profile follows that callback; it does not replace or bypass capacity admission:

- `preparePointEdit(snapshot, draft, current, budgets, checkCapacity?, profile?)`
- `pointEditPort(context, editor, budgets, checkCapacity?, profile?)`
- `createGeoPointEditorSurface(document, editor, prepare, history, profile?)`
- `geoPointEditorDefinition(pin, budgets, factory, observe?, checkCapacity?, profileForOpen?)`, where
  `profileForOpen(context)` creates the profile for that **opened binding**. Do not
  reuse another artifact's closure merely because one definition is installed.

The command captures exact source snapshots and feature/row/source-ref identity.
Native validation, fresh authority/revision, local Point range and scalar/input/view
budgets still apply. Preparation and apply check the closure; changed source pins or
refs refuse before mutation. Geometry and scalar use the existing single Geo batch.
Undo/Redo use the existing controller after the separate history check. Every Host
history entry point needs equivalent closure guarantees; no second history is added.

Imported null/Multi/line/polygon records remain preserved and read-only in this Point
editor. The profile does not grant arbitrary geometry editing or source refresh.
Original bytes, excluded-row records, source manifests, durable versions, atomic IDB
records and reopen are Host-owned. The domain neither writes nor strips them. No
new package/shared API/manifest/schema/Storage/budget contract is established here.

The `/source-edit.html` package fixture uses a real bounded partial CSV import and
synthetic verified originals in memory. It is not durable Save/restart acceptance.
Host handoff
was sent before implementation; adoption needs this follow-up's exact reviewed pin.
