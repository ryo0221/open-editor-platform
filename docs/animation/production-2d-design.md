# Animation 2D: capabilities and Host integration

This is the current schema 2 contract for Issue #74. The earlier
[rectangle connection](playground-slide-integration.md) and
[layer-action verification](../verification/issue-74/layer-actions.md) retain their
original scope and evidence. [ADR 012](../decisions/012-animation-2d.md) records the
time/model/compatibility decisions; [verification](../verification/issue-74/README.md)
records tested source, results, failures and untested environments.

## Editing and compatibility

New Animation drafts use schema 2. The normal Playground and independent Host use
one current Surface and Player. Legacy drafts offer a preview and explicit
migration transaction; Undo restores the draft. Saved legacy versions and exact
retained bytes/hash remain unchanged. A validated legacy embedding is projected
privately for playback. Legacy public entrypoints retain their original subset;
new features use the current entrypoints below.

| Capability             | Current subset                                                                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers                 | Rectangles, M/L/Q/C/Z vector paths, rich text, PNG/JPEG, group and composition hierarchy; transform, lifetime, visibility, lock, vector clips and mask-only layers                                                                                                           |
| Time and tracks        | 240,000 integer ticks/s; rational frame grids; number/color/text tracks; hold/linear/cubic Bézier graph; text hold-only; no overshooting easing controls                                                                                                                     |
| Authoring              | Stage move with private preview/cancel; layer selection, duplicate/delete/reorder/group/nest; bounded unnest; multiple key move/copy/paste/delete; frame snap, zoom/scroll, work area and playback rate                                                                      |
| Motion                 | Line/Bezier motion path and optional orientation; explicit conflict rejection for position/rotation ownership; no path morph or arc-length pacing                                                                                                                            |
| Inputs                 | Declared text/color/number inputs; private preview and explicit saved defaults; exclusive track/input ownership; invalid/composing/stale buffers block capture                                                                                                               |
| Text/resources         | Native canvas text engine and shared ProseMirror steps; non-ASCII text without a pinned font shows in the system font as a provisional display, and static export requires the pinned font; retained resource metadata/license notices; actual decode before playback/export |
| Exact reuse            | Saved composition catalog, complete retained closure, explicit insert/adopt; nested instances use published input defaults; old source versions remain immutable                                                                                                             |
| Shared                 | Ordinary editor command/text preparation, authority-checked stable-ID operations, selective Undo, pending/reconnect/duplicate handling and permission revocation/expiry                                                                                                      |
| Design conversion      | Saved resolved frame capture, supported rectangle/polygon/Bezier/text/image/group/clip projection, fresh IDs and provenance; reviewed static losses; unsupported semantics refuse                                                                                            |
| Slide                  | Exact source version/hash/snapshot, placement/fit/poster/playback and typed consumer inputs; preview/adopt/Undo; source navigation and retained playback without a source catalog                                                                                            |
| Web / React            | Common Player without Playground CSS/store; trusted registered React UI component and independent production export bundle with pinned source/environment/runtime                                                                                                            |
| Output                 | Validated native JSON and self-contained retained resources; exact-plan static SVG/PNG with loss consent and notices                                                                                                                                                         |
| Explicitly unsupported | Generic whole/fragment/template and linked-definition Animation adapters; animated Slide SVG/PNG/PDF/PPTX; GIF/video/Lottie; 3D/audio/NLE; automatic embedding into Design/Document/Whiteboard                                                                               |

Unnest accepts an unretimed local composition with identity placement, hold-after
mapping and a single owner. Loop/hide mappings and more general cases refuse
instead of approximating pose/time. Existing
tracked properties show their base value as disabled; edit their keyframe rather
than silently changing the whole animation. Vector coordinate editing is provided
in the Inspector; this subset does not provide freehand drawing handles.
Paint-order controls move a selected sibling subtree as one block, preserving its
internal order and parent identities, including groups stored after their children.

Design conversion uses public resolved Design data through `animation-adapters`;
no Design native/view/template changes are required. Auto-layout, constraints and
component behavior become static geometry and are diagnosed. Ellipses, rounded
corners, arrowheads, shape-label text, unsupported paths/crop/dash/effects,
React/Web/interactive or retained reusable content refuse rather than silently
become rectangles or screenshots. A source edit after preview never changes the
captured plan. Accept uses the same capture, one native command and existing Undo.
Provenance retains opaque original Design IDs (bounded to 2,000 characters per
mapping source ID); generated Animation IDs retain their native grammar. Repeated
images with the same content hash and media type share one captured asset.
Repeated adoption also reuses equivalent target assets when hash, media type and
both notice fields match, remapping image/font layer references on an owned copy
of the capture. Distinct notices retain distinct assets.
Image capture requires resolved `imageFit: 'fit'`; an omitted resolved fit has
Design's cropped fill semantics and refuses with the same diagnostic as explicit fill.
Multiple selected roots use their union as the capture viewport; selected enclosing
frames retain their own bounds, and non-frame roots include their rotated bounds.

