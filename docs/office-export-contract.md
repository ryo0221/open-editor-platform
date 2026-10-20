# V2.1 output contracts (Issue #9)

The common package `@editor-platform/export-core` owns snapshot basis, diagnostic
addresses, consent, cancellation and injected asset/font contracts. It imports only
`artifact-core`. It has no persistent layout/content model or Office encoder.
`@editor-platform/slide-export` owns Slide preflight and its temporary drawing plan;
Document will use a separate package and flow plan under #12.

## Public capture and preparation

```ts
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  type SlidePptxEncoder,
} from '@editor-platform/slide-export';

// The Host first checks its trusted export permission and ordinary editor guard.
const snapshot = await captureSlideExportSnapshot(session.confirmed.content, {
  kind: 'confirmed',
  artifactId: session.confirmed.artifactId,
  revision: session.confirmed.revision,
});
const plan = await prepareSlidePptx(
  snapshot,
  {
    pageIds: 'all',
    includeHiddenSlides: false,
    includeNotes: false,
    fontProfileId: 'host-verified-profile',
    fallback: 'reject',
  },
  hostAdapters,
  abortController.signal,
);
```

Capture clones/freezes both content and basis synchronously before hashing. It accepts
local-draft, confirmed revision and saved-version bases. Preparation independently
owns caller input/options before its first await, checks native schema and the
captured content hash, and snapshots the injected adapter functions. Later edits,
remote revisions, input arrays, resolved image buffers or font-manifest changes
cannot change a prepared plan. Capture is read-only: it does not save a version,
execute a command, change Undo or submit a shared operation. It is not authorization.
The normal editor guard/IME lifecycle is integrated separately under #11/#13.

The only public plan property is a deeply frozen JSON report. Private owned data
is associated with the exact handle through a WeakMap. Cloning a report/handle does
not create an encoding capability. Resolved image bytes are copied into private
storage, never frozen typed arrays or references owned by the adapter. Encoders
must consume that storage without resolving a URL again.

`SlidePptxEncoder` fixes the next-stage encode signature: opaque plan, current
`ExportConsent`, optional AbortSignal, and an ok/blocked/cancelled/failed result.
Success returns Uint8Array bytes, MIME and report, independent of Node Buffer,
window, downloads and encoder library types. The actual encoder arrives in #10;
Issue #9 alone does not generate a PPTX or add a product export menu.

## Report, consent and asset responsibilities

Reports contain schema/exporter version, basis, plan hash, selected source-order
pages, deterministic diagnostic IDs, domain addresses, effect/severity, original
object mapping and native/approximation/PNG/omitted counts. Group containers have
mappings but do not double-count their children. Output part names are empty before
encoding and populated by the encoder. Document addresses use block/item/cell/
paragraph fields without requiring a slide ID.

The plan hash covers captured basis/content hash, options, complete font manifest,
resolved image hashes and dimensions, drawing plan and machine diagnostic fields.
Localized messages do not define diagnostic IDs. All current required warning IDs
must be explicitly accepted with that exact plan hash; unknown/old warning IDs and
any error block output. Selecting element-PNG is not consent by itself. A fresh
capture/preflight invalidates old consent when its inputs differ. A remote update
after capture does not mutate the existing plan.

The injected image resolver owns URL policy, credentials and actual image decoding.
It must reject broken/undecodable sources and return verified dimensions. The common
boundary additionally copies bytes and checks signatures, MIME, PNG header dimensions
and the 16 MiB/image, 32 million decoded pixels/image and 64 MiB total limits. Header
checks alone are not an image decoder. Raster adapters receive isolated inputs and
must render the requested element faithfully; the product browser/Node adapters
and golden raster evidence are subsequent implementation work. Missing/failed image
resolution cannot be bypassed by a fallback setting.

The Node adapter isolates native image decoding in a child process. Its public
`OfficeImageDecodeError.diagnostics` distinguishes input rejection, conversion failure,
startup failure, external termination, the unchanged 10-second deadline and output
overflow. It includes input SHA-256/size/MIME/dimensions, operation, actual exit code
and signal, elapsed diagnostic time, output size and at most 4,096 stderr characters.
It never includes image bytes. Deadline/abort/overflow termination waits for child
close and removes timers/listeners before rejecting. Abort remains AbortError.
These observations identify new failures; they do not establish the cause of earlier
I07 failures without their original exit/input evidence. See the
[diagnostic verification](verification/issues-38-261/README.md).

Font profiles provide a fixed family/version/license, Regular/Bold SHA-256s and
verified glyph coverage; a profile is referenced, not embedded. Missing glyphs block,
substitution/unverified rendering requires consent, and recipients' font requirements
remain informational. Synthetic contract-test profiles make no real glyph claims.

Abort before/during preparation rejects with AbortError. Ordinary input, limits,
missing adapter/font/asset and unsupported-element failures are structured report
errors. The encoder's cancellation result never includes partial bytes.

## Drawing and scope

`layoutDrawingText` in `editor-core` supplies the same fitted font size, wrapped rich
runs, padding, line height and origins used by existing SVG text primitives. Slide
plans reuse `slidePaintOrder` and `slideDrawing`. Stored Slide coordinates are already
world coordinates: parent group offsets are never added again. No schema, published
template version or shared protocol migration is introduced.

The 25-shape atlas classifies 13 native candidates and 12 explicit minimum-element
PNG fallbacks/rejections. Preset contour differences are reported as approximation.
Charts and Slide merged tables require element fallback. Simple tables retain native
logical cells and fixed row/column geometry; overflowing native cells block with an
address rather than creating another slide. Hidden elements/pages and excluded notes
are reported. Native images retain original crop/fit/rotation/flip inputs for #10.
Office shape contours, image crop and table rendering still require the external
application checks in #10/#11; these contracts alone do not certify fidelity.

The declared caps remain 100 slides, 10,000 objects and 100–3840 CSS px per page side.
Plan tests cover boundaries and invalid selections. Existing pure/public entrypoints
bundle in Node and browsers with no React, DOM view or Office encoder dependency.
The independent browser contract also captures Document through the common API.

See ADR 004/005, golden requirements, and the #9 verification record. PowerPoint/Word and full Office roundtrip are not certified by these APIs.
