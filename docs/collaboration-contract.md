# Shared editing contract (Issue #3)

The implementation is an Editor foundation and a runnable reference Host. It uses
separate existing domain models, ProseMirror rebasing for Document, and an ordered
in-memory authority for field/structural operations. See ADR 003.
Issue #2 was completed and its R2 review fixes verified before this implementation.
Only ADR 002's origin/live-revision/engine preparation preceded that checkpoint.

## Public boundaries

Editor owns editing semantics and integrity. Collaboration Platform owns organizations,
Rooms, membership/invitations, authenticated identity, authorization policy/enforcement
and Room–Artifact relationships. Its trusted adapter supplies sessions, allowed scopes,
update transport and connection/expiry notifications. Editor consumes these capabilities;
it does not derive organization policy or manage RBAC. Enforcement belongs at the trusted
submission/commit boundary, alongside the Editor's content/precondition checks.
Agent generation and organizational approval workflows remain Host/Runtime concerns.

- `@editor-platform/collaboration-core`: serializable operation/receipt/snapshot,
  domain codec boundary, authority, local/fault adapters, independent optimistic
  client, proposal preview/adoption, presence and checkpoint/backup.
- `@editor-platform/collaboration-adapters`: actual domain codecs, DocumentReplica,
  HTTP adapter example, and asset ID/hash materialization. Model and engine
  subentries (`./model`, Document `./engine`) avoid importing React surfaces.
- `apps/collaboration-reference`: small HTTP Host. Each connection gets its own
  opaque token, client and session identity. A/B/C is intentionally demo login;
  choosing “agent” grants no extra write permission. A production Host must bind
  real authenticated identity and artifact access before creating a principal.
- `apps/playground/collaboration.html`: verification Lab, not a replacement for the
  normal editor. It never executes
  the main editor's unsupported local commands in a shared session. Each tab owns
  a client/engine state and pending queue; C connects independently over HTTP.

No provider, prompt, model, tool execution or runtime dependency enters the Editor.
The only agent behavior is a deterministic Host fixture.

Issue #5 connects the normal editor to this foundation using prepared domain transactions
and actual Document/canvas text engines. Its [coverage](editor-collaboration-coverage.md)
extends the intentionally smaller Lab action set below. #4 template application should
reuse those public operation/proposal APIs. See [normal Host integration](editor-collaboration-integration.md).

## Canonical state, operation and receipt

An operation includes protocol/schema 1, artifact/domain, operation and transaction
IDs, actor/client/session, origin, base live revision, derived stable targets,
serializable actions and resource conditions. JavaScript functions, non-JSON data,
unknown schemas, nonfinite numbers and oversized envelopes reject. UUIDs are fixed
before submission. Domain postconditions validate every transaction before commit.

The authority validates identity/scopes against its trusted connection principal,
never against the actor kind. Provenance is authorized the same way: a connection
may declare `human` or locally reviewed `proposal` origin, and `agent` only when its
principal's `origins` grant includes it. Undo/redo, restore, `proposalId`,
`sourceActorId`, `proposal:` operation IDs and whole-content `domain.restore` actions
are issued only by the authority's Undo, restore and proposal APIs. A duplicate operation ID returns its original receipt;
a changed payload under the same ID is a protocol error, including after compaction.
Rejected operations are also remembered. A changed/rebased intention needs a new ID.
Accepted means committed in process memory (`durable: false`), not disk durability.
An HTTP timeout does not mean rejection; query the receipt or retry the exact operation.

Resource conditions contain a monotonic stamp and canonical value fingerprint. The
fingerprint is SHA-256 of canonical JSON (using the MIT-licensed `@noble/hashes`);
large bytes are not copied into each precondition. Stamps detect ABA edits even
when the value returns to its original spelling. Whole-resource reads include the
maximum revision of descendant keys (`shape1` includes `shape1/fill`); a field read
does not include its siblings. Structural transactions conservatively
invalidate prior resource conditions. Live revision orders accepted transactions;
Document engine version counts accepted steps. Neither is an immutable saved version.
No ordering uses wall-clock time. Clocks are only used for ephemeral presence TTL.

The reference event includes a confirmed snapshot as well as its operation. This is
simple to inspect and intentionally trades bandwidth/memory for clarity; a production
adapter can use checkpoint plus deltas while preserving the same accepted history.
There is no content-wide last-writer-wins mutation endpoint.

## Conflict and operation coverage

“Shared” below means implemented in codecs and rejected safely when preconditions
fail. “Unavailable” means absent/disabled in the reference shared UI and rejected at
submission, while the single-user Issue #2 editor still offers its original features.

