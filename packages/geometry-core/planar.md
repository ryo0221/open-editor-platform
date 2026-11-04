# Unit-free planar topology

Import only `@editor-platform/geometry-core/planar`. The existing root graph and Bézier APIs retain their contracts. This entrypoint has no React, DOM, Geo, Design or CAD dependency and does not change any Editor/native/output behavior.

The four functions are `validatePlanarPoint`, `pointOnSegment`, `classifySegments` and `validateRing`. They return `PlanarResult<T>`: `{ok:true,value:T}` or `{ok:false,diagnostic:PlanarDiagnostic}`. Public types are `PlanarPoint` (readonly `[number,number]`), `SegmentPointRelation`, `SegmentRelation`, `PlanarCode`, `PlanarDiagnostic`, `PlanarResult`, `RingOptions`, `ValidRingInfo`. The only public constant is `planarLimits.maxVertices = 1000`.

```ts
import { validateRing } from '@editor-platform/geometry-core/planar';

const result = validateRing(
  [
    [0, 0],
    [4, 0],
    [0, 3],
    [0, 0],
  ],
  { maxVertices: 64 },
);
// result.ok => {vertexCount: 3, winding: 'positive'} in result.value.
// Otherwise inspect result.diagnostic.kind/code and optional indices.
```

## Numeric meaning

Classifications are exact for the **represented finite binary64 values**, including subnormals and both signed zeros. Bit decomposition and a common dyadic exponent precede BigInt coordinate arithmetic; there is no epsilon or implicit rebase/quantization. Orientation and area signs agree with rational arithmetic on those values. The [independent oracle and exactness invariant](test-fixtures/README.md) explain the evidence and conversion. ES2022 BigInt/DataView are required; no approximate fallback is offered.

A finite input does not recover precision lost before this call: `1e20+1 === 1e20`. Infinite values produced by upstream overflow are rejected. Near-but-distinct points remain distinct, near collinearity is not collinearity, and a nonzero gap remains disjoint. Native units, minimum edge length/area, near/snap, display/projection range and pixel hit widths belong to the consuming domain/adapter. No numeric area, distance, intersection coordinate, curve, hole/MultiPolygon, Boolean, offset or triangulation API is provided.

`validatePlanarPoint` copies two finite own numeric data slots from a dense array. Other functions also validate JS inputs; malformed/nonfinite arguments produce explicit failures. Coordinates and ring slots must not be accessors, and string coercion/inherited slots/TypedArray are not accepted. Arbitrary Proxy code, memory exhaustion and programmer invariant failures are outside normal input rejection.

## Ring and diagnostic ordering

A ring is a single straight outer loop with exact explicit closure (`===` on both axes, so -0 equals +0), at least three non-closing vertices, no other duplicate vertices, no zero-length edges and nonzero exact area. Both winding signs are valid: `positive` is mathematical CCW in y-up, visually reversed in y-down. No coordinates are repaired, removed, reversed or mutated. Straight redundant collinear vertices remain. Adjacent edges may share their endpoint but cannot backtrack/overlap. Nonadjacent cross, touch (including T contact) and overlap are invalid.

Only the first diagnostic is returned, in this stable order:

1. Own data `maxVertices` must be an integer in 3..1000. Then require an array container and **raw length ≤ maxVertices+1**, before reading any point. Overlong open/sparse/malformed input is a budget refusal, not an inspected geometry result.
2. Read each point in raw index order; reject shape/finite failures. Empty is too few; otherwise check exact closure, then `n = length-1 ≥ 3`.
3. Cyclic adjacent duplicates in edge order; then repeated vertices by ascending `(i,j)`; then all-collinear zero area.
4. Edge pairs in ascending `(i,j)`: overlap, or nonadjacent cross/touch. Adjacency includes the first/last edges. The remaining simple noncollinear ring has nonzero area; zero here is an internal invariant failure, not another input diagnostic.

| Kind     | Codes                                              | Indices                                                                                                            |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| input    | `invalid-limit`                                    | none                                                                                                               |
| input    | `invalid-input`, `coordinate-not-finite`           | ring raw vertex index (closing point may be n); predicate argument index; none for scalar point/container failures |
| budget   | `vertex-limit`                                     | none; geometry has not been inspected                                                                              |
| geometry | `ring-not-closed`, `too-few-vertices`, `zero-area` | none                                                                                                               |
| geometry | `adjacent-duplicate`, `repeated-vertex`            | two `vertexIndices`                                                                                                |
| geometry | `edge-overlap`, `self-crossing`, `self-contact`    | two `edgeIndices`                                                                                                  |

