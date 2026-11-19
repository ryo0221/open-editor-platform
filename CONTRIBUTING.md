# Contributing

This repository is the canonical public development source. Open new issues and
reviewed pull requests here. Follow [development and releases](DEVELOPMENT.md) for
branch roles, dependencies, validation and release promotion. Keep confidential
reports, credentials, personal information and private repository references out
of public issues, drafts and branches.

Use the [documentation index](docs/README.md) and
[writing policy](docs/documentation-guide.md) to select the update location.
Keep README focused on overview/setup/navigation, status on current capabilities
and limits, and detailed results in the corresponding verification record.

Follow AGENTS.md and the verification commands in README.md. Keep product-specific
integrations outside core packages. Preserve third-party notices and asset provenance.
Never add credentials, personal data, generated verification output or private links.

For a new Editor or a substantial capability addition, start with the
[developer guide](docs/developer-guide.md), follow the
[development guide](docs/editor-development.md), and review the
[acceptance criteria](docs/editor-acceptance.md). Use the linked design and
verification templates to declare scope, compatibility, Host responsibilities,
evidence and limits. Record skipped or failed checks explicitly. Do not claim
shared editing, format fidelity or performance from a local-only demonstration.
For documentation-only changes, verify references, formatting and snapshot inclusion;
application tests are required when behavior or API changes warrant them.

The historical `.open-editor-export.json` records the final imported snapshot,
not changes made by normal development after the cutover. Do not regenerate it for
ordinary PRs. The old snapshot synchronization path is retired and must not
overwrite public changes. Existing public commits, tags and release assets remain
unchanged.

## Licensing and contributions

The public source license is GNU AGPLv3-only, with an optional
**separate commercial/OEM license** for users requiring rights beyond AGPL.
AGPL allows fee-based software and SaaS when its terms are met. Earlier MIT
grants remain valid for copies lawfully received under MIT.

Code PRs need a rights/provenance review, and before accepting code intended
for dual licensing, maintainers must obtain written permission enabling both
AGPL and alternative commercial sublicensing, including required patent rights.
See [CONTRIBUTOR-LICENSING](CONTRIBUTOR-LICENSING.md). An unauthorised upstream
relicense of third-party contributions is never allowed.

Independent Editors may be developed without submitting a PR. The proposed
additional permission for proprietary extensions is **not effective yet**;
the legal scope of a combined work depends on its architecture and licenses.
