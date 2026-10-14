# Updating several artifacts

`prepareComponentBatch` accepts one exact component definition/closure and 1–100
unique targets. Each target supplies its native snapshot, trusted actor identity
and explicit adopt/pin/detach selections. It returns the existing native prepared
operation for each artifact, or that artifact's conflict/error. It owns all supplied
data before awaiting. Already adopted exact versions and explicit pins produce no
new operation or Undo entry.

`applyComponentBatch` calls a Host-supplied per-artifact submission callback and
returns individual outcomes. Retrying the returned batch skips known successes
and reuses the same prepared operation/request for each unfinished artifact. A
changed dependency still rejects; retry never regenerates a different preview.
Mapping conflicts require a new explicit preview in the affected artifact's
ordinary component Inspector. There is no distributed transaction or global Undo.

The Host callback must enforce current permissions and deduplicate requests at its
existing authority or local-session boundary. The normal playground uses existing
shared proposal tokens/authority receipts and existing local EditorSession commands.
Its local receipt records live only in that running Host: they distinguish an
already-applied edit from a failed IndexedDB save. Retrying such a failure persists
the current artifact without executing the command twice. A reload opens the last
successfully stored artifact; these in-memory records are not a production durable
distributed receipt service.

The **複数の成果物の部品を更新** dialog discovers versions in the existing catalog,
lets the user choose outcomes for each current Host artifact, and displays changed
values, preserved fields, native appearance and individual apply results. Independent
artifacts can succeed while another is stale, unavailable or denied. The reference
Host includes its local artifacts and the active shared artifact; discovering and
authorizing additional remote artifacts belongs to the embedding Host. Closing a
dialog does not cancel an already submitted operation; reopen the artifact to inspect
its adopted version. Each artifact retains its own Undo and body edits.
