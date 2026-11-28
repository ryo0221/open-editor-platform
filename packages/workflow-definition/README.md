# @editor-platform/workflow-definition

The workflow-definition Editor (#99): it edits an
[open-workflow-definitions](https://github.com/ryo0221/open-workflow-definitions) (OWD) format 1
JSON definition that a Host owns. It adds no artifact kind. The design is
[docs/workflow-definition-editor-design.md](../../docs/workflow-definition-editor-design.md).

## `./model` (no React)

- `readOwdDefinition`: opens a format 1 definition when it can be projected and edited; fields it
  does not edit (gates, placements, views, later fields) are kept as they are.
- `WorkflowDefinitionIntent`, `applyWorkflowDefinitionIntents`, `workflowDefinitionCommand`: every
  edit (add, set fields, delete with `cascade`, change an ID everywhere, reorder, `set-rule`) as one
  command for the Host's Undo. A batch that adds a structure problem is refused as a whole.
- `structureDiagnostics`, `cycleDiagnostics`, `mapCheckResults`, `workflowDefinitionDiagnostics`:
  this Editor's checks and the Host's injected OWD `check`, mapped to elements by leading word and
  ID or JSON Pointer. Without a check the diagnostics say that the Host does not check.
- `createOwdGraphAdapter({ check })`, `owdGraphAdapter`, `owdGraphProfile`, `projectOwdGraph`: the
  flow view for `GraphBinding`. Node and Section IDs carry the kind (`phase:concept`); presentation,
  including Section frames, is kept in the Host's sidecar (schema 3). With
  `commitWithPresentation`, dropping a phase into a section moves it and changes its section in one
  edit; without it, pass `binding.sectionDrop` to the Surface.

ID namespaces follow OWD's check: phases, sections, deliverables and acceptance share one; item
kinds, rules and roles each have their own.

## Tests

`fixtures/owd-446706b` is a test-only copy of OWD at a pinned commit (MIT): schema, `check.mjs`,
the generated validator and four published definitions. OEP does not depend on OWD at run time.
