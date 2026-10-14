# Token and native style authoring

The normal editor's **トークン・スタイル** library publishes shared token sets and
domain-specific named styles through the existing `TemplateCatalog` and personal
catalog adapter. The component author/revision form binds an exact style version
to a stable rendered part. Existing artifacts change only after reviewed adoption.

`authorReusableTokens` validates every mode, seals an immutable `tokens` definition
in the `shared` domain and returns its locked closure. `authorReusableStyle` accepts
a `DomainStyle`, an exact token `DefinitionRef` and retained dependency definitions.
It checks the domain's supported bindings and all token modes before publication.
The published subset and DTCG exchange limits remain in [the contract](reuse-contract.md).
The UI supports typed primitive values, aliases, mode overrides, saved drafts,
revision publication, archive/restore and portable packs. Mode names are explicit;
an absent mode is diagnosed, never substituted silently.

`authorReusableComponent` accepts optional `styles: [{ partId, ref }]` and exact
dependency definitions. `lockReusableRoot` retains only the reachable exact closure,
rejecting missing references and same-version hash conflicts. Resolving a style
never fetches a newer catalog version. Public property defaults, variants and
instance inputs take priority over bound styles. Styles target concrete rendered
children: assigning text appearance to a Design instance/group or Slide page/group
is rejected because it cannot represent native child inheritance correctly.
Document styles merge declared fields without discarding existing paragraph fields.

## Explicit ownership and mode inheritance

`ReuseState.artifactMode` is optional; older artifacts retain their existing meaning.
Resolution is instance mode, then artifact mode, then each token set's default.
`previewArtifactMode` compares adopted base/current/resolved appearance and prepares
one existing native transaction for inheriting instances. Explicit instance modes,
case text and local appearance edits remain owned. The transaction reads mode,
instance membership and relevant native attributes, so related or ABA changes
require another preview. The artifact setting can also be cleared after its last
linked instance is detached; resolved native appearance stays intact.

`prepareComponentSettings` combines public input, variant and mode changes in one
existing operation. A `null` mode clears the instance selection. A `null` variant
restores the definition's default. Omitted fields preserve their current ownership.
An explicit variant equal to the old default remains pinned to that variant;
an inherited variant follows a later default change. Document's omitted `hidden`
and `hidden: false` are the same visible state during three-way comparison.

The ordinary Inspector only submits mode/variant controls the user changed. An
already-open form therefore does not undo a peer's intervening mode choice when
the user changes just the body. Shared changes still use the existing proposal,
authority, receipt retry and selective Undo APIs. No additional history exists.

## Boundaries

Style capabilities remain native and domain-specific. Canvas font weight currently
materializes as regular/bold; unsupported weights and unrepresentable native targets
produce diagnostics. A common color token can map to Document paragraph color and
Design/Slide typography color, while dimensions map px/pt explicitly. This does not
convert arbitrary components between media. Review/Viewer presets remain private
settings; source data and existing annotations are unchanged by style publication.

Evidence and remaining V2.2 gates are recorded in
the token/style checkpoint.
