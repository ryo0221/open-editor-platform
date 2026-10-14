# Reusable content and Office

PPTX and DOCX export the currently adopted native appearance, including resolved
token colors and component text/images. Publishing a later library version does
not change a pinned Artifact or an export snapshot. Adopt a reviewed revision in
the Editor before exporting its new appearance.

An Artifact with retained instances or an Artifact token mode reports
`REUSABLE_LINKS_RESOLVED`. Download requires acceptance for that exact export plan.
The Office file does not retain library links, token mode switching, public
variant controls or typed slots. Component properties are ordinary supported
native Office content; the original native Artifact remains unchanged. Copy-only
Artifacts without retained token-mode metadata have no reusable-link diagnostic.

Limited Office import produces a new native Artifact. It can retain the supported
text, images, notes and appearance; it cannot reconstruct the original reusable
definitions, input ownership or links. Use a native pack for those requirements.
The existing [Office import limits](office-import.md) and V2.1 fidelity tables
still apply. In particular, the fixed LibreOffice-edited Slide fixture adds a
transition extension: import initially stops and proceeds only after explicit
exclusion of that addressed transition.

R15 evidence includes a single
brand used by Design, Slide and Document, pinned/new native files, actual
LibreOffice opening/rendering/editing/reopening, loss reports, ordinary export UI
and six limited reimports. It certifies the fixed LibreOffice/font environment;
it does not certify Microsoft Office or unrestricted Office round trips.

Reproduce the fixed corpus after the existing Office setup:

```sh
node scripts/office/run-linked-corpus.mjs test-results-office-linked
source scripts/office/environment.sh
python3 scripts/office/verify-linked.py test-results-office-linked
# Use the existing verification Python environment with requirements.txt installed.
python3 scripts/office/audit-linked.py test-results-office-linked
node scripts/office/run-linked-corpus.mjs --import test-results-office-linked
```

CI runs these checks in its fixed Office job and uploads the complete corpus.