Geometry vertex indices exclude the closing duplicate; edge i is i→(i+1)%n. A cyclic duplicate may be `[n-1,0]`. The first problem does not certify absence of other problems. `validateRing` success returns only `{vertexCount,winding}`; readonly metadata does not certify a later mutation of the input. Point results are snapshots. No input references, caches or BigInt values escape. Normal input/budget/geometry failures return Result; internal invariant exceptions are not disguised as invalid geometry.

`pointOnSegment` returns `outside | endpoint | interior`; a zero-length segment contains just its endpoint. `classifySegments` returns `disjoint | cross | touch | overlap`; `cross` means both interiors cross, `overlap` requires positive common length, and one-point contacts (also point-segments) are `touch`. Argument indices are `[point,start,end]` / `[a,b,c,d]`.

## Resource and execution boundary

1000 is an independent **single-ring** hard ceiling, not a document/map capacity. Callers must explicitly choose a limit, often lower. The guard permits one additional closing slot. At most 1001 points are read, 1000 points are converted, and 499,500 vertex pairs plus 499,500 edge pairs are inspected, without recursion. Binary64 inputs require at most 2098-bit scaled coordinates before differences; products and the bounded area sum are approximately 4.2k bits. These are static arithmetic bounds, not measured heap/time guarantees. The exposed limit cannot raise the internal ceiling.

The value 1000 retains the reviewed design candidate as a finite MVP resource guard; no benchmark or interactive performance claim justifies it. It has a functional boundary test. Changing the ceiling or numeric guarantee requires contract review. No Editor calls this validator yet. Before a consumer integrates it, that consumer must bound total work per operation and choose its execution boundary; never run unbounded per-ring/map validation in synchronous commit or pointermove. If prevalidation is separated from commit, recheck unchanged geometry/revision, authority and atomic domain conditions. No new worker/Host runtime or async scheduling contract is added here. UI responsiveness/memory measurements remain NOT RUN; integration stays gated on separate evidence.

Geo deliberately retains its CRS84/unwrap/dateline/tolerance/diagnostic policies. A valid planar result is only the structural starting point for additional domain rejection. It does not authorize commands or replace domain validation, histories or native schemas.

## Intentional Geo coexistence and maintenance

Geometry-core maintainers own the exact represented-value predicates, ring diagnostics, numeric oracle and resource ceiling. Geo-core maintainers own CRS84 admission, longitude unwrap/dateline behavior, legacy tolerance/error ordering, retained topology, command rollback and existing outputs. Domain/Host owners retain units, practical minimum features, permissions and aggregate budgets. No production Geo→planar dependency or consumer migration is introduced. The Geo test import has an explicit devDependency on geometry-core.

The [coexistence unit fixtures](../geo-core/src/planar-coexistence.test.ts) cover G01 arbitrary-plane rejection by direct Geo editing validation (not full CRS84 admission), G02 legacy small-area rejection, G03 raw versus unwrapped dateline winding, G04 existing code/priority differences, and G05 retained holes/Multi/polar content and atomic rollback. Keep these intentional differences visible when either numeric policy changes. Standard Geo, CAD, Design and Whiteboard suites remain their own domain acceptance evidence.

For G06, the explicit functional checker uses a caller-reviewed Git commit, not an implicitly moving main. Set `PLANAR_BASELINE_COMMIT` to that commit and run from the repository root:

```sh
node scripts/verify-planar-geo-compat.mjs --baseline "$PLANAR_BASELINE_COMMIT" --output /tmp/planar-geo-compat
```

The commit's objects must be available locally; a missing source fails rather than falling back to current files. The checker loads baseline package source with `git show` into an esbuild plugin, leaves the checkout unchanged, verifies matching runtime manifests/third-party locks, and compares native/roundtrip/hash/SVG/PNG/receipt bytes using the same trusted fixture, engine/font environment and offline resources. It also exercises the public planar entrypoint in desktop/mobile Chromium contexts. The output must be a new/empty directory outside Git. Raw outputs and report/source hashes stay there. This command launches no performance workload, Actions, server, public export or worktree. Ordinary unit tests do not require Git-history PNG baselines.

Byte equality is scoped to that fixture and pinned same-engine/font environment; it is not cross-OS PNG equality or proof for all documents. Reviewers of the two packages must accept their ownership and differences. Revisit coexistence on new consumers or numeric-policy changes. Unification requires a reviewed CRS/unwrap adapter, preservation of legacy accepted/rejected sets and code ordering (or an explicitly approved semantics migration), complete G fixtures and native/hash/SVG/PNG comparisons, and both owners' review. Until then the two policies intentionally remain separate; no eventual unification is promised.