Player/static export prepare only assets referenced by the selected composition's
recursive local/exact closure, including future/invisible layers. Independent
compositions and unused retained providers keep their bytes but are not decoded.
Deleting an image reclaims its owned asset after the complete command batch only
when no remaining native composition references it; same-batch reuse and native
Undo retain ownership. Uploaded fonts and immutable retained snapshots are preserved.
Repeated image/font uploads reuse an owned asset only when hash, media type,
attribution and license all match. Distinct notices keep separate records.

Exact composition adoption and layer deletion remove unused source providers from
the current draft after the complete action batch. Providers required by other layers and their
immutable nested snapshots remain; native Undo retains the previous draft.
Direct insertion/adoption also reuses a provider already present inside a retained
closure, preserving that immutable provider instead of appending duplicate bytes.
Slide adoption carries consumer overrides only when the input ID and declared kind
remain compatible; the candidate also validates their values and bounds.
Slide controls and new consumer writes include only the selected composition and
its recursive local-composition closure. Exact nested sources keep their published
defaults. Inspecting historical pins leaves their snapshots and inputs unchanged;
explicit edits/adoption prepare the scoped consumer values through native history.
An embed's root artifact/version identity participates in the same hash-consistency
check as all retained sources. Player, Slide and exact-source insertion therefore
admit the same exact version identities.
Slide also applies one aggregate identity registry to every Animation object on
every page, including each recursively retained source. Independently valid embeds
cannot name contradictory hashes for the same immutable artifact/version.

## Public APIs and Host responsibilities

- `@editor-platform/animation-core/v2`: native types/readers, preparation/evaluation,
  commands, migration, exact references and playable embedding validation.
- `@editor-platform/animation-player/v2`: resource preparation, deterministic SVG,
  absolute-clock Player and sealed static frame plans/exports.
- `@editor-platform/animation/v2`: controlled `AnimationSurface2`.
  `@editor-platform/animation/host` supplies the current/legacy migration wrapper;
  `@editor-platform/animation/player-v2` supplies the thin React Player.
- `@editor-platform/animation-adapters` and `/design-ui`: pure captured conversion
  and the saved Design review panel. Collaboration uses the existing public
  collaboration adapters and sessions.

The Host supplies authoritative content, permissions, commands/history, aggregate
EditorInputs, native text bridge, exact saved catalog and persistence. Flush all
inputs before reading the authoritative snapshot for save/export. Shared capture
requires confirmed content and no rejected operation or pending proposal. Pass
`beforeCapture`/`canExport` to the Surface; recheck permission after async resource
work. `readOnly` UI alone is not authorization. Independent consumers should use
validated prepared sources, error callbacks and dispose/abort on unmount.
The saved catalog prepares one immutable snapshot per saved version; its
composition wrappers share that snapshot through `createPreparedAnimationEmbed2`.
The prepared token is checked, and complete wrapper/native JSON limits, source
hash, selected composition and label checks still apply. The Playground memoizes
this derivation only after durable saved records change, excluding optimistic
writes and ordinary draft or view updates.