| Domain / Issue #2 family               | Shared behavior and conflict policy                                                                                                                                                                                                                                                        | Unavailable in this reference                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Document rich input                    | ProseMirror insert/delete/marks/split/join; stable node IDs, engine mapping, concurrent unconfirmed-step rebase. Exact engine version at acceptance; catch up and resubmit changed steps with a new ID.                                                                                    | Arbitrary legacy block functions; offline merge after required text history is compacted; text within canvas surfaces.         |
| Slide / Design / Whiteboard appearance | Stable element property sets: fill/color, bounds, opacity, rotation, hidden/locked/name where valid. Distinct properties coexist; same property requires current resource.                                                                                                                 | Text box replacement/typography, image cropping, charts/tables, theme/page-size/presentation mutations.                        |
| Geometry                               | Explicit leaf delta moves compose; absolute bounds are conditional sets. Group delta moves include every descendant in one operation and pin topology.                                                                                                                                     | Group resize, align/distribute/match-size/flip, constraints and auto-layout recomputation through shared commands.             |
| Hierarchy / order                      | Existing-element reparent, deletion of descendant subtree, ID permutation for canvas layers/slide pages. Cycles, missing parents, invalid bounds and duplicate IDs reject. Structural changes conservatively pin the whole current artifact.                                               | Shared insertion/group creation/ungrouping, cross-page movement, unrestricted reorder merge.                                   |
| Design components                      | Definition template/part fill (stable part ID for a component tree) and checked instance descendant-fill override are separate operations; component and parent references validated.                                                                                                      | Definition creation/deletion, component-tree restructuring and advanced override/layout edits.                                 |
| Whiteboard connectors                  | Deleting an endpoint removes incident connectors in the same transaction; anchored comments become orphaned.                                                                                                                                                                               | Connector creation/routing, Sections membership/resize, drawing/freehand transactions.                                         |
| Data                                   | Row/column IDs address cells. Different cells coexist; same-cell CAS rejects. Multiple cell actions form atomic paste. Column edits pin schema/current artifact, validate values; computed/read-only writes reject. Row order is an exact ID permutation; referenced row deletion rejects. | Column/row insertion, schema removal, shared view-definition edits, formula language expansion, arbitrary grid command replay. |
| Review                                 | Original comparison sources are immutable; fixed side + source revision annotations share.                                                                                                                                                                                                 | Shared replacement of comparison source files.                                                                                 |
| File Viewer                            | Immutable original bytes; fixed source identity and optional page anchors share.                                                                                                                                                                                                           | Shared replacement of original files; full PDF page-boundary validation requires the Host's parsed-page metadata.              |
| All annotations                        | Stable thread/reply IDs. Concurrent append replies and resolve/reopen use distinct resources. Anchor edits are conditional. Document anchors map with engine steps, canvas deletions orphan affected anchors.                                                                              | Rich comment-body editing and merging; automatic recovery of orphaned anchors.                                                 |
| Assets                                 | `withAssets` attaches an available immutable ID/hash reference to image elements, resolves legacy snapshot bytes, and emits an ID/hash inverse. Missing/deleted/hash-mismatched assets reject.                                                                                             | Upload/storage service, remote asset fetch implementation and image controls in the reference UI.                              |
| Versions / native data                 | Confirmed revision is separate from immutable domain snapshots; reviewed restore is a new conditional transaction for canvas/Data. Existing native schemas and old saved hashes stay unchanged.                                                                                            | Unconditional restore over remote changes; Document snapshot restore without a reviewed engine replacement.                    |

Pure domain apply functions receive clones. Validation failures never partially
modify authority content. Before committing, the authority validates the complete
snapshot, including annotations and revision stamps. Canvas/Data restores retain
anchors whose stable IDs still exist and orphan missing references, for comments and
presence alike. Existing orphans require explicit reattachment; restoration does not
guess a new target. An invalid final snapshot rejects the whole transaction without
publishing an event. Structural inverses are conditional full restores and
therefore require an unchanged artifact; they cannot overwrite intervening edits.
Scoped users may be unable to apply a structural inverse that needs whole-artifact
permission. That refusal is intentional and visible.

## Selective Undo and text engine

An accepted transaction belongs to its actor + session, not every tab of that user.
Undo/Redo is another accepted shared operation. Field inverse checks last-writer
stamps using the same effective revision as normal preconditions, including a later
structural change/full restore; another actor's replacement is preserved with
`undo-conflict`. Remote changes
to independent fields remain. Gesture/paste batches are one transaction.

Text Undo uses engine inverse steps. If another transaction changes the same stable
block, it conservatively refuses rather than deleting someone else's inserted text.
If only other blocks changed, ProseMirror rebases the inverse over those steps.
This is a deliberately narrower capability than unrestricted selective text Undo.
Mixed text/annotation inverses require explicit review after intervening changes.
Native local EditorSession snapshot Undo is never used for remote history.

