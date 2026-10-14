# Limited Office import

`Library → Officeから新規作成` opens the confirmed creation flow. The current
implementation targets transitional PPTX and DOCX. The resulting native artifacts
use the existing template authoring and reuse flow. PPTX offers page numbers, hidden-slide and note scope; DOCX imports
the selected document body. Strict mode stops on formatting approximations. Review mode shows each loss,
a native preview and the exact source part/path. Unsupported features can be
individually excluded, then previewed again. Structural corruption is never waived.
Changing source/options/exclusions removes consent. No artifact is created until
confirmation. Cancel terminates the parsing Worker. Persistence starts only after
confirmation; an uncertain receipt is retried with the same request ID.

Public packages are `office-import-core` (inspection/report/creation lifecycle) and
`slide-import` and `document-import` (separate typed native mappings). `office-import-ui` supplies the lazy
Worker dialog. Hosts supply an authority-enforcing atomic creation adapter; the
local reference reuses #4's `putIfAbsent` path. Headless use:

```ts
const plan = await prepareSlideImport(
  { bytes, format: 'pptx' },
  {
    unsupported: 'review-conversions',
    fontProfileId: 'noto-cjk-jp-2.004',
    pages: 'all',
    includeHidden: false,
    notes: 'exclude',
  },
  requestId,
  { version: 'my-image-validator-v1', decodeImage },
  signal,
);
// Show plan.preview and every addressed diagnostic. Obtain explicit current consent.
const artifact = await applyOfficeImport(plan, consent, trustedHostCreation, signal);
```

Image validators receive owned bytes, never URLs; the reference Node adapter uses
an isolated native-codec child process. Missing decoders, unsupported formats and
external images block the affected element until explicit exclusion. No element
renderer is installed in this profile; unsupported drawings do not become blank
placeholders or page screenshots. Original Office bytes are not persisted by the
Editor. Host source storage/access remains a Host responsibility.

## Declared PPTX representation

- Page dimensions/order and explicit selection/hidden/notes scope are retained.
  Source drawing IDs are scoped by part. Actual drawing duplicates in a part fail;
  the non-rendering spTree container has no native identity. Native IDs are fixed
  during preparation and group references remain consistent.
  Hidden groups retain their own hidden flag, so their descendants stay absent from
  previews and SVG/Office output without losing editable child content.
- 13 basic native shapes, text/rich runs, static PNG/JPEG, simple unmerged tables
  and group world transforms remain editable. Rotation/reflection are retained;
  non-uniform nested transforms requiring skew block the element. Diagonal line
  endpoints become a native line with the corresponding rotation. Preset arrows
  use native head/shaft proportions, with an addressed approximation warning.
- Master/layout placeholders, theme colors/style references and supported paragraph
  defaults resolve before flattening. Office inheritance is not retained. Native
  font profile is fixed Japanese Noto; source font substitution, text auto-fit,
  asymmetric padding, paragraph spacing and reflow are reported. Table text and
  dimensions remain; native tables use uniform styling and cannot retain per-cell
  rich formatting. Automatic zero-height rows receive an explicit approximation.
  Shape `fontRef` colors resolve before paragraph defaults and individual run
  formatting. Table cells and included speaker notes retain explicit line breaks,
  paragraph boundaries and empty paragraphs in their plain native text.
- Source image crop is converted through an aspect-preserving containing image
  viewport. Non-uniform stretching is an explicit approximation. PNG/JPEG bytes,
  image alpha, geometry and alt text are retained. GIF/WebP/SVG and unknown images
  require exclusion in this first input profile.
- Charts/SmartArt, unknown shapes/extensions, merged presentation tables, animation,
  transition and unsupported visual effects stop or require individual exclusion.
  Selected theme `effectRef` styles undergo the same loss checks as directly
  specified effects. Unused styles and effects replaced by a local empty list do
  not create spurious warnings; unresolved active references fail preparation.
  Known Office modification identity, comments, author/history/custom metadata are
  excluded and listed. Links are validated as display information and never opened;
  Slide's native model keeps their display text, with a link-loss warning.

## Declared DOCX representation

`prepareDocumentImport({ bytes, format: 'docx' }, options, requestId, adapters,
signal)` returns a separate `DocumentImportPlan`. It uses the same consent,
ownership and atomic creation functions as Slide, without a shared content model.

- Paragraph and run style inheritance, numbering definitions/overrides and internal
  relationships resolve before native mapping. Semantic outline levels 0–5 become
  headings 1–6; style names alone do not determine headings. Bold, italic, underline,
  strike, supported colors/highlights and validated display hyperlinks remain native.
  The fixed Noto profile replaces Word fonts; paragraph spacing, tabs, pagination and
  unsupported styling are addressed losses. The Word style registry is not retained.