Selection, playhead, panels, rates, zoom, work area and private input overrides are
view state. Playback does not create drafts, versions, shared operations or Undo. Shared element/native-text presence follows stable
layer IDs through Nest/Unnest; the completed patch determines target deletion.
Visibility change and reduced-motion changes stop automatic playback; explicit
controls remain available. Font faces, bitmaps, rAF and listeners are released.
Registered Web/React output forwards the retained `on-enter` trigger to the common
Player; `manual` remains paused until explicit play. Motion/visibility policy still
belongs to the common Player, without an export-specific clock.
Initial autoplay and React's deferred `autoPlay()` use the mounted stage's owning
document/window, including portals into another document. Private input updates
evaluate and serialize the candidate frame before committing inputs and replacing
the frame; a refused update retains the prior inputs and usable Player. React
input-only prop changes use that setter without resetting the playhead or playing
state. Inputs arriving during resource preparation are reconciled after attachment;
a newer usable input can recover a refused mount. React seek controls catch refused
output frames, retain the original diagnostic and disable the disposed Player's
controls without an uncaught browser exception.
Player/transport validate `initialTick` and draw that requested frame on mount.
React numeric poster ticks and the editor's live playhead are supplied before
resource preparation; live playback updates do not restart the mount lifecycle.
The reusable React Player fills its Host container, including short Slide objects;
standalone previews provide their own height. Locked layers protect their recursive
parent/clip dependencies, including tracks and public inputs on those dependencies.
New layer identities cannot be placed above protected layers in their composition;
atomic insertion below the protected stack remains valid. The final-state policy
applies to native commands and authority wire patches. Moving an existing stable
layer ID between compositions requires both source and destination grants, in
addition to the affected existing layer/ancestor grants. Native text steps use
the same before/after ancestor policy as domain field patches; text-engine versions,
preconditions and selective inverse steps keep their existing ownership.
The root composition pointer is protected while the old root or its reachable local compositions contain a locked
layer. Locked key easing controls cannot start a private draft, and stage movement
refuses positions owned by a public input, matching the Inspector's ownership.
Locked composition instances also protect their recursive local source compositions and
used assets; retained exact sources keep their immutable owning snapshot. A local
instance that renders locked child content is a cross-composition parent dependency:
its transform, visibility, lifetime/time mapping, source and parent/clip/track/input
dependencies are protected through reverse local references. Other unlocked layers
inside that child composition remain editable. Shared
native text steps pass the same final-content protection as domain patches.
Shared command preparation sequences required font assignments/assets before
their native text replacements and defers font removal/other metadata until text
no longer needs the old state. These remain ordered actions in one atomic
authority operation, with ordinary actor Undo/Redo and per-action validation.
When one command changes text and its base fill/size/line height together, native
replacement steps run in the matching old and new style contexts. The preparation
uses an empty native document between those contexts inside the atomic operation;
it publishes no intermediate content. This preserves inherited styles and explicit
run overrides in both directions, including selective Undo after peer edits.
Each phase derives its projection and versions from the actual native text engine.
Canvas text-edit state belongs to its composition and stable layer ID. If an
external change removes or relocates that owner, the editor closes its unavailable
target and stage interaction remains usable. Live text conflicts retain the native
buffer and its existing stale-input guard.
Layer-order operations authorize every layer in the validated permutation as well
as the composition; composition-only grants do not permit those layer edits.
Shared patches derive targets from both validated states in
`collaboration-adapters/src/animation-targets.ts`. Group/world transform and active
state changes require grants for affected descendants, clip dependents and native
local-composition children; matching track edits use the same rule. Rename-only
metadata does not require descendant grants, and retained exact sources keep their
separate immutable ownership. Declared wire targets cannot reduce this derived set.
Lock/unlock changes require grants for the native same-composition subtree whose
lock is inherited. That ownership walk is separate from clip/local rendering dependencies.
Repeated duration actions use the current state of their action batch, keeping
end-aligned layers consistent with sequential commands and native Undo.
The evaluator exposes native layer poses for the selected composition, including
groups/composition containers. Stage drag retains a selected ancestor of the hit
child and converts world deltas using the evaluated parent matrix.
`animation/src/scene2/stage-drag.ts` prepares the shared native patches for preview
and commit; preview uses the same evaluator so child and clip worlds remain consistent.

Comments/annotations UI remains unavailable for Animation in the reference Host.
Its Comments entrypoint and inspector use the same exclusion; native anchor support
is outside this capability set. Normal artifact activation closes the inspector.

The implementation keeps these review boundaries separate: schema ownership in
`animation-core/src/scene2/validate.ts`, local/exact resolution in
`source-resolution.ts`, graph expansion in `expansion.ts`, hierarchy queries in
`hierarchy.ts` and the shared local/authority lock policy in `protection.ts`.
`collaboration-adapters/src/animation-command.ts` owns the ordered native text/style/font
preparation. Existing public entrypoints delegate to these modules; validation,
expansion and hash checks retain their order and none is optional.

Slide contains poster-output refusal at the affected object. A valid native embed
that exceeds the independent SVG limit keeps its exact bytes and shows an
unavailable-poster placeholder with the reason in its description. The source
chooser reports the error and disables placement/adoption for that preview. The
underlying Player still rejects the oversized output; the deck remains usable.
Poster generation reuses the inspected schema-2 prepared token. Slide retains a
poster result only for a platform-deep-frozen embed identity; mutable inputs are
revalidated and cannot reuse stale output after a change.

The reference React adapter is in `apps/animation-reference/src/react-registration.ts`.
It registers retained native JSON as component data against a sealed trusted
wrapper/runtime. After saving an Animation native file, run:

```sh
node scripts/animation-react-export-host.mjs /absolute/path/saved-animation.json
```