DocumentReplica retains unconfirmed steps using `prosemirror-collab` (MIT). Lost ack
keeps the exact in-flight operation identity. Remote steps rebase subsequent local
steps. Compaction beyond pending text's base produces `resync-required` and preserves
the pending checkpoint for review; it never replaces the authority with an old snapshot.

## Proposals and intent

Runtime supplies immutable proposal ID, source actor, generation revision, declared
read dependencies, write conditions, summary and optional opaque external references.
The Editor cannot infer undeclared reads. `reads: null` conservatively pins the whole
artifact; an explicit empty list means the Runtime asserts no read dependencies.
Independent revision changes do not invalidate unrelated reads/writes.

States are ready → preview → applied, with conflicted/cancelled/rejected outcomes.
Preview computes a candidate without mutation or lock. A new preview creates a new
review token. Apply checks token, identity/scopes, original intent, read stamps,
write stamps, external references, and domain invariants at the synchronous authority
commit point. A relevant edit after preview cannot pass the old review silently.
A stale proposal needs Host regeneration or a new reviewed proposal, not automatic AI
re-query. Adoption records source actor C separately from adopter A; reference Undo
ownership is the adopter's session.

Registration requires the trusted principal to be the proposal's source actor.
Apply is idempotent by proposal identity. Cancel before commit is terminal; cancel
after commit reports applied. The source actor may withdraw its proposal; rejecting,
or cancelling another actor's proposal, needs an unexpired writable principal whose
scopes cover the proposal's targets (whole-artifact scope when it no longer applies). Cancelled
and rejected outcomes are final; a later cancel or reject reports them unchanged.
Verification. The authority protects its internal proposal commit
path; a raw wire `proposalId` cannot bypass preview/adoption. External read validation
is a synchronous Host hook. Cross-system atomicity requires a Host version/lease
agreement and is not guaranteed merely by calling that hook.
An external reference is an Artifact ID and its exact version ID. The hook may answer
`true`/`false` or a `CurrentRead` (`available` with a version, `changed`, `missing`,
`forbidden`); a stale proposal is rejected with `stale-precondition`, keys
`external:<artifactId>`, and the reasons kept on the proposal state as `stale`.

## Recovery, presence and persistence

CollaborationClient buffers revision gaps, installs only newer snapshots and
recomputes pending edits over confirmed content. A rejected optimistic operation is
removed without deleting later pending or remote operations. A pending operation that
cannot apply is held with a reason. Receipt reconciliation avoids replaying accepted
pending operations after a compacted snapshot. Checkpoints bind the exact authenticated
actor/client/session; importing another client's pending queue is rejected.

Adapter status subscriptions deliver connection/permission changes; submission still
enforces the current Host principal.

`saveConfirmedVersion` captures authority content and its live/engine revision before
asynchronous hashing, excludes pending edits, and returns an immutable ArtifactVersion.
The reference Host retains saved versions in memory; restart durability remains a Host
responsibility. Restoring a saved canvas/Data version checks the reviewed live revision.

Authority native backup schema 1 includes confirmed content, annotations, revision,
engine version, stamps, log boundary, dedup receipts and inverse/proposal history.
Client pending checkpoints are separate. Tokens/passwords and presence are excluded.
Production Hosts must persist checkpoints, accepted log, receipts and pending data
atomically with their own durable storage. The reference process does not survive a
server restart and does not claim bounded memory/long-term dedup retention.

Presence expires after 15 seconds or explicit close/disconnect. It includes display
identity, page, mapped caret/selection and optional short activity. It is not a lock,
content, Undo item, saved version or export. Private zoom/panels stay in each client.
Abrupt transport loss uses TTL. Long-term offline merge is not a capability; in-flight
pending work is retained and reconciled, and conflicts remain explicit.

### Presence coordinates and concurrent text

Cross-client presence carries `basis`, the canonical live revision at which its
anchor was measured. The authority validates against that state and maps the anchor
through accepted history before publishing it at the current revision. If the basis
is unavailable, the cursor is orphaned/hidden rather than guessed. `basis` is optional
for compatibility with local callers measuring the authority's current state;
network callers must supply it.

`DocumentReplica.presencePosition()` withholds a caret inside unconfirmed text until
its steps are accepted. `localAnchor()` maps canonical carets and comment ranges over
received steps and the recipient's pending edits for rendering. Deleted ranges become
orphaned. A delayed-submit browser regression keeps Japanese composition pending
through three presence polls and still requires zero console/network errors.
