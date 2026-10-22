# Dependency security scope for the source Preview

This record concerns the repository's declared integrations, not every API in
an installed dependency. Raw audit findings remain visible. A later dependency,
Host integration or viewer change requires a new assessment.

Mermaid is pinned to 11.17.2 in the root, Document and Office UI workspaces.
KaTeX is overridden to 0.18.2. These changes address the reported Mermaid and
transitive parser/lodash findings and the KaTeX inherited-option issue. Keep
normal diagram, math and Office rendering regression coverage.

The playground build uses Mermaid's core ESM entry. Its prebundled minified
entry embeds older KaTeX and DOMPurify implementations, so a lockfile override
alone does not patch that emitted code. Verify the actual module graph contains
`katex@0.18.2` and `dompurify@3.4.16`, and exercise a math label through the
ordinary Document editor after any entrypoint change.

The 2026-10-18 follow-up found that the previous lock still installed nested
`mermaid@11.12.0` in Document and Office despite their patched manifests. Removing
those obsolete records and regenerating the lock eliminates their old parser,
lodash and KaTeX branches. A fresh `npm ci` resolves Mermaid 11.17.2 from all three
workspaces. Raw production audit changes from 12 package records (4 high, 7 moderate,
1 low) to three high records at that checkpoint; the PDF.js update below supersedes
that count.

`scripts/dev/dependency-security.mjs` rejects mismatched lock copies and inspects
the actual Vite main/worker module graphs. Builds emit `dependency-security.json`
and worker inventories outside Git, checking installed package versions, Mermaid's
core entry and absence of `image-size` and PDF viewer/scripting modules. The tooling
suite also bundles the pinned Node PPTX entry with an esbuild metafile to check
that export path. The retained runtime notices already contain the corrected
versions and are preserved. See the [verification record](../verification/issues-29-260-278/README.md).

## Public dependency gate follow-up (2026-10-19)

Export, check and sync now query current npm advisories (including dev/optional
dependencies) and OSV for pinned Python tools and crates.io lock entries. Any
finding or unavailable scanner blocks the operation. See the private export
procedure for remediation and verification requirements; no exception is inferred
from an unreachable code path.

Manifest/lock checks cover npm peers and reject nested npm locks/shrinkwrap files.
Cargo manifests and locks require TOML validation (Python 3.11+); nontrivial Cargo
graphs additionally require locked/offline metadata resolution before OSV queries.
Missing FontTools wheel versions block rather than silently removing the query.

The former image-size disposition is superseded by an explicit **2.0.4** override.
PptxGenJS remains 4.0.1, now also explicitly declared at the root for its existing
Node tooling entry and consistent workspace override resolution. Its unused parser
must still stay out of emitted main/worker/Node export graphs. This removes the
two old image-size and propagated pptxgenjs audit records without downgrading
PptxGenJS or suppressing advisories. The fresh live gate now passes with zero npm
findings, including development/optional dependencies, and zero OSV findings for
the three pinned Python tools. See status for regression results and scope.

The full development audit also required Vite **6.4.4**, Vitest **4.1.11** and
TypeScript ESLint **8.71.2**. Python's pinned PyMuPDF moves from 1.26.6 to **1.26.7**
for GHSA-cxqh-p2w9-fmr7. Fonttools and Pillow remain pinned and are checked by OSV.
The intermediate Vitest 3.2.7 update still failed the live gate for
GHSA-82fw-gwwq-j7x9 and its vulnerable tinypool dependency. Vitest 4.1.11 fixes
the mocker issue and removes tinypool from the resolved tree; no advisory is waived.

## PDF.js security update (2026-10-19)

Root and Review surface dependencies now pin `pdfjs-dist@6.2.108`, the first
patched release for CVE-2026-16633 / GHSA-hq66-cqwq-w95j. The lockfile also updates
its optional canvas dependency and removes its obsolete readable-stream adapter.
Node 20 is no longer supported: the engine requirement follows PDF.js
(`>=22.13.0 || >=24`); CI and development instructions use Node 24.19.0.

The File surface retains the custom `getDocument`, page canvas and `TextLayer`
integration. PDF.js removed its eval-based compiler and `isEvalSupported` API;
the obsolete option is removed. The removed viewport rectangle API is replaced
with two `convertToViewportPoint` calls, preserving region coordinates across
zoom and rotation. The File surface does not load the standard viewer,
`PDFScriptingManager`, QuickJS sandbox or a JavaScript-action executor. Do not add
`enableScripting` as an unsupported core API option. Build checks now verify the
PDF.js version in both the lock and emitted module graphs, rejecting stale nested
copies or workspace declarations as well as viewer/scripting runtime imports.
The existing scripted-PDF browser regression must render without executing its
document action. Validation results are recorded in [status](../status.md).

## References

- [PDF.js upstream advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)
- [KaTeX advisory and patched version](https://github.com/advisories/GHSA-238p-pmpm-9mq7)
- [Image-size advisory metadata / unpublished patch review](https://github.com/github/advisory-database/issues/9028)

These statements do not certify third-party freedom from all vulnerabilities,
patents or license obligations. Browser cases and emitted dependency inventory
are part of the candidate's recorded verification, not presumed completed by
this document.

## 2026-10-22 tooling updates

Vitest and its existing dependency family are pinned to 4.1.12 for
GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp. These are test/development
dependencies; the public security gate includes them. Office verification tooling
uses Pillow 13.0.0 and Python >=3.11 for the 12.3.0 advisories fixed by that release.
Pillow is used by image-fixture and rendered-Office audit scripts, not browser
runtime code. Existing approved image/Office bytes and third-party notices are
preserved. This does not certify untrusted input processing or other software.
