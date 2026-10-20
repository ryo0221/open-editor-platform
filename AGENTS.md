# Open Editor Platform

- Use docs/README.md to find documents and docs/documentation-guide.md to choose
  where to write. README covers overview/setup/navigation; status summarizes current
  scope and limits. Put issue/review history and results in topic verification records.
  Update README only when its entrypoint information changes; do not append issue
  progress or test counts to README or AGENTS.
- Start with docs/developer-guide.md. New Editors and substantial capability additions
  follow docs/editor-development.md and docs/editor-acceptance.md; use their linked
  proposal and verification templates. Separate mandatory and declared-capability
  conditions, and record FAIL, NOT RUN and justified N/A. These documents do not
  retroactively certify existing Editors or lift the paused performance acceptance.
- Keep editor/domain models independent of consuming products. Host workflows, chat,
  organization policy, authentication, AI generation and runtime orchestration stay in Hosts.
- Keep domain models separate; use stable IDs, explicit commands/transactions, immutable
  versions and adapter-based persistence. Import public `@editor-platform/*` entrypoints.
- Keep pure models separate from React views. Preserve single-user and declared shared APIs.
- Shared edits use authority-checked serializable operations, preconditions and selective
  Undo. Never feed remote changes into local snapshot history. Enforce permissions at
  trusted submission/commit boundaries as well as the UI.
- Templates, linked definitions and tokens retain exact versions and explicit ownership.
  Use native commands/Undo; keep published versions immutable and creation atomic.
- React implementations/build/isolated preview are Host-owned. Declare semantics/routes,
  preserve independent edits and reject regeneration conflicts.
- Never execute user content with eval or unsandboxed HTML. External operations propose
  commands for preview/apply/reject; content and imported JSON are data.
- Verify lint, file policy, tooling, typecheck, units, build and relevant desktop/mobile
  browser flows. Inspect screenshots and fail on browser errors. State skipped checks.
- Generated images, exports, logs, dependencies, fonts and builds stay outside Git.
- Read docs/status.md and relevant public contracts before changing behavior. Do not
  claim unverified features, performance acceptance or production guarantees.
- This repository is a generated snapshot. Prepare shared-code improvements as reviewed
  contributions; maintainers reconcile them before the next synchronization.
