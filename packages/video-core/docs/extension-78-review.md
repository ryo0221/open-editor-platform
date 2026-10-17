# Video consumer review of proposed Extension #78

Read-only review of exact PR #78 HEAD
`93e4e4d89114e9e45a227637a10130be84ccf49a`,
`docs/extension-contract-proposal.md` and
`packages/extension-contract/src/index.ts`. No branch fetch/merge/cherry-pick,
imports or registration. Token `1.0.0-draft.1` is unapproved and not a dependency.
This is a consumer gap report, not approval or a request to expand current M1.

## Compatible with isolated Core

Domain-owned validator, detached reads, EditorCommand<T>, existing Host session
and element-ID selection fit this lane. No shared time type is required. Host
checks permission on mutation and rejects unsupported capabilities; Video should
retain that behavior and never fall back locally. Trusted in-process restriction
is explicit and must not be represented as sandbox isolation.

## Missing before Video runtime integration

| Need                      | Current #78 contract                                      | Proposed follow-up, pending review                                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Immutable original bytes  | Only artifact read/write/selection permissions; no assets | Separately granted media-read adapter scoped to artifact/ref/hash/length. Open returns exact verified range-reader lease, never credentials or arbitrary URL/fetch. Keep domain media refs outside generic content schema.                |
| Lease ownership/retention | Synchronous mount cleanup only                            | Distinguish short read lease, active runtime ownership and retained original bytes needed by draft/version/Undo/export. Host GC policy must not infer retention from mounted surface or current clips.                                    |
| Asynchronous revocation   | Live permission checks on façade calls                    | Lifecycle AbortSignal/generation event for close, uninstall, replacement and permission expiry, so in-flight readers/jobs stop without another façade call. New reads also recheck authorization.                                         |
| Drain/release             | `mount(...) => () => void`                                | Revoke immediately, then acknowledge async shutdown/drain or register Host-owned async disposables. Document read completion races and idempotent cleanup; do not require async callback work to have finished when sync cleanup returns. |
| Capture/preconditions     | `read(): T`, `save(): Promise<void>`                      | Later snapshot/revision capture after input flush + confirmed/pending guards, immutable media leases and stale async result rejection keyed by artifact/job/generation. No global late callback writing through a new handle.             |
| Resource bounds           | No runtime/media budgets                                  | Typed Host bounds for bytes/read/total/queues/decoded pixels/PCM/decoder count. Explicit unsupported offline/codec states, no backend fallback or remote encode.                                                                          |
| Schema declaration        | Manifest numeric schemaVersion                            | Video v0 uses an intentionally provisional string schema tag. Approve a production schema/mapping separately; do not cast the tag to a number or silently migrate retained content.                                                       |

Recommended scope: leave #78 narrow M1 as proposed. Review a versioned optional
media/lifecycle adapter before M1 runtime integration. Existing local Core tests
need none of these additions. A registered Video Surface that silently reaches
for global fetch/credentials would invalidate the scoped-interface claim.

No authority is granted by a manifest alone. Host trust/provenance checks still
precede importing executable modules. An AbortSignal is cooperative cancellation,
not isolation of malicious code; untrusted media parsers/codecs need separately
reviewed worker/process limits and execution policy. No such backend is installed.

Owner decisions: media capability granularity, lease retention/durability semantics,
async teardown acknowledgment and revocation events. #76 owns the generic lifecycle
contract; #75 owns domain media/time descriptors and codec profile. #74 exact native
closure/Player/API must be reviewed separately before any Animation evaluation.
