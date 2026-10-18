# Internal spatial candidate search (#247)

This is a functional Rust/Wasm experiment, not a performance acceptance. Performance
measurement and tuning remain paused, CI remains manual-only, and main merge is
outside this task. No improvement in speed or memory use is claimed.

## Code investigation and selected boundary

| Existing processing                                                               | Data and call site                                                                                                                                                            | Decision                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CanvasStage marquee selection                                                     | `targets: CanvasTarget[]`; one scan on pointer-up, not every pointer-move. Design supplies paint-ordered root elements; Whiteboard supplies sections and paint-ordered nodes. | Adopt candidate lookup here; preserve native IDs, input order, hidden/locked filtering and the existing exact rotated-box predicate.                        |
| Compound text-part point lookup                                                   | CanvasStage double-click scans one object's `textParts` in reverse order.                                                                                                     | Keep existing TS behavior; a scene-wide index would change scoped/topmost semantics. Point queries are supported and function-tested in the numeric module. |
| Snapping/alignment/resize                                                         | editor-core geometry and domain command/preview paths; uses geometry and hierarchy on pointer updates.                                                                        | Exclude: not the same spatial predicate, also affects commands and read dependencies.                                                                       |
| Graph routing/labels                                                              | Graph-specific paths, obstacle constraints and measured SVG glyphs.                                                                                                           | Exclude from this small experiment.                                                                                                                         |
| Rendering, SVG shape/path hits, Design clipping/component parts, Whiteboard ports | Domain- or browser-owned geometry and paint semantics.                                                                                                                        | Exclude. Bounding-box candidates are not exact shape/path hits.                                                                                             |

Current arrays are document-dependent: this repository has no single guaranteed
scene size or high-frequency point-hit loop shared by both Editors. The functional
fixtures exercise 2,048 mixed rectangles and the explicit 100,000-item numeric
limit. These are coverage workloads, not observed production workloads or measured
performance. Geometry above the limit retains the original CanvasStage scan.

## Implementation and compatibility

`@editor-platform/spatial-index` is a private workspace module. Its structural TS
boundary accepts only numeric bounds and returns input ordinals. Existing public
Editor/CanvasStage props, Extension Contracts and native schemas are unchanged.
No universal document/shape model, serialized index or second selection/Undo stack
is introduced. Design and Whiteboard continue projecting their own native content.

The default CanvasStage keeps its original TS scan and rotated predicate; it does
not pack or build an index. The numeric module also supplies an inclusive TS AABB
scan as its fallback oracle. An experimental Host can call
`initializeSpatialWasm` from the module's `/experimental` entry before mounting.
Normal Hosts do not fetch an asset, require Rust or enable Wasm automatically.
The verification Host uses only public package entrypoints and its own CSS.
Experimental activation is scoped to the loaded module/browser realm, not an
individual Surface. Other CanvasStage consumers in the same realm may also use
the chosen backend; only Design/Whiteboard Wasm integration is accepted by this
verification. Per-Host backend isolation would need a later contract decision.

Wasm builds a balanced bounding-volume tree over AABBs. Queries visit intersecting
branches and return sorted original ordinals, including edge contact and zero-area
point queries. CanvasSpatialQuery computes a conservative rotated hull, with a
roundoff margin, then applies the existing `intersectsRotated` TS predicate to the
candidates. Hidden and locked objects stay excluded. This is rectangle hit-testing,
not an implementation of GIS, animation, media codecs or exact SVG path geometry.

## Transfer, ownership and errors

- A snapshot is four Float64 values per object: min x/y and max x/y. Coordinates,
  sums and dimensions must be finite; dimensions may be zero, never negative.
  At most 100,000 objects (3,200,000 input bytes) cross the boundary per index.
  Domain IDs, JSON, text and drawing content stay in TS.
- TS keeps its numeric snapshot for fallback. The adapter allocates a temporary
  Wasm input buffer, copies once, builds the native index, then frees the temporary
  buffer in `finally`. Rust owns the tree and its rectangle copy.
- A query passes four numbers and returns a count and a Uint32 result pointer.
  The adapter copies results to a JS array immediately. Views are recreated after
  allocations/queries because memory growth can invalidate earlier buffers.
  No Wasm pointer or borrowed typed-array view escapes the module.
- Each index has an idempotent `dispose`; handles are freed on replacement and
  CanvasStage unmount. Input arrays are immutable snapshots, matching the existing
  Editor content/props contract. The adapter caches only while the target array
  identity is unchanged. Camera and selection are private UI state.
