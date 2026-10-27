# Office export in the ordinary editor (#11 / #13)

Slide's existing visual export menu includes **Export PPTX**. The modeless dialog
selects all/selected pages, hidden pages, speaker notes, the fixed Japanese font and
the policy for unsupported elements. It shows editable/picture/excluded/error counts,
addressed diagnostics, navigation to the affected page/element and a downloadable
loss report. Reports are paginated to keep large decks responsive. Minimize retains
the preview; close/Escape cancels the job.

Every required warning is accepted for the current plan. Errors cannot be waived.
Changing options removes prior consent; Refresh captures the newest content and
assets and requires consent again. A subsequent local/remote edit does not alter the
prepared output. The source revision and a changed-artifact notice explain which
content will be exported. The recipient needs Noto Sans CJK JP 2.004; fonts are not
embedded. [Declared native/fallback limits](office-pptx-export.md) apply in the dialog.

Preparation and encoding run in one dedicated Worker. The opaque plan, resolved
images, font buffers and renderer stay there. Cancel terminates the Worker, including
during native encoding/compression, and suppresses late downloads. The editor remains
usable; a minimized dialog exposes the covered inspector. Fonts and the Office
encoder/renderer are loaded on demand. SVG/PNG/PDF keep their existing paths.

## Host boundary

`@editor-platform/office-export-ui/host` is a small React boundary with no encoder
import. Both the playground and independent Host wrap their existing surface:

```tsx
<OfficeExportHost
  guard={existingExportGuard}
  capture={() => ({
    content: session.confirmed.content,
    basis: {
      kind: 'confirmed',
      artifactId: session.confirmed.artifactId,
      revision: session.confirmed.revision,
    },
    name: artifact.name,
  })}
  fontManifestUrl="/office-fonts/manifest.json"
>
  <SlideSurface {...surfaceProps} />
</OfficeExportHost>
```

The Host reads the content and revision synchronously from the same current session.
Its guard retains the existing pending/rejected/proposal rules. The reference boundary
also blocks unfinished composition and private local canvas text buffers; those buffers
must commit or cancel before capture. Toolbar focus no longer detaches a composing
canvas editor. Shared text continues through its existing text engine and pending count.
Guards are checked again before encode/download without replacing the prepared plan.
This is a read-only export; it creates no operation, Undo entry or saved version.

Hosts supply the font assets and bundler/Worker support. Standalone surfaces without
Artifact integration use an explicitly local `standalone-slide` basis; product Hosts
should install the boundary above to supply actual lifecycle identity and policy.
Headless callers continue to use the same public `slide-export` APIs from #9/#10;
there is no agent runtime, organization policy or new shared protocol in this package.

## Verification checkpoint

Additional production cases cover template → ordinary edit → PPTX vs Node API,
the golden/actual #6/portrait corpora, independent browser peers and independent Host,
fixed revision after remote changes, pending/rejected/proposal blocks, synthetic IME
event retention, asset ownership/refresh/failure, cancellation/retry and 390/768px UI.
OS-native Japanese IME and PowerPoint remain untested.

All 19 ordinary-UI output pages also load/render/audit with fixed LibreOffice.
`scripts/office/edit-pptx.py` changes Japanese text, a separate native shape, a table
cell and an image through UNO, saves/reopens PPTX and verifies untouched content and
geometry. All seven reopened pages were visually inspected. This does not edit OOXML
directly. At `a5830bc`, CI and local production suites passed all 164 browser cases;
CI passed 408 units and the 19-page Office job. Three-repeat G14 and original Slide
interaction budgets pass. A subsequent independent-Host control-style fix passes
18 Firefox/WebKit and 9 Chromium cases, including 390px Host output. Final `db4d43c`
CI passes 408 units / 165 browser cases / 19 Office pages, and all three performance
repetitions meet the original standard-fixture goals. Raw evidence is tracked in the
#11 verification record.

## Document DOCX

Document's existing **Export document → Export DOCX** menu opens the same style of
modeless panel. It selects the fixed body/style profiles and Mermaid image/source
or HTML/React escaped-source policy. Diagnostics navigate to the corresponding block.
The recipient also needs Noto Sans Mono CJK JP 2.004 for code. HTML/Markdown/PDF
exports retain their existing paths. The public headless contract is
`@editor-platform/document-export`, including its encoder-free `./plan` entrypoint.

The same `OfficeExportHost` wraps `DocumentSurface`. It accepts
`codeFontManifestUrl` (default `/office-fonts/mono-manifest.json`) and
`mermaidFrameUrl` (default `/office-mermaid.html`). Hosts serving image-mode Mermaid
must provide that trusted, same-origin auxiliary page, importing
`@editor-platform/office-export-ui/mermaid-frame-page`, and the restricted CSP shown
in the playground HTML. This page runs fixed-font Mermaid DOM layout; a Worker
rasterizes the resulting SVG with resvg. Artifact HTML/React is never executed.

The reference image renderer accepts at most 50,000 Mermaid source characters and
32 million output pixels. It rejects embedded configuration/frontmatter, external
resources/links, foreignObject and script/event content. Unsupported diagrams can
use the explicit source-text policy. Source/native limits remain in the public
[DOCX contract](office-docx-export.md). Closing/cancelling removes the auxiliary
frame and terminates the Worker, including compression. A failed renderer is cleared
before retry. DOCX and PPTX encoders remain outside the initial editing bundle.

Shared captures use confirmed content/revision, with pending/rejected/proposal and
unfinished-composition guards before prepare/encode/download. A later remote edit
leaves the captured output unchanged; refreshing rechecks and removes consent.
Document's existing proposal text-engine remount disposes any export job; the
proposal surface cannot export until resolved. Export creates no editor operation,
Undo entry or version. #13 evidence records normal
UI/API parity, all-page Office output, actual external edits and the completed full
regression/performance checkpoint at `c82c77e`: 436 units, 185 production E2E cases,
24 Firefox/WebKit cases and all three performance repetitions pass. Native OS IME and Microsoft Word are untested.