The registered React reference subset accepts at most 3 MiB of UTF-8 serialized
embedding JSON and must also fit the existing React UI 4 MiB document limit
(including JSON escaping/metadata). The native Player admits its separate larger
snapshot limit. Oversized registered captures refuse before preview/export;
the trusted runtime checks the same UTF-8 limit before parsing direct/imported
native props. Prop string-length validation alone is not byte admission.
1.6 MiB base64-expanded resources are covered. The environment and component pin
include the trusted Player's complete bundled dependency closure, regenerated by
both Vite and the independent export builder. Source changes in the viewer,
transport, validation or resource code invalidate the runtime pin.

The returned `work/` directory contains the generated React composition, trusted
runtime bundle, HTML/CSS and handoff metadata. Serve it with an ordinary static
HTTP server. It needs no Playground store, CSS, source catalog or external font
URL. This is a reference Host build, not a general dynamic component installation
service. Only the chosen saved snapshot and its closure are distributed.
Directory identity covers all emitted relative paths and bytes, including CSS,
generated files and handoff metadata. Reuse requires complete file equality;
bundler paths are relative to the owned staging root for deterministic output.

## Evaluation and refusal limits

Transform order is T(position) R(rotation) S(scale) T(-anchor). Clips use evaluated
world geometry. Numeric interpolation, premultiplied linear-sRGB color, deterministic
path sampling, discrete text and typed inputs are shared by every consumer.
Explicit seek(duration) samples the final pose; ordinary looping is half-open.
Shortening a composition clears a work area whose end exceeds the new duration;
the controls and Player then use the same full new range. This private playback
range is not restored by native content Undo.
Nested hold samples sourceOut at/after trim, loop uses [sourceIn,sourceOut), hide
omits the child. Rate mapping uses integer arithmetic and fractional fps has an
exact frame grid. The older prototype's out-1 rule remains unchanged.

Limits refuse input/output; they are not performance acceptance: 1,000 layers per
composition, 100 compositions per native node, 20,000 total keys, nesting depth 16,
100 retained source records, 20,000 expanded layers, 512 commands/path and 20,000
raw path commands across retained sources. Expanded path commands and text code
units are each bounded to 200,000. Evaluated overrides also obey the text bound.
Expanded serialized path data and text-run markup share a 4 Mi code-unit budget
(half the SVG serialization budget). Admission, evaluation and output share pure
path/text serialization, including normalized rich runs and nested multiplicity;
declared text variants and private evaluated values obey this budget. The
independent final SVG bound still applies to combined resources, clips and geometry.
Clip/parent chains are cycle-checked, at most depth 32 and 32 expanded clip references per local layer; expanded compositions have a conservative 32,768 clip-reference budget, including intermediate layers and nested multiplicities. This bounds repeated SVG wrappers before the independent serialization limit. Each resource is at most 2 MiB
of decoded bytes, aggregate resources 4 MiB and decoded image pixels 32 Mi.
Owning JSON has 8M string code units / 32 MiB encoded JSON and 500k nodes.
PNG output is limited to 16 Mi pixels, checked before resource decoding or canvas allocation; larger scenes may still export SVG. SVG serialization is bounded to 8 Mi code units and deduplicates image/clip defs.

Embedding snapshots are at most 8 MiB; Slide additionally admits at most 16
Animation objects and 8 MiB aggregate complete embed JSON bytes, including consumer
inputs, labels and source references. The ordinary Host's native
import limit is 16 MB; shared protocol limits can be smaller (notably large asset
operations). Every applicable gate must pass. Missing/hash-mismatched resources,
open dependency closures, stale/locked commands and unsupported formats refuse.
No content URL triggers a network request and no user expression is executed.

SVG/PNG consent applies to one captured source hash, composition, tick and typed
input snapshot. Later edits do not alter that output. Native retains motion;
static frames explicitly lose motion and editable timeline. PDF/PPTX/animated
Slide output currently refuses. An SVG/PNG export here does not certify Office
animation, Lottie or video compatibility.
PNG rounds each composition dimension up to an integer pixel and scales the full
captured SVG into those exact raster dimensions. The 16 Mi pixel gate uses this
rounded area before resource preparation or canvas allocation.

SVG metadata and PNG UTF-8 iTXt metadata retain the captured provenance and the
attribution/license notices of resources used in that frame.
Metadata JSON uses ASCII escapes before XML embedding; JSON readers recover
opaque identifiers exactly, including noncharacters and astral characters.
Provenance includes source references, element-to-layer mappings and reviewed
losses, grouped by each evaluated native owner's hash; repeated local/exact
instances do not duplicate the same owner's records.
