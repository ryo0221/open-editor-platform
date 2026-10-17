# Animation Core — rectangle v1 and prototype compatibility

Implements the approved fixed-time rectangle/group v1 data gate and retains the earlier
prototype reader. This is not the full Animation Editor or #75 integration acceptance.
See the current v1 contract and
historical prototype proposal.

Public entrypoint `@editor-platform/animation-core`: `validateAnimation`,
`prepareAnimation`, `evaluateAnimation`, `frameTick`, `mapNestedTick`, `replaceTrack`.
No React, DOM, renderer, scheduler, network, asset decoding or persistence is required.
Shapes/groups and numeric transforms/opacity are the only renderable native subset.
Unknown features reject; image manifests verify bytes only, never decode as trusted media.

```ts
const prepared = await prepareAnimation(nativeContent, retainedExactSources, suppliedBytes);
const scene = evaluateAnimation(prepared, nativeContent.rootCompositionId, 120000);
```

Retained sources use string Artifact version IDs and artifact-core canonical SHA256.
Provide one retained content per exact artifact/version/hash; layers may select different
compositions in that content. Hash agreement is integrity, not authorization/provenance.
Host supplies trusted permission and source capture. Preparation copies before async work,
validates every retained content and manifest, and never resolves URLs or latest versions.
The opaque prepared token is process-local; serialize native data, never the token.

`replaceTrack(expected, compositionId, track, scope)` returns an existing EditorCommand;
execute via EditorSession for local history. It checks current `scope.canEdit()` and
expected whole-content precondition at application, then validates the entire result.
The scope callback is temporary trusted local integration, not authenticated authority.
Do not use local commands in shared sessions; shared codec is not implemented.

Paint order follows the composition layer array. Group parenting affects transforms,
opacity and visibility; it does not implicitly reorder descendants. No clipping is
implied by composition dimensions. Returned matrices may contain floating roundoff;
identical input/tick is deterministic within the evaluator/runtime, not identical pixels
across browsers. Outgoing easing owns each segment; before/after track endpoints hold.

Validation bounds are provisional refusal limits, not scale/performance acceptance.
Migration to rectangle v1 is explicit and returns a new draft/ordinary command.
No old immutable versions are rewritten; nested/asset migration is currently rejected.
Root Host/registration, domain tables and README/status are intentionally left to #76.
See verification for exact commits and gates.

Preparation shares a 32 MiB JSON-copy budget and 500,000-node budget across root,
retained refs and retained content. UTF-8 JSON costs (including keys/escapes) are
charged before copying each value; no aggregate serialization is required to reject
an oversized closure. Byte assets retain their separate existing cumulative budget.
These remain provisional refusal limits, not a performance or production contract.

The new rectangle schema v1 gate is separate from
prototype admission: `readAnimationV1`, fixed `frameTickV1`, `prepareRectangleAnimationV1`,
and explicit new-draft/command migration. `AnimationContent` discriminates both readers.
V1 currently rejects nested composition layers and assets; the prototype reader keeps them.
