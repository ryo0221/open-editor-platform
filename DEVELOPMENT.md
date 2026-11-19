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
