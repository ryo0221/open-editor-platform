# Contributing

This repository has independent public Git history and receives reviewed source snapshots.
Issues and improvement PRs are welcome. Maintainers reconcile shared-code changes in the
canonical development source before synchronizing them here; direct edits to generated
files are detected and must be reconciled before a later synchronization can proceed.
Public documentation is maintained through the same export configuration.

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

The `.open-editor-export.json` file records the generated file set, modes and content
hashes. It contains no private source revision or Git author metadata. Maintainers keep
the private source-to-public revision correspondence separately. Synchronization uses
ordinary review PRs, including deletions; it never merges the private Git history or
rewrites the public main branch.

## Licensing and contributions

The planned public source license is GNU AGPLv3-only, with an optional
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