- Decimal and bullet lists retain order, hierarchy, starts/restarts and continuation
  boundaries. Different numbering instances can nest under an existing parent.
  Custom hierarchical labels require explicit conversion to native single counters;
  unsupported number formats require explicit removal of numbering. Additive list
  `start` support is specified in ADR008.
- Rectangular horizontal/vertical table merges, cell paragraphs and rich text are
  retained. Native table appearance is reported as a conversion. Missing references,
  invalid merge continuations and unrepresentable table structures fail or require
  addressed exclusion, with no fabricated blank cells standing in for lost content.
- In-flow static PNG/JPEG becomes an editable image block with width, original bytes
  and alt text. Inline mixed text/pictures split into ordered flowing blocks with a
  warning. Crops, rotation, fill margins and unsupported picture effects require
  explicit exclusion; native Document has no such image capabilities. Floating
  drawings, charts, textboxes and SmartArt require exclusion, never a blank fallback.
- A4/Letter, portrait/landscape and uniform 24–160px margins map to page settings.
  Multiple sections/columns, headers/footers and referenced notes require exclusion.
  Source page count is not promised. Native preview uses the public Document HTML
  renderer, with inert links and embedded images.
- Unresolved tracked changes anywhere in the package stop import; users cannot
  waive this by choosing review or exclusion. Comments/actor/history are excluded.
  Unknown used vocabulary is reported with its actual source part and XML path.

DOCX additionally caps source/native blocks at 2,000 and total logical table cells
at 50,000. See DOCX verification for independent
Writer/upstream fixtures, normal UI, self-export, selective Undo and external edits.
Microsoft Word has not been run in this environment.

## Bounded inspection and source ownership

ZIP methods 0/8, UTF-8 part names, UTF-8 or BOM-marked UTF-16 XML, and OOXML
Transitional are supported. Strict OOXML, ZIP64/multidisk/encrypted archives,
percent-encoded part names and paths with control/space characters are rejected.
Central/local records, data descriptors, actual expansion, CRC, canonical internal
relationships and content-type declarations are checked. DTD/external entities, processing
instructions and active-content relationships/types are rejected. XML has no
network/entity resolver. Unknown used vocabulary produces addressed diagnostics.

Caps: 32 MiB compressed, 128 MiB actual expanded, 10,000 ZIP entries, 8 MiB per XML,
64 XML levels, 200,000 nodes per XML / 1,000,000 total, 256 attributes per element,
100 pages / 10,000 selected/inherited objects, 50,000 cells per slide table,
16 MiB / 32 million pixels per image, 64 MiB unique source images, 1,000,000 native text
characters. Repeated inline images are additionally limited to 128 MiB of data URI
text to bound native serialization; source deduplication cannot create unbounded
repeated native asset text. These are input limits, not performance claims.
Template/pack limits remain stricter and are checked again when saving templates.

Prepared reports and previews are frozen; owned source/options/asset copies and
parser/adapter identity determine planHash. Consent accepts exactly the required
warning IDs for that hash. A copied/forged plan handle fails. Atomic creation returns
the stored matching fingerprint on retry and rejects different input with the same
request ID. No staged asset writes or import-specific persistence store are used.
See ADR007 for additive provenance and
lost-receipt semantics, and verification for the
current acceptance checkpoint. Full Office round-trip and Microsoft Office rendering
are not claimed.

## Reuse as native templates

After reviewing import conversions, edit the new Artifact and choose **Save as
template**. Whole definitions create independent artifacts; selected fragments use
the ordinary checked insertion/proposal/Undo path. Presets remain limited to the
existing native style/configuration capabilities. The GUI exposes text/image/line-list
slots; advanced bindings and deterministic agent execution use the existing Host API.
Image-only imported elements cannot become editable text slots. This does not retain
Office master/style inheritance or support an original Office mail-merge template.

Review fixed content and every sample before saving. Replaced text/list slot samples
also replace the native prototype, avoiding hidden original case text. Original Office
bytes, artifact comments/history, actor/Host data and import provenance are not copied
into a definition; selected fixed content or explicit defaults can still contain case
information. There is no automatic private-data detection.

Portable template budgets are lower than Office import budgets: 8 MiB encoded
characters per image, 16 MiB total manifest assets, 24 MiB UTF-8 JSON per definition,
32 MiB per pack/100 definitions and 64 MiB native expansion. Input within the Office
limits can therefore be refused at template saving. See the [template contract](template-contract.md)
and T01–T06 evidence for human/Host parity, immutable
versions, catalog independence, shared failures and actual external editing.
