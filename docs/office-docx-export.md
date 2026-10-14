# DOCX output API (#12)

`@editor-platform/document-export` converts an owned Document snapshot to native
WordprocessingML. It uses Document flow, independently of Slide/canvas. The API
returns bytes and an addressed loss report; it never changes an Artifact, submits
an operation, downloads a file or adds history. The normal UI is the following #13
checkpoint.

```ts
import { captureDocumentExportSnapshot, prepareDocumentDocx, encodeDocumentDocx }
  from '@editor-platform/document-export';

const snapshot = await captureDocumentExportSnapshot(content, {
  kind: 'confirmed', artifactId, revision,
});
const plan = await prepareDocumentDocx(snapshot, {
  fontProfileId: 'noto-cjk-jp-2.004', styleProfileId: 'document-ja-1',
  mermaid: 'source', previewBlocks: 'source',
}, adapters, signal);
// Display the report and obtain acceptance of its exact required diagnostic IDs.
const result = await encodeDocumentDocx(plan, {
  planHash: plan.report.planHash, acceptedDiagnosticIds,
}, signal);
```

`./plan` excludes the encoder graph. The root imports pinned `docx` **9.6.1** lazily.
Pure entrypoints bundle in Node and browser without React, Slide or an Office library.
The snapshot is cloned before the first await; options, adapter methods, fonts and
assets are owned for the plan. Encoding performs no fetch or new fallback. Plans are
opaque process-local handles; forged plans fail. Errors cannot be waived, and unknown
or stale warning consent is rejected. Cancellation returns no partial bytes.

| Native input | DOCX behavior |
| --- | --- |
| Heading 1–6, paragraphs | Native flowing paragraphs, alignment/indent and exact explicit whitespace. Fixed `document-ja-1` styles; keep-next headings and widow control. |
| Rich runs and links | Bold/italic/underline/strike, opaque portable colors, highlight, code font; HTTP(S)/mailto hyperlinks. Internal anchors become text with consent. Invalid native links/colors are blocked. |
| Lists | Native bullet/numbered levels 0–8, distinct numbering instances at list boundaries. `childLists`/legacy `children` and inherited checklist meaning follow the native engine. Checkboxes become explicit static `[x]`/`[ ]` text with consent. |
| Tables | Native columns, horizontal/vertical/rectangular merges; `cellParagraphs` (including empty arrays) > `cellRich` > `cells`. Covered text is omitted once. Only explicit contiguous full header rows repeat; rows may split across pages without fixed heights. Adjacent tables have an empty separator so Office keeps two tables. |
| Pictures | Owned PNG/JPEG embedded with aspect, width, alt and caption. GIF/WebP become static PNG with consent. Body overflow is proportionally reduced with a diagnostic. Every drawing has a unique ID. |
| Code | Escaped native text with original spaces/tabs/newlines and language label, Noto Sans Mono CJK JP 2.004. No execution. |
| Mermaid / previews | Explicit Mermaid element-PNG adapter or source policy. HTML/React preview is escaped source with consent. Missing/failed renderers and invalid image-mode Mermaid block output. No whole-page rasterization. |
| Page | A4/Letter, portrait/landscape and margin (96 CSS px/in → 15 twips/px). Office controls flow and pagination. |

Document limits are 2,000 top-level blocks, 1,000,000 UTF-16 text units, 50,000 logical
table cells and list levels 0–8. Shared image limits are 16 MiB / 32 million decoded
pixels per image and 64 MiB total unique bytes (both source and converted images).
Invalid input, XML control characters, missing glyphs and failed assets produce
non-waivable preflight diagnostics. Limits never truncate successful output.

Noto Sans CJK JP and the code profile have pinned Regular/Bold binaries, hashes and
common glyph ranges. The reference adapters verify actual files; recipients need
the corresponding fonts. Fonts are referenced, **not embedded**. Word/LibreOffice
reflow can change line breaks and page count; Editor/PDF pagination is not promised.
Heading styles do not override an explicitly authored `bold: false` run.

`blocks` counts conversion units; `details` maps paragraphs/list items/cells/pictures.
Output addresses such as `word/document.xml#p:7` index native paragraphs in document
order, including table/image/empty paragraphs; table row/cell addresses are one-based
physical OOXML indexes. Source IDs stay in the separate report, not Office bytes.
No Room/session, history, actor, annotation or Host metadata is copied. Only allowed
hyperlinks create external relationships; images are embedded. No macro/OLE/altChunk
or external-template parts are created.

Reproduce the corpus with:

```sh
python3 scripts/office/verify-fonts.py
node scripts/office/run-docx-corpus.mjs /tmp/document-corpus
source scripts/office/environment.sh
/usr/bin/python3 scripts/office/render-docx.py /tmp/document-corpus
python3 scripts/office/audit-docx.py /tmp/document-corpus
```

The #12 verification record retains source,
DOCX/report, stable LibreOffice 25.2.3.2 PDFs/all-page PNGs, independent audits and
Node/browser comparisons. The actual unchanged #6 Document is included. The [ordinary DOCX UI](office-export-ui.md#document-docx) now integrates shared guards, Worker cancellation and the production Mermaid image adapter. #13 verification includes external save/reopen edits, the complete local/CI regression suite, cross-browser checks and passing three-repeat performance.
**Microsoft Word has not been tested.**
