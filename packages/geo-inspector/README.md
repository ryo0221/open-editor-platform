# Geo read-only inspector experiment

Issue #97, shared integration
#76. This is a **bounded readonly local Point map plus native text inspector**, not a completed Geo Editor. The experiment tests an independent native
Geo domain against the existing draft.2 Basic + lifecycle contract without Core changes.
Public API/schema compatibility is provisional. M0/M1/M4 remain open.

**Editing successor:** a separate source-only [Point/scalar editing experiment](src/point-edit/README.md) now provides the second domain slice. The readonly definition and public entry remain unchanged; edit installed-Host adoption and saving remain separate gates.

## Scope and exact sources

- Current Point slice base: accepted #111 `d4da53d9615aba484ed79748d75688e442611bec`.
  Initial inspector used #103; #110 proved both installed readonly Hosts. New map bytes need a fresh #76 package gate.
- Geo domain: only `packages/geo-core/src` copied byte-for-byte from #104
  `aa6a140e4a08d62b6b430040608ce8633c74923b`. Its import/key-join tests remain domain
  regression tests; their presence does not add inspector editing/import UI.
- Latest main checked at implementation: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
  All these Extension/Geo branches are still Draft/unmerged; none is main capability.
- Status correction to the earlier #104 investigation: #101's proposal was approved
  for implementation at **2026-10-12 08:41**, and #103 provides the initial type handoff.
  It is no longer accurate to label that experiment generally unapproved. Geo uses
  unchanged numeric-schema draft.2, not the new controlled or Video tagged-schema facade.
  This approval is not production Host, storage/authentication or release acceptance.

## Design: separate native meaning and readonly presentation

`GeoDocument.schemaVersion` is the actual number **1**. `artifactKind: geo` is admitted
separately from content validation. Geo keeps layer/feature/row/field IDs, nullable
geometry, typed scalar values, CRS84 longitude/latitude in degrees, and source snapshots.
It never substitutes Graph x/y, a universal scene model or renderer objects.

Normal operations are: inspect IDs/coordinates/attributes, expand a feature with keyboard,
select the same stable feature ID from the Point map or native list, and inspect fixed source provenance. Unknown schema, over-budget input and stale/revoked
work are refused. The source snapshot remains unchanged by expansion, focus or cleanup.
There is no input buffer, domain selection command, camera, edit, Undo command or save UI.
Details-open state and the selected layer/feature ID belong solely to the detached Surface. There is no new Host selection API.

`src/index.ts` is the inspector's public **source** boundary. `prepareGeoInspection`
validates before clone/hash and returns a frozen detached capture issued to
`createGeoInspectorSurface`. The latter writes user content using `textContent`, not HTML,
and owns only its DOM. Its label and the prepared object are trusted Host inputs, not an
attestation API. `geoInspectorExtension`/`mountGeoInspector` add draft.2 admission and
lifecycle. Required lifecycle cleanup is registered before reading or async preparation;
revoke removes DOM/listeners immediately while drain observes eventual acquisition and
cleanup. Late work must pass scope and revision checks before insertion and after awaits.

The definition requests **only `artifact:read` and required lifecycle**. It rejects an
unexpected granted edit/save/inputs/resources slot. No generic live-follow/subscribe
capability was added. An idle view is explicitly a **fixed local revision capture**;
known native replacement should cause the Host to revoke/remount. During pending work
or the next click/key event, a changed revision invalidates the old Surface. After `ready`
settles, it is not an ongoing error-notification subscription. The Host owns status,
replacement and observing drain failures. `InspectorTestGates` provide local deterministic
fault synchronization only, not a production resource/Host capability.

Three hashes have different meanings. The Host admits a package pin (raw 64 hex here);
artifact-core `contentHash` computes the captured native canonical JSON hash (also raw
64 hex); source content/byte hashes are **declared stored metadata**, retaining Geo's
`sha256:` prefix. No source bytes are fetched or verified and no output receipt is issued.
The test Host's package pin is synthetic, not an independently verified package archive.
Source resource IDs are text, not clickable retrieval URLs. Every fixture is synthetic.

## Limits and refusal

The actual #103 `Basic.read` copyData boundary is **65,536 UTF-8 JSON bytes, 4,096 visited
nodes and depth 24** (root depth 0). It runs before the native validator and is unchanged.
The Host-supplied native budgets in `test-host/fixture.ts` are test-only, not deployment
or performance guarantees. Both boundaries apply. The default source-free synthetic fixture contains three Points (two coincident), a null and a LineString. The earlier three-feature metadata fixture remains a regression case.

Unit tests check exact byte/node boundaries, including a multibyte string, and depth-25
refusal. The latter deliberately invalid nested shape never becomes valid Geo. A browser
oversize test displays `DataLimit`, renders no partial content and retains the complete
native object. Larger 200-row and 47-region domain fixtures are not claimed to fit Basic.
No truncation, pagination or looser shared limits is introduced.

## Host and workspace ownership

