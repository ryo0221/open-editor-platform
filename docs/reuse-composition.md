# Native Pattern / Template composition

V2.2 W5 / #22 extends the existing template recipe, catalog, SaveTemplateDialog,
input form, proposal, atomic creation and pack APIs. A composition is a **creation
recipe**. Its linked children remain ordinary native component instances; there
is no outer instance owning the same native parts, second document model or
separate apply / Undo path.

## Author and use

In the ordinary editor, choose **テンプレートとして保存**, then enable
**部品の参照と公開入力を含める**. Each complete adopted member explicitly chooses
an independent copy or an exact linked version. Select its declared public
properties to expose as template inputs and review the rendered sample before
saving. Whole-artifact recipes create new artifacts; selected fragments insert
into the existing artifact. Gallery shows the copy / linked member counts and
uses the existing typed form and preview.

The recipe retains all captured member definitions, assets, inputs, overrides,
variants and declared slot contents, including members selected as copies. This
allows both kinds of member to receive typed creation inputs. After expansion,
only linked members retain library metadata. Each creation remaps native IDs,
instance IDs, slot roots and native reference maps independently. Publication or
catalog deletion never silently updates an already created artifact.

Existing templates, including old immutable snapshots that captured optional
reuse metadata, still expand as independent copies unless they explicitly declare
`composition`. Their original definition/hash is not rewritten. Newly authored
ordinary copy templates omit the captured reuse metadata.

## Public API

`saveAsTemplate` accepts optional `composition: CompositionCapture`:

```ts
composition: {
  libraryId: 'personal',
  members: { [parentInstanceId]: 'linked', [otherInstanceId]: 'copy' },
  inputs: [{
    key: 'caseBody', label: '案件本文',
    instanceId: parentInstanceId, propertyId: publicTextPropertyId,
  }],
}
```

`authorReusableComposition(options)` returns `{ template, definition, closure }`.
The common immutable definition kind is `template` for whole creation and
`pattern` for a fragment, with `{ template }` payload and exact member dependencies.
`compositionBundle(template)` derives the same envelope. `Catalog.put` and
`exportTemplatePack` derive it automatically and publish/import the template and
reachable closure atomically. They use the existing catalog storage and collision
rules, not a parallel library.

`prepareInstantiation` / `applyInstantiation` and `prepareInsertion` use the same
recipe for the human form and Host agent. Host retains creation authorization,
request deduplication and persistence. The independent public-package example at
`apps/playground/src/template-host.tsx` accepts `?empty-catalog=1` to start without
builtin templates and import a native pack. Import refreshes its human and agent
template selection; it does not require the main playground App or its model.

## Native boundaries

- Select complete member parts and slot roots to keep links. Incomplete selection
  can remain an independent native copy; explicitly requesting its link fails.
- Composition inputs address declared public component properties, with their
  existing types and constraints. Arbitrary legacy bindings into a member and
  generic repeat expansion are rejected. Repeated linked insertion uses separately
  prepared requests with independent native ownership. At most 256 public creation
  inputs are exposed.
- Captured typed slots retain their declarations and current nested contents.
  After creation, their existing component Inspector edits the contents. Composition
  does not introduce executable slot scripts or a separate structural input runtime.
- Design keeps scoped component overrides and translates canvas roots only once.
  Slide page layouts insert as pages; an object pattern can target an existing page
  without replacing that page's notes or dimensions. Whiteboard retains Sections,
  world coordinates and explicit connector ports.
- A Data fragment captures fields/views and uses destination records. It requires
  explicit row-reference mapping and treats reused target columns as externally
  owned schema, using the existing schema-override marker. Whole Data templates can
  create the captured records with remapped relation/formula IDs.
- Inserting into a different artifact mode aligns only linked members to that
  destination mode through the existing preview path. Copied members keep their
  captured appearance. A concurrent positional Document edit requires synchronization
  and a fresh insertion preview; no stale offset is guessed.
- Empty image parts retain their stable addresses. Document image changes use
  semantic `document.attributes` for `src`, `alt`, `width` and `caption`, with field
  preconditions and selective Undo. Paragraph text, independent image attributes
  and annotation positions are not replaced by a content snapshot.

Native packs preserve ongoing component semantics. Office output remains a
separate resolved-content export with its declared V2.1 fidelity limits; a native
pack is required to retain the ongoing library/variant/slot contract.

The focused evidence is recorded under `docs/verification/v2-2/composition/`.
This composition checkpoint alone does not complete the final R01–R16, Office,
fault-recovery and performance gates.
