# Contributing

This repository has independent public Git history and receives reviewed source snapshots.
Issues and improvement PRs are welcome. Maintainers reconcile shared-code changes in the
canonical development source before synchronizing them here; direct edits to generated
files are detected and must be reconciled before a later synchronization can proceed.
Public documentation is maintained through the same export configuration.

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
