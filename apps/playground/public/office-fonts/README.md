# Fixed Office font files (downloaded, not tracked)

After `npm ci`, run `npm run fonts:fetch` from the repository root. Node 20.19+
and Python 3.10+ are required; pip/system Python installation is not modified.
The [source lock](../../../../scripts/office/fonts-source.json) pins the official
Noto Release archive and the pure Python FontTools wheel with sizes and SHA-256.
With an HTTPS proxy, the downloader uses the system `curl` and its existing trust
configuration. `EDITOR_FONT_PYTHON` may select a Python executable;
`EDITOR_FONT_CACHE` may select the verified download cache.

Existing matching font files require no network or Python process. Missing files
are extracted into a temporary directory, verified against the unchanged manifests
and then installed. An existing wrong hash stops instead of silently replacing it.
`npm run fonts:check` verifies all four faces. Dev/build/preview and Office corpus
commands include preflight; there is no substitute font.

Both profiles are Noto CJK 2.004 under the retained [OFL notice](COPYRIGHT.txt).
`manifest.json` is the proportional Japanese face (TTC face 0);
`mono-manifest.json` is the Japanese monospace face (TTC face 5) used for DOCX code.
The historical files originated in signed Debian `fonts-noto-cjk` TTC files;
the official `Sans2.004/03_NotoSansCJK-OTC.zip` contains byte-identical TTCs. Each manifest
pins source SHA-256, extracted file SHA-256 and the shared Regular/Bold cmap.

`python3 scripts/office/verify-fonts.py` checks every binary/family/version/weight,
Japanese glyphs and the common cmap. It also checks equal Latin advances in the
monospace profile. `extract-mono-fonts.py /path/to/original/ttc/directory` reproduces
the monospace files with FontTools 4.61.1, without changing the expected hashes.
The monospace extraction materializes the cmap before saving; the proportional
extraction retains the unmaterialized cmap. Both details are reproduced by
`scripts/office/extract-office-fonts.py`. Font timestamps are preserved.

These files support trusted preflight and verification rendering. Office output
references their families; it does not embed the fonts in PPTX/DOCX.