- Wasm linear memory is capped at 64 MiB. Freeing allocations allows reuse; it
  does not shrink WebAssembly memory pages. After a trap the factory retires the
  instance and releases the active factory reference; existing wrappers fall back,
  and no further indexes are built in it. Older retired instances cannot disable
  a newer initialization.
  Partial allocations inside a trapped build may survive until its instance is
  garbage-collected. This experiment does not promise native leak recovery after
  allocator aborts or OS OOM.
- Missing WebAssembly, loader rejection, invalid bytes, imports or ABI mismatch
  return `false` from initialization and keep future indexes on TS. A newer
  initialization/reset supersedes an older pending request. Existing handles own
  their instance until disposed; resetting chooses the backend for new snapshots.
- Runtime trap, allocation refusal or malformed result counts/order retire the
  affected backend and answer the same query using the retained TS snapshot.
  Invalid numeric caller input consistently throws RangeError before crossing
  the ABI. Oversize/unsupported Canvas projections use the original domain scan.

The supplied Wasm asset is trusted build output. A type/version check is not a
sandbox for accepting arbitrary uploaded Wasm. There is no content-driven loader,
imports, worker or external service. Artifact permissions and commands remain at
their existing Host/authority boundaries.

## Build and distribution

Use rustup-managed Cargo and install Rust 1.90.0 with `wasm32-unknown-unknown` once. The pinned crate has no
third-party Rust dependencies; Cargo.lock is retained. After setup:

```sh
npm ci
npm run spatial:build
npm run spatial:test
npm run build
npx playwright test --config playwright.spatial.production.config.ts
```

Both root-command Cargo invocations explicitly select `cargo +1.90.0`, independently
of the active default toolchain. Keep this aligned with the crate toolchain file;
`--manifest-path` alone does not select that file from the repository root.
Cargo builds offline/locked. `spatial:build` emits
`work/spatial-wasm/spatial.wasm`; the target tree and binary stay outside Git.
`spatial:test` rebuilds it, runs the Rust tests, then requires real Wasm for the
targeted TS tests. Plain `npm test` runs TS/fallback tests without Rust; actual
Wasm cases are explicitly skipped when the optional artifact is absent. Normal
`npm run build` does not invoke Cargo or depend on this artifact.

The existing SDK remains a source workspace snapshot, not a published compiled
npm distribution. For an experimental consuming Host, build the reviewed crate,
copy the emitted binary to a Host-owned immutable asset location, pin its checksum,
serve with `application/wasm`, retain the [Rust standard-library notices](third-party/rust-wasm.md),
and pass its bytes through the experimental loader.
Bundling/deployment and asset policy belong to that Host. The verification fixture
serves the real binary through a test route. No binary, base64 build or download
of executable code is added to normal Playground startup. The crate is original
repository code; distribution follows the applicable source license and notices.
The generated binary links the toolchain standard
library. Rust compiler executables are not shipped with the SDK.

## Proposed measurement after explicit resumption

No benchmark is executed in this change. This plan is a decision proposal, not an
accepted performance budget. Resume measurement only after a separate decision.

Use identical immutable scene fixtures of 50/500/5,000/50,000/100,000 objects,
including clustered/overlapping and sparse layouts, negative coordinates, varied
sizes, locked/hidden objects and rotations. Fix both candidate density and query
sequences; include broad marquees, small/empty marquees and point queries. Replay
the actual Design/Whiteboard projection → packing/build → query → exact TS hit →
selection path, including rebuilds after geometry/content changes.

Pin commit, Wasm checksum, Rust/Node/browser versions, hardware, OS and power mode.
Compare TS/Wasm on Chromium desktop and an actual lower-powered mobile device;
other engines and CSP/offline restrictions need their own functional checks.
Separate cold initialization (fetch/compile/instantiate), fresh index build, warm
query, result copying/narrow phase and total gesture-to-selection time. Include
transfer costs and peak/retained JS and Wasm memory across replacements/unmounts.
Use 5 warm-ups and 30 runs per workload, report median/p95 and every failed run;
never compare native query time alone against end-to-end TS time.

Proposed adoption gate: exact same IDs/order in every sample; at least 20% lower
end-to-end p95 for the agreed 5,000+ object workload, no more than 5% regression for
50/500 objects, warm gesture p95 under 100 ms on the agreed devices, cold
initialization p95 under 200 ms excluding network, Wasm memory within 64 MiB and
no monotonically growing live handles after disposal. The selection UI must never
wait for initial loading. Reject broad adoption if transfer/build costs erase the
gain; consider a worker only if the measured main-thread blocking justifies its
additional ownership/ordering/transfer protocol. None of these thresholds passes
or reopens held #22 performance acceptance in this PR.

Functional results and required/conditional conditions are recorded separately in
[the verification report](verification/issue-247/README.md).
