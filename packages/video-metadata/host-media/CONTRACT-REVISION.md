# Video import/bundle contract revision for #160 review

Status: proposed, adoption HOLD. This package-local Host scaffold is not a public
Core/Extension API, permanent Host registration, or the final portable format.
Base: d4f34568cc34f1600d062b3cabf7b89d57d2333d from #157. No other lane pulled.

## Atomic import and ownership

One import consumes one immutable original and an explicit selection of one video
and optionally one audio stream, each with its own raw media interval, presentation
start and destination. Unselected alternate audio remains in the original; it is
not mixed. One existing guarded command commits both clips/source/links. Stale
revision, unavailable track, invalid audio or permission failure rejects all of it.

`ImportLeasePool` demonstrates an implementable Host-owned capability: private Map
membership validates opaque object identity, scoped to one pool, store and exact
public `Scope`; the recorded `LocalDraftRevision` is submitted to the existing
controller. No private string brand is accepted. Stage checks cancellation/scope
around every asynchronous boundary; commit consumes the capability once, including
on refusal. Reservation is bounded, release/dispose idempotent, and reentrant store
commit rejected. Successful original ownership transfers to the Host store before
the synchronous Core commit; refusal rolls it back. Resolver access is a Host-only
Blob lookup by already-validated native references, never an extension-supplied URL.

The scaffold retains all committed originals/interpretations until the Host is
destroyed, with total byte/count bounds. Thus Undo/Redo is not endangered by draft
reachability-based collection. SaveCoordinator capture leases separately retain
Blob references for selected and retained roots; unknown saves retain those leases
through existing coordinator reconciliation. Production GC requires explicit
history/retained-version/capture ownership accounting and is NOT implemented.

## Native identity, closure, save correlation

Every retained native root is the existing full `ArtifactVersion` envelope,
including parentVersionId, createdAt, createdBy and reason. Its canonical
`contentHash` is distinct from SHA-256 over exact serialized archive-entry bytes.
Parent roots must exist and be acyclic. The selected version is explicit.

Reader and writer independently traverse sources in selected AND retained native
roots, resolving interpretations and requiring original bytes matching the native
hash/length. The reader does not trust an archive `required` list; none exists.
Extra/missing original or interpretation records reject. Derived files cannot
satisfy an original dependency. This scaffold has no derived/index/recipe records:
those are rejected by the closed entry-kind grammar. The eventual versioned
interpretation/index/recipe registry must declare deterministic data-only edges;
walk those recursively from native roots, reject cycles/unknown schemas/external
references, and require originals even when derived files exist. Hashes and recipe
identifiers never grant code execution, module loading or arbitrary URL access.

Storage implements the existing public `Storage<VideoContent>` capture hooks.
Writes stage in an isolated target, read back and validate before commit. Unknown
commit results keep the existing SaveCoordinator claim/retained closure. Resolution
uses operationId + exact scope/revision/canonical hash + verified bundle byte hash,
then sends a correlated WriteEvidence to that same coordinator. A missing target
after an attempted commit is unknown, never proof that no write occurred. A digest
alone is not a receipt; the trusted target must return the actually committed bytes.

## Proposed permanent ZIP64 STORE profile (not implemented)

Recommend a closed, versioned ZIP64 profile rather than generic ZIP acceptance:
STORE only (method 0), UTF-8 flag bit 11 only, no encryption/data descriptors,
no comments, no multidisk and no duplicate/unknown extra fields. Local and central
headers must agree on name bytes, flags, method, CRC32 and sizes; ZIP64 extra 0x0001
must supply exactly the fields replaced by sentinel values, in specified order.
Validate central offsets and local entry intervals using BigInt, non-overlap,
contiguous bounded payloads, exact central-directory extent, ZIP64 end record,
locator and final EOCD counts/offsets/size consistency; no prepended/trailing data.

Require canonical ASCII paths from a finite grammar (manifest, native, originals,
interpretations, indexes, derived, recipes), no absolute paths, dot segments,
backslashes, NUL, case-fold collisions or duplicate names. Unix external attrs must
be regular files only, never symlinks/devices; reject external references. CRC32
checks transport integrity, SHA-256 checks declared bytes, and canonical native
hashes check content identity independently. Parse manifest and all record schemas
as data, not executable code. Derive closure independently and verify every entry
before activating a fresh Host. Preserve current Host until candidate passes.

Provisional review budgets: manifest 64 KiB, native envelope 64 KiB, retained roots
8, originals 100, total entries 512, total original bytes 4 GiB, total archive bytes
8 GiB, interpretation/index/recipe depth 16. These are proposals, not user product
limits. Validate count, per-entry and aggregate sizes before allocation and during
streamed writes/reads. ZIP64 requires streaming file-backed storage; this Blob
scaffold is explicitly limited to 16 MiB/import and 32 MiB/store/bundle and cannot
establish ZIP64 feasibility or large-project acceptance.

## Remaining acceptance

This checkpoint targets local adapter tests, including two independent in-process
Hosts with only serialized bytes transferred. Browser contexts/real-media import,
actual preview, ZIP64, large-file staging, rational fractional-source resampling,
HDR, 1080p MP4 export and actual iPhone/Windows acceptance remain separate gates.
No codec dependency, shared schema, root manifest or permanent registry changes.
