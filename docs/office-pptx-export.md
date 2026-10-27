# PPTX output API (#10)

The Slide-specific encoder accepts the immutable plan from #9 and returns bytes plus a loss report. It does not download, save a version, edit an Artifact, resolve a new asset or submit an operation. The [ordinary dialog and shared-session boundary](office-export-ui.md) are implemented and verified in #11, including full regression and three-repeat performance checks.

```ts
import {
  captureSlideExportSnapshot,
  prepareSlidePptx,
  encodeSlidePptx,
} from '@editor-platform/slide-export';

const snapshot = await captureSlideExportSnapshot(content, {
  kind: 'confirmed',
  artifactId,
  revision,
});
const plan = await prepareSlidePptx(
  snapshot,
  {
    pageIds: 'all',
    includeHiddenSlides: false,
    includeNotes: false,
    fontProfileId: 'noto-cjk-jp-2.004',
    fallback: 'element-png',
  },
  adapters,
  signal,
);
// Present every diagnostic and obtain the caller's policy decision for this exact plan.
const result = await encodeSlidePptx(
  plan,
  { planHash: plan.report.planHash, acceptedDiagnosticIds },
  signal,
);
if (result.status === 'ok') host.download(result.bytes, result.mime);
```

An error cannot be waived. Every current warning must be accepted; stale hashes, unknown diagnostic IDs, incomplete consent and a copied/serialized handle do not encode. Node and browser each prepare their own process-local plan. The report can be serialized; the handle and owned asset bytes stay in the preparing process/worker. `outputPartNames` maps source addresses to `ppt/slides/slideN.xml#synthetic-object-name`. Host IDs appear only in the separate report, never generated Office object names or metadata. Empty text objects remain editable text boxes.

For consumers that only preflight, `@editor-platform/slide-export/plan` excludes the encoder graph. The root encoder entry imports PptxGenJS lazily. Domain/core entrypoints contain no PptxGenJS types or dependency. The browser application loads the encoder in a dedicated Worker only when the ordinary PPTX action is used.

## Verified mapping and explicit limits

| Source                                               | Representation                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Japanese/Latin text and rich runs                    | Native text; shared fit size, line breaks, run order and padding. Separate line boxes are reported. No Office autofit. The first baseline excludes extra paragraph leading already applied by the shared line layout.                                                            |
| 13 declared shapes                                   | Native preset or custom vector paths. Shape approximations are reported; custom dash lengths, rotation, flips and opacity are retained.                                                                                                                                          |
| Other 12 shapes, chart                               | A separately consented PNG for that element. Cubic extrema and stroke outset are included; cloud edges are not cut off.                                                                                                                                                          |
| PNG/JPEG                                             | Original embedded binary with native `srcRect` crop. Fit letterboxing, crop placement and transforms apply once.                                                                                                                                                                 |
| GIF/WebP                                             | Decoded static PNG; animation/crop editing losses are diagnosed. No invisible replacement for a failed image.                                                                                                                                                                    |
| Unmerged, axis-aligned, opaque Slide table           | Native table with fixed cell dimensions and insets, no automatic extra slides. Header/body fills and cell text are retained.                                                                                                                                                     |
| Merged, rotated, mirrored or translucent Slide table | Element PNG or a blocking diagnostic. The fixed LibreOffice renderer rotates native table borders without correctly rotating cell text/fills, including inside a native group. It also ignores native table border alpha. Failed probes were retained.                           |
| Mirrored text, visibly clipped text                  | Element PNG or a blocking diagnostic; Office keeps native text readable instead of mirroring its glyphs.                                                                                                                                                                         |
| Italic text requiring the reference PNG adapter      | Blocking `RASTER_TEXT_STYLE_UNSUPPORTED`. The pinned Regular/Bold SVG renderer cannot synthesize italic, so it must not silently remove the slant. Native italic text is supported and rendered in Chromium/LibreOffice. Hosts can supply a verified alternative raster adapter. |
| Groups/hidden objects/pages/notes                    | World-coordinate children in paint order; group loss and exclusions reported. Notes are opt-in; hidden-page inclusion loses the hidden flag with a warning.                                                                                                                      |

`slidePptxCapabilities` declares 100 slides, 10,000 objects, page sides 100–3840 CSS px, the 13 shapes and the table/text transform limits above. Image limits are 16 MiB each, 32 million decoded pixels and 64 MiB of resolved assets in total. Decoder failures remain errors even below those upper bounds. Unknown colors, glyphs, invalid geometry/selection and fixed-row text overflow stop export. Page geometry is 96 CSS px/in, 0.75 pt/px and 9525 EMU/px.

