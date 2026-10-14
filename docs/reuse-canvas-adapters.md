# Slide and Whiteboard reusable parts

These extend the existing Library, immutable definitions and native proposal/Undo
path. They do not introduce a shared canvas content model. W4 remains incomplete
until the Data and Review/Viewer flows and the final acceptance gates are verified.

## Slide

`ReusablePayload.slide` explicitly chooses `objects` or `pages`. An in-page
definition contains objects from exactly one source page and does not own that
page's background, title or notes. `prepareComponentInsertion` requires
`target.slidePageId` for objects; a page layout instead inserts whole pages at
`target.afterId`. Both retain the finite native deck dimensions. Mismatched sizes
fail preparation rather than scaling content without consent.

Native page/group slots accept in-page components. Groups keep ordinary Slide
membership and world coordinates; page settings are not copied by child insertion.
Required nested contents and the parent are one undoable transaction. The same
dialog authors header/footer parts or whole layouts and selects the insertion page.

Reviewed revisions preserve native IDs, page order, current title/notes, edited
body/runs and local geometry/style changes. Stable unedited attributes may adopt
the new version. Public input ownership also preserves explicit default-equal
values. Page-size, page-membership or group-structure migrations are held for an
explicit compatible mapping, old pin or unlink; they never replace the whole deck.
Style materialization uses pixels, and native SVG/Office exporters see the adopted
values. External PPTX verification of this new flow remains a W5 gate.

## Whiteboard

Native nodes, groups, Sections and connectors retain their independent model and
infinite world coordinates. A Section contains root nodes/groups and does not clip
or act as a finite slide. Nested slots use native groups inside a Section. Native
Sections themselves do not nest; inserting a Section-bearing child into another
Section/group is rejected with an explicit reason.

`WhiteboardNode.ports` optionally declares up to 64 named ports. A port has a stable
node-local `key`, label, edge and fractional edge position. Connector `fromPort` and
`toPort` accept these keys in addition to the five existing automatic/edge choices.
Native validation rejects duplicate, invalid or dangling ports. The ordinary node
Inspector and Library revision form edit these settings; connector selectors show
the endpoint node's declared ports. Moving, rotating or reflecting a node recomputes
its endpoint with the same transform as the native drawing.

`ComponentUpdateSelection.portMapping` maps `oldStablePartId:oldPortKey` to a port
on the mapped node. Deleting a used port produces an addressed migration conflict.
The update dialog offers the declared new ports and ordinary edge/automatic choices.
Explicit migration updates internal/external connectors and node definitions in
one native transaction. Their IDs, opposite endpoints, labels and body remain.
Preview reads connector membership and endpoint fields, so a new attachment during
preview requires review. Node/endpoint changes are staged privately and validated
together; neither half is committed in isolation. Undo reverses both in the same
existing history action.

Legacy nodes have no declared ports and retain automatic/edge behavior. Native
copy/remap changes element IDs while preserving node-local port keys and topology.
Unlink keeps native ports and connectors. Native packs retain exact definitions,
inputs and closure; independent Host acceptance remains in W5.
