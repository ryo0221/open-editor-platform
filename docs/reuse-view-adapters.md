# Review / Viewer reusable settings (#21)

The native Review comparison and Viewer file remain the source of truth. A
`view-preset` definition contains a source-free, typed view template and defaults
for **new** annotations (`body`, optional sRGB color). It cannot contain an old
source, anchor, author, comment history or source asset. Review exposes split,
wrap and annotation visibility; Viewer exposes page/width fit and annotation
visibility. Native viewer controls retain their existing file-type capabilities.

## Private adoption and revisions

`authorReusableViewPreset` publishes through the existing catalog bundle/draft
contracts. Its definition has an exact immutable reference and closure. The normal
SaveTemplateDialog/Library supports saved draft resume, immutable revisions,
copy/linked application, explicit preview, archive/restore and portable definition
packs. There is no second catalog.

`prepareReusableViewPreset` returns private settings; it does not submit a content
operation or enter shared Undo. The reference Host stores these in its existing
per-artifact view preferences (`ep-template-view-settings`). `$library` retains the
exact adopted definition, closure, explicit input keys and private override keys.
`$annotation` holds the resolved defaults for a new annotation. Another browser's
preferences and the original source content are unaffected.

The same ordinary split/wrap/fit controls call `editPrivateViewSettings`. Explicit
ownership is recorded even when the user chooses the current default. Revision
preview compares the old adopted defaults, current private values and incoming
defaults, preserving explicit/private changes. The form can explicitly reset an
individual field. No adoption occurs on publication. The retained version remains
available offline or after archive; detach removes only its link metadata. Copy
keeps resolved values without a continuing link. Private preview application uses
a current-settings fingerprint to reject a changed basis.

An optional exact annotation style resolves the shared token contract and selected
mode into `annotation.color`; it cannot change source bytes or identifiers. Passing
`mode: null` explicitly returns to the definition's default mode. Absence of `mode`
preserves an existing adoption's selection. Definition packs transport owned
dependencies; a Host can persist its private adoption separately. The reference
Host deliberately excludes private preferences from shared/native artifact export.

## New annotations and existing history

`annotationSource(artifactId, content, address)` binds an explicit source, current
revision, region and SHA-256 of the original bytes. Review requires the comparison
side and exact revision/line range. Viewer uses native text lines, image coordinates
or PDF page/region coordinates. Text hashing and download retain BOM/CRLF through
`originalBytes`. Image/SVG and PDF hash their actual bytes, not a screenshot.

`prepareReusableAnnotation` receives the same immutable snapshot and trusted Host
identity used by other proposals. It creates fresh thread/comment identities and
checks the source fingerprint again. Its application contains ordinary
`thread.create`/`thread.reply` actions and source preconditions. The existing
Review/Viewer codecs reject source-content mutations while permitting shared
annotations. Preview, permission enforcement, retry receipts and actor/session
selective Undo remain owned by the existing authority/session.

The normal Comments inspector displays the proposed body, source revision and
region before explicit creation; the source hash is available under its details.
Changing an annotation default never rewrites existing comments or their colors.
`Annotation.color` and shared `Thread.color` are optional, validated and retained
through native serialization, adapter conversion and existing Undo/Redo.

Local annotations use the Host's existing annotation persistence, which is separate
from native content Undo. Shared annotations use the existing shared history.
Private preferences never require a shared Undo operation. A Host integrating the
public dialog supplies `onPrivateSettings` and `onApply` for these existing lifecycle
boundaries; it must not write annotation previews back as source-content snapshots.

## Boundaries

- Source replacement remains the native Review/Viewer operation. A preview whose
  source, revision or content changed is rejected before local/authority application.
- The pure source check validates the native address type, positive finite region
  and current text bounds. It does not decode PDF/image files to certify external
  coordinates against every rendered page's dimensions. The native UI creates
  coordinates from the displayed page/image.
- Manual zoom/rotation, text search and navigation keep their existing transient
  viewer behavior; the preset's finite public inputs are documented above.
- There is no source-copy template or artifact schema replacement for these domains.
  Existing annotation bodies/actors remain outside reusable definitions and packs.

Evidence and any remaining release gates are recorded in [status](status.md) and
the R01–R16 plan.

The preset author also exposes **新しい注釈に採用するスタイルの版**. It selects an
exact published style and its retained tokens, survives draft save/reload and can
be removed in a new revision to restore the fixed annotation color. Publication
prunes dependencies no longer reachable from the preset. Adoption chooses the
style mode explicitly; existing annotations and original source remain unchanged.