The rotated/mirrored/translucent table limitation refines the initial design's native-table capability; ordinary opaque unmerged tables remain native. The mapper does not silently flatten every table, flatten a page or change representation during encode. This limitation must remain visible in the #11 dialog and release report.

## Fonts and adapters

The checked-in [font manifest](../apps/playground/public/office-fonts/manifest.json) pins **Noto Sans CJK JP 2.004 Regular/Bold** to exact OTF binaries, the source TTC hashes, verified common cmap ranges, the extraction version and OFL notices. `scripts/office/verify-fonts.py` checks the actual files and representative Japanese glyphs. `prepareOfficeFonts` copies and hashes the binary inputs before giving a process-local font bundle to raster adapters. Browser `FontFace` and LibreOffice's private fontconfig use these same files.

Font naming in PPTX is a reference, **not font embedding**. Recipients need the font. Native Office and browser shaping can differ around Japanese punctuation and Latin italic advances; `TEXT_REFLOW_RISK` is retained. Current verification concerns Japanese horizontal/Latin text; it does not certify every Unicode script or every glyph's appearance.

- `@editor-platform/office-adapters/browser`: bounded CORS/data/blob image loading, bitmap validation/conversion and installation of owned font faces. Reference HTTP requests omit credentials and have a 10-second timeout. Hosts can replace the loading policy.
- `@editor-platform/office-adapters/node`: the Host supplies authorized bytes; the adapter performs no file/URL lookup. Native image decoding runs in a child process with time/output limits. A truncated PNG was shown to crash the native decoder; the child-process boundary converts that failure to a normal preparation error without terminating the Host. A worker thread would not isolate that crash.
- `@editor-platform/slide-export/raster`: the same pinned SVG/WASM renderer and font buffers in Node/browser. It receives an unrotated, unflipped, opacity-1 drawing; the Office picture applies the original outer transform once. It never resolves an external image while rendering.

PptxGenJS 4.0.1 (MIT), fflate 0.8.3 (MIT), color-name 2.0.0 (MIT), resvg-js WASM 2.6.2 (MPL-2.0) and the Node-only @napi-rs/canvas 0.1.100 (MIT) are pinned. [MPL license](third-party/resvg-js-MPL-2.0.txt), [PptxGenJS license](third-party/pptxgenjs-MIT.txt), [canvas license](third-party/napi-rs-canvas-MIT.txt). Unmodified resvg-js source is available at [tag v2.6.2](https://github.com/yisibl/resvg-js/tree/v2.6.2); the WASM binary is distributed by that package. Native canvas stays out of browser bundles. LibreOffice is only a verification tool, not an application/runtime requirement.

## Reproduction and current status

```sh
npm ci
python3 scripts/office/verify-fonts.py
node scripts/office/run-pptx-corpus.mjs /tmp/pptx-corpus
bash scripts/office/setup-renderer.sh
source scripts/office/environment.sh
/usr/bin/python3 scripts/office/render-pptx.py /tmp/pptx-corpus
# Python verification libraries: scripts/office/requirements.txt
python3 scripts/office/audit-pptx.py /tmp/pptx-corpus
```

Renderer setup targets Debian 13 amd64 and LibreOffice 25.2.3.2. It downloads signed, version-pinned Debian snapshot packages, checks the archived hashes, extracts locally and supplies the registry link normally created by Debian's maintainer script. A separate extraction directory was tested through UNO load/render. It neither changes system package state nor disables TLS/signature validation. The historical snapshot explicitly disables its time-based Release expiry check while retaining signatures.

The fixture source is [pptx.ts](../tests/fixtures/office/pptx.ts); the corpus also exports the unchanged **10-page** #6 practical Slide and a two-page portrait/notes case. Browser and Node report semantics/native slide XML have been compared on the public API. Encoder evidence records 404 unit tests, 12 related production browser cases and the full 19-page fixed-renderer corpus with independent XML/geometry audit. The ordinary UI and shared-session tests now pass, and fixed LibreOffice has edited text/shape/table/image through its own API, saved/reopened and rendered all seven edited golden pages. The #11 checkpoint at `db4d43c` passes 408 units / 165 production browser cases in CI, all 19 Office pages and three-repeat G14/Slide interaction goals. **PowerPoint has not been tested.**

The planner and encoder are split into small steps without output changes; see complexity verification.
