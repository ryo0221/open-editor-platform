# Native Data reuse and migration

`authorReusableComponent({domain:'data', data:'fields' | 'view', ...})` publishes a
native typed field set or saved view/widget settings. It removes prototype records.
Source relation IDs used by defaults or filters remain explicit binding names;
they are never copied as records. A view owns its settings and binds existing
columns without taking ownership of their schema.

The normal Library shows compatible existing columns, names for newly added
columns and existing target records. `prepareComponentInsertion` uses
`target.fieldMapping` and `target.rowMapping`. Every view column requires an
existing compatible target. A record reference requires an explicit existing row.
Mappings with unknown sources or aliased target columns reject. The exact ID map
from the existing template insertion is retained in the instance; formulas bind
source names to IDs before renaming. Existing row IDs/values survive insertion.

Revisions use `previewComponentUpdate` with the same native proposal, authority and
selective Undo pipeline. `ComponentUpdateSelection.dataMigration` is keyed by the
stable part ID:

- `cast` reviews type, required/options and formula changes against every current
  record. An optional `values` map converts an existing string to an explicitly
  chosen value, including a target row ID for relations. Invalid cells are
  addressed in the preview and no application is produced.
- `keep` retains the local schema and values; a removed part becomes an independent
  local field/view. Existing-column bindings remain owned by the target.
- `drop` explicitly removes the field and its values or the view. Remaining formula,
  widget or other linked-instance dependencies hold the operation for correction.
- `add` explicitly adds a new part, optionally specifying `name` to resolve a field
  name collision. Defaults populate existing records; sample records are absent.

`rowMapping` on the update selection binds newly introduced relation references.
The normal revision dialog reuses the existing Data editor for field and saved-view
authoring. The update dialog exposes conversion, keep, deletion, addition and
record choices. Correct invalid values in the ordinary grid or choose a supported
mapping, then prepare again. Cross-type schema changes do not masquerade as style
tokens. Structural field additions/deletions keep current record identity.

Unrelated peer cell edits can survive a reviewed schema transaction. Converted
cells, formula inputs, row membership and affected native fields are preconditions;
late dependent edits require a fresh preview. Undo restores schema and converted
values together while preserving independent peer edits. Computed/read-only cells
remain protected from ordinary writes; an actual atomic schema transition can
materialize a formula as a stored value. Request-bound added IDs support retries.

`DataView.accent` is the finite `view.accent` token/style target. Native charts and
their SVG/PNG exports use it. Native saved-view updates reconcile unchanged private
display fields while retaining unsaved search, filter and layout changes. CSV
contains current cell values and does not retain Library metadata. Native JSON
retains exact definitions, bindings and local ownership through reload/remap.

This is the Data adapter checkpoint, not the complete V2.2 release. Review/Viewer,
remaining Library/integration controls and W5 performance/Office/Host gates are
tracked in the R01–R16 plan.