`test-host` imports the inspector's public source entry plus public package entrypoints
for editor-core/artifact-core/geo-core/extension-runtime. It creates an ordinary local
EditorSession, grants only read, and uses the actual ReferenceRegistry and ManualClock.
It has **no fake or production Storage, Resources, authentication or product backend**.
The synthetic fault controller is Host-only and never passed as an extension capability.
No normal playground Kind/Content/factory/registry or shared Core is patched.

#110 activated `package.json` and proved both installed readonly Hosts; `package.proposed.json`
is historical only. The new Point slice changes no manifest, root lock, pack profile,
shared Host/runtime/contract, Animation or Video. #76 owns rebuilding/admitting the new
package hash and rerunning both installed consumers plus BFCache; old package acceptance
does not certify new map bytes. The local domain Host verifies this slice through the
public source entry. Product Host integration remains NOT RUN.

## Local Point policy and selection

Each layer uses its own fixed 640×320 SVG frame, north up and longitude increasing right.
Point extents must span at most 5° on **both** axes and all Point latitudes must satisfy
`abs(latitude) < 70`. Any violating Point blocks the whole layer map, never just disappears.
Longitude span >180° gets an additional dateline/wide-span diagnostic; no wrap, clipping,
reprojection or native rounding occurs. Null and every non-Point remain in the inspector
with per-feature display diagnostics. Empty or blocked layers have no SVG. These are
provisional display bounds, not geodetic accuracy, native schema or capacity contracts.

Equal degree scale is `min(560/max(lonSpan,0.1),240/max(latSpan,0.1))`; the extra extent is
presentation padding for singleton/coincident locations. It never changes native coordinates.
No distances, areas, routes or globally correct projection are promised. Overlapping IDs
remain distinct Tab targets; Enter/Space or a list button selects the same native ID,
opens its details and highlights its marker. Selecting a null/non-Point clears map highlights.
Selection never changes native JSON/hash/revision/history. All listeners are disposed and
existing scope/revision guards run before interactions. No basemap, tile/network or new dependency.

[Point slice verification](point-map-verification.md) distinguishes local evidence from the
pending owner-installed gate. Current M0–M4 acceptance
retains the original backlog. Point editing and source-free local saving are later approved
steps, gated on this readonly slice review; neither is implemented here.

## Capability and acceptance plan

| Capability / condition              | Declared scope and remaining work                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Viewer (N01–03/N06/N09/N12)         | Bounded Point display + text inspection, pure preparation, real draft.2 readonly/lifecycle; source build                             |
| Local editing/history (N04–05)      | No editing capability in inspector; native/hash/history unchanged by inspection. Core commands tested separately                     |
| Native save/reload/migration (N10)  | No persistence admission. Unknown content schema rejected; durable resources/version import NOT RUN                                  |
| Browser/a11y (N11/C10)              | Chromium desktop/narrow viewport, semantic regions/headings/details/dl, Enter/Space and focus outline; device/screen reader NOT RUN  |
| Verification/documentation (N13–14) | Provisional scope and failures recorded; performance acceptance paused, no measurement                                               |
| C01–08/S01–06                       | No text input/IME, annotation, proposal, collaboration, template/reuse, format UI or React preview capability; no grants/entrypoints |
| C09                                 | No large-asset/recovery/durability claim; fixed Basic limits and explicit refusal                                                    |

Normal Host creation/save/reload (N07) and domain selection notifications (N08) are not
provided by this inspector. N03 is limited to fixed capture/private expansion; committed
version restore is not covered. #110 proved installed text inspection; the new Point slice
currently has source-entry evidence, pending #76 installed-package revalidation. These are not full N01–N14 Editor certification.

Original Geo acceptance is not replaced: UC1 import/edit/style/save/output, UC2 join/legend,
UC3 geometry editing, AC01–AC12 complete end-to-end, M0 geometry/numeric/storage decisions,
M1 integration, optional M2/M3 adoption and M4 evidence/release judgment all remain separate.
Renderer selection, source resource retention, stable persisted contracts and larger read
capacity are unresolved future decisions, not implicitly approved dependencies here.

## Local verification

No new dependency installation is needed beyond `npm ci --ignore-scripts` at the pinned
base. Run from repository root (no root scripts or automatic CI modified):

```sh
npm run lint
npm run typecheck
./node_modules/.bin/vitest run packages/geo-core/src packages/geo-inspector/src packages/extension-runtime/src/draft2
./node_modules/.bin/vite build --config packages/geo-inspector/vite.config.ts
./node_modules/.bin/playwright test --config packages/geo-inspector/playwright.config.ts
```

Playwright uses `/usr/bin/chromium`, production-build preview, desktop 1280×900 and narrow
390×844. Build and screenshots are in `/tmp/geo-inspector-build` and
`/tmp/geo-inspector-evidence`, never Git. See [verification](verification.md) for exact
source, result mapping, failures and limitations. No package publication, merge, release,
CI restart/dispatch or performance measurement is part of this experiment.

The separate experimental `./point-edit` public entry is wired by #76 after corrected
domain review. See installed editing evidence.
Readonly `.` remains unchanged. The separate provisional `./point-save` entry now has
installed local save/reopen evidence;
independent review and production/full-GIS acceptance remain open.
