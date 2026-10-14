# Native component authoring and reviewed updates

This describes the Design/Document implementation for #19/#20. The remaining
domains and the V2.2 acceptance ledger are tracked in [status](status.md).
Public APIs are exported from `@editor-platform/templates` and `reuse-core`.

## Native content and ownership

`authorReusableComponent` retains a closed native prototype and stable part IDs.
`prepareComponentInsertion` accepts public inputs, a variant, copy/linked choice,
and typed initial slot contents. Required slots, including nested required slots,
are filled in the same prepared transaction. Incomplete parent metadata is never
committed. Copy insertion copies all supplied slot contents without Library links.

Document body remains native semantic blocks and ProseMirror steps. Attribute-only
changes use `document.attributes`, with separate ownership from body input. A
Library revision always preserves current Document body/marks and IDs. Design
uses its existing component scopes and partial native overrides. Frame layout is
resolved in local pixels before the world transform; typography/layout overrides
inherit unspecified fields. The basis dimensions of a revised component update
once, while placement and local resizing remain owned by the instance.

`ReuseInstance.inputs` records explicit public ownership, including a value equal
to the default. Normal body editing may subsequently differ from that recorded
input; the native body is authoritative and the Inspector displays it. Changing
only visibility does not resubmit an old text input. Reset clears only the selected
property's ownership. Unlink removes Library metadata and retains current body,
images, IDs and native Design components; it does not flatten those components.

Template-owned images are resolved before native validation/rendering. Public asset
inputs accept owned `asset://id`/`asset:id` or supported image data. Unknown asset
references fail before apply. Omitting an image preserves its native part and can
be reset; existing copy-template omission behavior is unchanged. Scoped part/slot
addresses may exceed one local ID's length, but individual IDs, total expansion,
JSON size, and the 16-instance nesting budget remain bounded. Loading and authority
validation reject cyclic/deep adopted slot graphs as well as invalid definitions.

## Catalog and publication

The existing `CatalogAdapter`, `MemoryCatalog` and `LocalCatalog` provide
`saveReusableDraft`, `listReusableDrafts`, `deleteReusableDraft`, and `putBundle`.
Draft writes use an expected revision. Published versions are immutable exact
library/definition/version/hash references. Publishing a reviewed draft consumes
that revision and records its receipt in the same atomic transaction as all
definitions. Repeating that publication returns success; reusing its request with
different content fails. A failed/conflicting bundle leaves no partial publication
and retains its draft for retry. Draft conflicts require reloading the current
revision before saving further edits.

This extends the existing IndexedDB `versions` store; there is no second catalog.
`exportTemplatePack` accepts optional reusable closures, and `importTemplatePack`
atomically imports templates and closures together. Every token mode, style binding,
component variant, hash, dependency and owned template asset is checked before
publication. Archives hide listings but exact versions remain readable. Existing
adopted native content/closure does not depend on an available catalog.

A production Host supplies its catalog adapter and enforces its write/read policy.
The local reference catalog is not a remote authorization service. Revoking access
prevents future authorized submissions; it cannot erase materialized content that
was already delivered to a client.

## Three-way adoption and swap

`previewComponentUpdate` compares the retained old definition, the proposed exact
new definition/closure, and current native content. Its addressed rows describe
updated attributes, preserved input/body/overrides, and unresolved conflicts.
Selections can adopt, keep the current pin, or unlink. Explicit mappings are old
stable part/slot/property ID → new stable ID. A different definition identity uses
the explicit `swap` option. No mapping is guessed from text, names or list position.

Unchanged stable structure can adopt new defaults/styles and optional slots while
retaining local edits. Deleting an occupied slot, changing its allowed type/owner,
invalidating an explicit input, deleting a mapped part, changing native part type,
or changing scope/parent produces a conflict. Compatible renamed parts can be
mapped without changing native IDs. Adding/removing arbitrary prototype structure
is held for an explicit migration, pin or unlink; this implementation does not
silently replace the user's subtree. A native Design component shared with an
unselected instance is also held rather than changing that instance implicitly.

The result is the existing `PreparedApplication`: existing preconditions, proposal
preview, authority permissions, dedup and selective Undo own execution. Document
style adoption leaves concurrent same-block text alone. A changed dependency or
ABA edit requires a fresh preview. The normal Library/Inspector provide draft
resume/publish, version selection, diff, mapping, pin, reset and unlink controls.
Selected instances within one artifact are atomic. The normal multi-artifact
orchestration UI reports preview, application and retry separately for each artifact;
it does not provide a distributed transaction across artifacts.

## Large native preparation

Preparation retains validated immutable definitions and indexes native parts once
per batch. Mutable caller inputs are owned at entry before the first asynchronous
step. `collaboration-core.preparedResult(handle)` returns an isolated completed
projection for preview; it neither submits nor grants a receipt. Unknown handles
are rejected. `DomainCodec.encodeActions`, when present, serializes an action batch
before individual encoding and preserves the existing wire operation contract.
The native adapter compacts identical consecutive closure payloads, while each
stored inverse remains independently complete. Proposal validation uses the same
normalization and still checks exact payloads, dependencies and permissions.

Large Document attribute changes split at the unchanged 500-item patch limit inside
one operation, with correct text-engine versions between batches. The existing
wire byte, JSON, depth and native bounds remain in force. Ordinary edits do not
query the catalog or expand retained instances. See the performance investigation
for fixed workloads, measured paths and remaining acceptance work.

## Verification boundary

See the W2/W3 checkpoint for exact checks and
development failures. These checks do not complete R01–R16. Remaining work includes
other native domains, linked pattern/template composition, complete Host/fault/IME
scenarios, native pack movement into an independent Host, Office loss reporting and
external reopen, full browser regression and original-size performance measurements.
