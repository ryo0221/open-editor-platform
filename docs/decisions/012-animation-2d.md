# ADR 012: Animation 2D native model and one current Player

Status: implemented for review, 2026-10-20 JST. Scope: Issue #74.

Animation needs hierarchy, time, tracks, resources and exact composition references.
These remain its own native model; Design, Slide and React UI keep their models.

Use schema 2 for new drafts and current authoring. Keep schema 1 readers and an
explicit, single-history migration command. Saved versions and retained snapshots
keep their original bytes and hash. Project validated legacy rectangles privately
into the current evaluator/Player; do not maintain two editing implementations.
The prototype schema/Player remains a compatibility API for its original subset.

Use 240,000 integer ticks/second, rational frame grids, stable element IDs and
T(position) R(rotation) S(scale) T(-anchor). Numeric tracks use hold/linear/cubic
Bézier easing; all Bézier controls are bounded to [0,1]. Colors interpolate in
premultiplied linear sRGB; text tracks are hold-only. Public inputs have typed,
exclusive targets. Motion path position and auto orientation exclude conflicting
tracks. Paths use deterministic segment sampling, without arc-length pacing.

Explicit seek(duration) samples the terminal pose. Playback loops over the
half-open work area. Nested time uses sourceIn + floor(elapsed \* numerator /
denominator); hold samples sourceOut, loop uses [sourceIn,sourceOut), hide omits
the child. This schema 2 terminal rule does not change old prototype semantics.

Pure preparation owns, validates, hashes and freezes a snapshot. Evaluation has no
clock or mutation. One SVG renderer and absolute-clock transport serve Surface,
Slide, Web, registered React UI and static frames. Portable PNG/JPEG/font assets
carry hashes and notices. Browser preparation decodes images/fonts before use;
non-ASCII text requires a pinned font. No implicit network asset resolution.

Exact references retain their own complete, independently valid closure. Validate
hashes, cycles, depth, expansion and resource limits before admission. Rejection
budgets are documented in the capability guide; they are not performance promises.

Use existing EditorSession/EditorInputs locally and SharedEditorSession with an
Animation DomainCodec remotely. Stable-ID field operations and explicit read
conditions support selective Undo. Native canvas ProseMirror steps own shared
text; remote edits never enter local snapshot history. Authority checks permissions,
locks, conditions and final native validity. Playback/selection remain private.

Design conversion is a captured, reviewed static projection through public Design
APIs with ID remapping and provenance. Unsupported geometry refuses conversion.
Slide owns placement and consumer inputs; explicit version adoption changes only
the retained embedding. Nested exact reuse uses published defaults in this subset.
React UI receives a trusted registered Player wrapper, sealed runtime/environment
and retained native JSON; user JSON does not become executable code.

SVG/PNG output captures source/input/tick and requires consent for the exact plan
hash. Resource errors, permission loss and cancellation refuse completion.
Animated Slide PDF/PPTX/static export, generic template/linked fragment adapters,
GIF/video/Lottie and additional editor embeddings remain explicit unsupported
capabilities. They do not silently flatten, drop motion or claim compatibility.

See [capabilities and Host responsibilities](../animation/production-2d-design.md)
and [verification](../verification/issue-74/README.md).
