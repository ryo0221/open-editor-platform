# Bounded local image editing

Design's opt-in `rasterInput` edits the owned embedded PNG of a selected image.
It uses the existing image `src`, native commands, local history and artifact
versions. There is no second raster document, catalog or history. Existing
manuscripts and committed versions remain unchanged until an explicit edit.

The ordinary Playground enables this for local Design documents. Other Hosts
must opt in; shared editing is not supported. The pixel editor provides a fixed
width brush, alpha eraser, zoom, and a rectangular source-pixel selection. Each
completed stroke is one native command. Cancellation discards the preview;
unfinished gestures block save and AI handoff through the normal input guard.
Read-only, locked/hidden ancestors, linked images, stale content, malformed PNG,
and replacement size changes are rejected at the command boundary.

Admission limits are static embedded PNG, 4 MiB, 2048 pixels per dimension,
4,194,304 pixels, and 4096 pointer samples per stroke. Brush widths are 1–64 px.
PNG chunk CRCs and browser decoding are checked. These limits are functional
bounds, not a measured performance guarantee. JPEG, APNG, pressure, textured
brushes, freeform masks and shared raster operations are outside this increment.

The Host owns AI generation and transport. `window.playgroundInk.read()` returns
the current document, exact local revision, and a selected image rectangle.
`proposeRaster` accepts one data-only `raster-region` operation, decodes it outside
the document, copies only the selected rectangle into the current PNG, and
previews a native transaction. Pixels outside the rectangle remain intact. The
Host rechecks artifact identity, revision, pending inputs and permissions after
decoding and on adoption. A proposal never directly mutates the draft. Existing
image provenance is retained and marked as edited. Automatic AI service calls
and authentication are not included.

Any native group or owned PNG can be edited within those bounds. The platform
does not prescribe character parts, a fixed layer count, or a generation schema.
Raster pixels remain raster pixels; semantic parts and brush strokes are not
recovered. A consuming Host can provide its own optional preset without changing
the Design content model.

See [Playground operations](playground-inking.md) and
[verification](verification/design-local-editing/README.md). Functional checks
are separate from visual artwork acceptance and physical-device testing.
