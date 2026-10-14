# Assets and verification

Tracked files are limited to 1,000,000 bytes unless a reasoned exception is recorded
in large-file-exceptions.json. Generated screenshots, exports, reports and logs remain
outside Git. Ordinary builds and tests use checked-in source fixtures and require no
access to private repositories or historical evidence archives.

## Fonts

Run `npm ci` followed by `npm run fonts:fetch`. Node >=20.19 and Python >=3.10
are required; no pip install is needed. The official Noto CJK Sans2.004 archive and
FontTools wheel are pinned by URL, size and SHA-256 in scripts/office/fonts-source.json.
All four output font hashes are checked at startup, test, build and preview.
Downloaded fonts/cache files are ignored; their OFL notice and manifests are retained.
Set EDITOR_FONT_CACHE or EDITOR_FONT_PYTHON to select a cache or Python executable.

## Fixtures and licenses

The four-color image fixtures are generated geometric samples. Office fixtures retain
CC0-1.0 or MPL-2.0 provenance and adjacent license notices. Dependency notices are
retained under third-party/. Do not remove required third-party author/copyright notices.
Downloaded fonts remain under OFL-1.1 independently of the project's source license.

## Checks

Use the commands in the root README for local checks. No automatic workflows are
included in this initial snapshot; validation and source synchronization are manual.
Optional actual Office rendering uses scripts/office/setup-renderer.sh and the signed,
pinned Debian packages, Python requirements and fonts. Configure EDITOR_OFFICE_DEPS
for your environment. Renderer tools are verification dependencies, not app requirements.
Historical private evidence and its restoration/publication tooling are not distributed.
Scale experiments needing external historical fixtures require separately reviewed input;
ordinary unit/build/browser verification uses the retained source fixtures.
