# Video Core — unregistered prototype

Issue #75 M0 proposal and independent M1 Core subset. All APIs and schema are
**provisional v0**, pending owner review; this is not a finished Video Editor.
See [ADR and decision options](docs/ADR-video-m0.md) and [status](docs/status.md).

`src/index.ts` is the provisional entrypoint (import it directly for now).
`package.proposed.json` is an inactive manifest proposal; activating it requires
the integration owner to regenerate the workspace lockfile. `videoCommand(edit)` returns an
existing platform `EditorCommand<VideoContent>` for local EditorSession; callers
must authorize at submission. No separate history, remote operation or Host is
provided. `assertVideoContent(unknown)` rejects unsupported schema/fields.
`evaluateSequence(content, time)` returns exact source requests, not decoded frames.
`probeMedia` wraps an injected Host reader/probe with explicit read budgets, abort,
identity checking and lease cleanup; it does not hash original bytes or decode.

Supported prototype edits: insert, linked move/split/delete, independent trim,
link/unlink, explicit ripple gap insertion and non-crossing ripple deletion,
explicit duration resize. Linked outsiders, locked affected tracks, same-track
overlap, fractional source audio sample edits, missing handles and unsafe rational
arithmetic reject atomically. Caller supplies IDs; commands never invent them.

Tests: `npx vitest run packages/video-core/src`. Root workspace integration is deferred to #76 ownership to preserve `npm ci`. No codec dependency
has been added. No UI/Viewer/AV clock/export/storage/shared/Animation capabilities
are registered. Native recipe JSON alone does not retain playable media.

Opt-in rational audio v1 now has separate `VideoContentV1`, `videoCommandV1`,
`assertVideoContentV1` and `evaluateSequenceV1` exports. Existing names remain v0.
Audio source validity is rational and independent of integer decoded addresses.
See [the boundary ADR](../video-metadata/host-media/file-source/RATIONAL-BOUNDARY-ADR.md)
and [checkpoint evidence/remaining Host and codec gates](../video-metadata/host-media/file-source/RATIONAL-CORE-VERIFICATION.md).
