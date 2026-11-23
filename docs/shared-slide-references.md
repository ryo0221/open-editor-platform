# Shared Slide references design

## Scope and acceptance

Slide / `@editor-platform/slide` keeps its existing native JSON shape. This
extension to `@editor-platform/collaboration-adapters` is opt-in for Hosts that
can verify source snapshots and the destination audience. It covers the native
image reference and the fixed value/figure citation on Slide objects. The
existing Slide codec retains its current capability. Document, Design and
Whiteboard reference handling and Office export are outside this extension.

| Capability                    | Design                                                                                                                 | Acceptance                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Native model and local editor | Keep the existing content versions, element IDs and local commands.                                                    | N01–N05, N10. Native round trip and prior local editing tests.                                                                     |
| Shared Slide commands         | Insert, update, copy, remove and detach through native commands. One reference and its rendered values form one write. | C04, S01–S06. Two sessions, concurrent geometry/text, same-reference collision, selective Undo, reconnect, desktop and mobile.     |
| Host-authorized references    | Verify the exact source closure, value or projection and current audience.                                             | N09, N12. Raw submissions, invalid closures, denied snapshots or projections, revoked access. Host end-to-end checks are required. |
| Display and updates           | Show the adopted source snapshot until a user submits an update. Comparison and dismissing an update are view state.   | S03, N11. Two viewers on the same revision show the same source version and only adoption advances it.                             |

## Model and operation

The wire operation addresses an existing page and object ID. Changing a
reference, its associated text/runs or its cached image/label claims one
precondition for that part of the object. Placement and ordinary objects keep
their existing preconditions. A competing change to the same reference is stale;
both a change of reference and a concurrent move can succeed. An inverse claims
the same precondition and restores the old reference using the same authority
validation. Deletion still removes the object. Detachment is an explicit
operation that leaves ordinary text or a verified image; quoted values cannot be
edited through canvas text steps. Duplication uses the existing ID remap,
serialization and write checks. No schema migration rewrites older snapshots.

## Host responsibility

The owner of the trusted codec verifies a native reference's immutable source
version, target, retained dependencies, hashes and projection against an
independently authorized source, along with the effective audience. Client
optimistic evaluation cannot authorize a source. Hosts check before distributing
state, history, catch-up snapshots, asset projections, exports and saves, and
recheck when identity, access or audience changes. The collaboration codec does
not fetch arbitrary URLs or decide artifact permissions. Both fixed and follow
images render the adopted retained snapshot in shared editing. A notice about a
newer source neither replaces that snapshot nor changes shared or saved content.

The codec accepts a Host-provided asset cache. Hosts without an asset-ID
transport can choose `{ assets: false }` to retain native image bytes in
operations. Apply the same asset transport on both ends and enforce the
Host's upload and operation limits.

## Verification

Use the ordinary Slide commands and the authority directly for the acceptance
matrix, including a hand-built reference write that bypasses the client. Add
browser scenarios using the normal tools, checking both desktop and a narrow
viewport. Record verified source, commands, browser version and untested Host
conditions separately in the verification record.
