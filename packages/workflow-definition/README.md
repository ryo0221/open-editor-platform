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

- `workflowDefinitionDiff`: what changed from a version to the draft, by element ID.

## `.` (React views)

`WorkflowDefinitionSurface({ binding, revision, check?, baseline?, initialTab? })` shows the
definition as tabs over the same JSON: flow (`GraphSurface`, phases and sections, with deliverables
and acceptance on request), lists (phases, sections, deliverables with their outline, acceptance,
roles), matrices (item kinds, rules, phases × deliverables, citations, coverage, acceptance ×
rules), the definition's own fields (gates and placements read only), and the changes from
`baseline`. Every edit goes through `binding.options.execute` as one `workflowDefinitionCommand`,
so the Host's one Undo covers all views. Elements are added with a shared form that asks for the ID.
The Surface imports its own stylesheet, also exported as `./styles.css`.

The reference Host is `apps/workflow-definition-reference` (Playground
`/workflow-definition-host.html`): in-memory source and sidecar, one Undo, a saved version for the
changes tab, read only, with or without `commitWithPresentation`, and the pinned OWD check injected.

## Tests

`fixtures/owd-446706b` is a test-only copy of OWD at a pinned commit (MIT): schema, `check.mjs`,
the generated validator and four published definitions. OEP does not depend on OWD at run time;
the reference Host imports the copy only to show a Host-injected check.

Browser flows: `tests/e2e/workflow-definition.spec.ts` and `workflow-definition-mobile.spec.ts`.
