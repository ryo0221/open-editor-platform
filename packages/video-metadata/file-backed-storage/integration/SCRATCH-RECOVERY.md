# Private interrupted scratch recovery proposal

Successor to #184, preserving #181/#172/#178/#179 evidence and corrections.
This is a private adapter experiment, not a stable save format or a production
Host change. No Video native/interpretation schema changes are made here.

## Ownership and recovery

Preparation now persists a bounded scratch record before creating a file. The
record owns one random filename, exact operation/capture, captured history head,
phase, and (only after full hashing) archive Pin. It never fabricates a hash or
byte count for an interrupted pre-hash preparation. The scratch namespace Web
Lock serializes preparation, inspection and explicit recovery. The original
journal Web Lock serializes journal publication and operation refusal fences.

`inspectScratch()` returns copied records. A fresh trusted Host may call
`recoverScratch(operationId, signal, authorize)` with current authority. The
callback is rechecked around asynchronous cleanup boundaries. This operation
explicitly discards an unpublished preparation; it does not resume or publish it.
A completed journal candidate is fully reverified before scratch removal. Unknown
or mismatched journal evidence preserves the scratch file. Cleanup removes only
the exact owned filename; missing files after an interrupted removal are harmless.
Durable `cleaning` and `done` phases make this retryable.

Before removing unpublished data, `fenceCapture` records an operation-wide refusal
with the real capture. All journal owners consult this refusal ledger before
writing. The same ID cannot later publish another archive, including after a
process restart. A different capture under that ID is occupied, never no-write.
Refusal failure stays unknown. Prior completed archive files are never rewritten.

Normal successful writes must finish cleanup before reporting committed evidence.
A cleanup failure leaves the actual coordinator indeterminate and retains its
capture. After explicit recovery, `reconcile` can return exact evidence to that
same coordinator. A new process does not reconstruct dead jobs or grants: it
restores the verified selected history and creates a new session. Final pending
entries retain bounded Pin/evidence only, preserving #184's resource release.
The saved history head remains bound to capture; live current/Undo ownership
remains separate and non-destructive.

## Local storage compatibility and limits

- Local journal IndexedDB version advances 1→2 to add `capture-refusals`; existing
  `video-opfs-journal-v0` root and completed OPFS files are unchanged. A fixture
  reconstructs the exact v1 root/store with real completed files, then a new
  browser process exercises upgrade, verification and a fresh save. This is not
  live upgrade certification or registry/archive-format attestation.
- Separate `video-scratch-ledger-*` database, version1, has exact validated fields,
  at most64 records, one unfinished record, and the configured scratch byte budget.
  Refusals and existing journal operations each remain bounded at64. No GC, eviction
  or automatic ID reuse is introduced. Exhaustion fails closed; these are proposal
  limits, not performance or maximum-input guarantees.
- Missing/corrupt existing metadata is never silently reset. A new scratch ledger
  can initialize only with an empty directory. Legacy untracked #181 scratch files
  block new saves and require a separately reviewed ownership/recovery procedure;
  this change does not guess their owner or delete them.
- Foreign scratch files remain intact and block new preparation. Storage eviction,
  concurrent old-version application use, interrupted metadata creation, OS crash,
  power failure and disk failure recovery are not certified. Strict IndexedDB
  transactions are requested, not claimed as cross-store atomic durability.
- Browser close/relaunch tests are explicitly **controlled restarts**, not crashes.
  Raw profiles, synthetic ZIPs, bundles, notices and reports remain under `/tmp`.
- 146MB actual-original integration, normal Video Host wiring and independently
  versioned rational presentation-time registration remain Video-owned follow-ups.
  The48MiB scratch fixture budget is not approval of an actual146MB input budget.

## Functional acceptance mapping

| Requirement                    | Test/evidence scope                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured A + later live/Undo B | Existing #184 five-case regression rerun; no live catalog replacement                                                                                                                                                         |
| Captured head vs other owner   | Existing #184 stale-owner case; captured journal head, no fresh-head CAS                                                                                                                                                      |
| Final resource release         | Actual coordinator capture count and unresolved Project/History ownership reach zero; no heap/performance claim                                                                                                               |
| Pre-journal interruption       | Six fresh-profile tests pause at intent/chunk/closed/ready/cleaning/removed, close browser, reopen same origin, verify old native/original hashes, refuse revoked recovery, retry exact authorized cleanup, fresh scoped save |
| Durable no-write               | Another journal owner replay returns unknown without consuming input; conflicting capture is occupied                                                                                                                         |
| Fail-closed ownership          | Foreign file retained; missing/corrupt ledger retains scratch; corrupt completed candidate prevents cleanup; prior completed bytes remain valid                                                                               |
| Recovery settlement            | Same-process cleanup fault keeps actual coordinator indeterminate; premature reconcile unknown; explicit recovery then exact reconcile releases capture and marks once                                                        |
| Compatibility                  | Cold v1 metadata fixture upgrade preserves journal root, completed original/native and fresh-save behavior                                                                                                                    |

Author verification is separate from independent review. Exact pins and commands
are recorded in the following verification report; no main merge/release follows
from these tests.
