# Development and releases

Open Editor Platform uses main as its integrated public development source. Main
is not a promise that every feature is accepted or that a stable release exists.

## Branches and pull requests

Start short-lived feat, fix, docs or chore branches from main. State the purpose,
owner, scope, dependencies, target branch and validation in the PR. Use a temporary
integration branch only when multiple stages must be accepted together. Record its
included PRs, acceptance criteria and end condition; do not create a permanent
second development stream. Release branches are only for declared release support
or candidate stabilization.

Dependent PRs name their base and final target. Merge parents first and retarget
children to that target after checking for duplicated changes. A stage accepted in
an integration branch is not yet accepted in main. Preserve unfinished branches
until the owner and successor work are identified.

Use merge commits normally. Squash is appropriate only for independent changes
that do not break child PRs or historical references; record the old head and
resulting commit. Do not rewrite main, integration, release or public tag history.
Coordinate any rewrite of a personal work branch with its dependents.

## Review and validation

Record the reviewed head, tested base and actual integration commit or tree,
commands, environment, dependency versions, results and known limits. New behavior,
shared dependency changes and conflict resolutions need review and relevant
regression checks. Explain any reuse of unaffected evidence. Old-head review does
not automatically approve a new head.

Use the developer guide's checks for the affected scope. Automatic Actions and
manual dispatch remain paused until separately authorized. Record local results;
paused CI does not waive validation. Do not require a stopped workflow as a merge
check. Main requires reviewed PRs; force push and branch deletion are prohibited.

Public branches, Draft PRs, comments, logs and assets are public information.
Keep credentials, private links, personal information and confidential reports out
of them. Preserve contributor rights, third-party notices and prior license grants.

## Release labels and GitHub Releases

The public `main` branch is a **development source**, not an automatically published
beta or stable release. Display the repository's actual status prominently in the
README. Do not call a development commit or a planned offering a released product.

| Stage | GitHub Release | Version tag example | README status |
| --- | --- | --- | --- |
| Development / preview candidate | No release required; optional gated OSS preview release | `v0.1.0-preview.1` only if actually released | Development preview; beta not released |
| Published beta | Create a release and check **Set as a pre-release** | `v0.1.0-beta.1` (example; verify version history first) | Beta released, link to exact GitHub release |
| Release candidate | Check **Set as a pre-release** | `v1.0.0-rc.1` (example) | RC / pre-release |
| Generally available (GA) | Publish an approved stable release **without** pre-release flag | `v1.0.0` (example) | GA / stable, link to release |

Use the version scheme that fits the release history, preserving all existing
immutable tags and binaries. A tag, a version number, or a README badge **alone**
does not create a release or change copyright license rights. Do not change an
existing tag to represent different contents. Each release needs the documented
owner approval, provenance/security checks, exact SHA, test results, release
notes and known limitations before publication. Do not create a new GitHub
Release solely to update the README presentation.

**Commercial status is independent of software release status.** Initially show
"Commercial beta: planned / not open" even if a technical preview or beta
release has shipped. Change that text to "Commercial beta: zero-fee under a
signed agreement" only after the separate
[commercial licensing gate](docs/release/COMMERCIAL-OEM-GATE.md)
is completed and agreements are actually being offered. Never use a
"commercial use prohibited" banner: valid AGPLv3 commercial use is free.

Before a GA release that changes the proprietary commercial offer to paid, issue
the complete dated public notice **at least three calendar months and 90 days**
ahead, with GA date, affected scope, pricing approach, beta-customer transition
and downstream treatment, as specified in
[Beta Commercial Policy](BETA-COMMERCIAL-POLICY.md). Link that notice from the
README and the relevant release notes; updating a badge does not start the
notice period. No GA date is currently scheduled. Do not mark a release stable
before the notice interval and release gate are satisfied.

When a release or commercial offering status changes, update the README badges,
plain-language status text and relevant policy links **in the same reviewed PR**
(or before the official release), and verify that all claims match published
release and signed-license status. Do not edit a historical release to change
what license rights its recipients received.

## Releases and recovery

Older publication and export records describe their original snapshot and release
boundaries. Retain their evidence and unresolved rights questions, but use this
guide for current development. Historical references to a private source or a
future visibility change do not authorize restarting synchronization or changing
repository visibility.

Promote a release only with its declared accepted scope, known limitations, source
commit or tag, dependency versions, kernel hash and asset checksums. Keep process
pins, main commits and kernel release tags distinct from application releases.
Publish new tags for new candidates or fixes; never replace an existing public tag
or asset with different contents. Main merges do not authorize deployment or release.

Return release-branch fixes to main, or record why they do not apply. Recover with
reviewed fixes or reverts, preserving public history. Before reverting the choice
of development repository, preserve all work created since the cutover and declare
one intake and merge target. Never restart the old snapshot writer over public work
without reconciling that history first.
