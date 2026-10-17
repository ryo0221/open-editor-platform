# Private browser storage candidate

Independent follow-up to #170; **not Video product integration or an adopted
format/API**. Only this directory is new. The Node target corrections in #172
remain a separate review/adoption gate; this adapter does not execute that target.
No dependencies, Host registration, browser-host, bundle/import or codec changes.

## Protocol and ownership

`BrowserJournal.open(namespace, quota, verify, authorize)` owns a private OPFS
directory and one IndexedDB journal. Secure-context OPFS, Web Locks and IndexedDB
are required. The Host exclusively owns the namespace and supplies fresh authority.
Neither stored captures nor journal restoration recreate expired grants.

1. The Host captures the existing SaveCoordinator operation and complete
   `SaveCapture` (scope, revision, content hash), expected archive SHA-256 and length.
2. `chunksFromReader` adapts an asynchronous range reader to bounded, copied 64KiB
   chunks. `save(pin, expectedHead, chunks, signal)` checks operation reuse, expected
   head, authority, configured cumulative quota and unsettled work under a Web Lock.
3. Persist intent, write a fresh candidate file, close it, then have the trusted Host
   verifier validate the **complete archive/native closure and exact hash**. Merely
   checking length is insufficient. Record prepared status only after verification.
4. Recheck authority, then atomically change committed status/current/head in one
   strict-durability IDB transaction. The old file remains untouched. An interrupted
   transaction or lost acknowledgement is resolved by later inspection, never guessed.

OPFS and IndexedDB are separate resources, not a filesystem transaction. This is
an explicitly **new-candidate + journal selection** workflow, not atomic overwrite
of a user-selected file. No automatic rename/download or file-picker capability is
claimed. Cooperative same-origin locks protect participating adapters, not hostile
same-origin code. Host must quiesce operations before `close()`.

After a real browser restart, `reconcile(operationId)` verifies the retained bytes.
Committed results return saved without selecting an older operation again. Prepared
results return ready; only explicit, freshly authorized `resume` selects them.
Intent/missing/tampered candidates stay unknown. `abandon` is an explicit authorized
recovery decision that deletes only unpublished staging and records aborted before
returning not-written. It cannot delete a committed candidate. Missing/corrupt
journals cannot silently initialize over existing storage.

## Existing Video bridge

`writeEvidence(result, expectedPin)` compares the entire pin and maps only verified
saved to the existing `WriteEvidence.committed`, and definitive not-written to
`no-write/never-writes`. Ready, stale, mismatch and unknown remain unknown. This
function accepts trusted adapter output only, never extension-provided evidence.
The existing coordinator still owns claims and exact revision `markSaved`; a later
draft is not marked saved by completion of an older capture. No second Undo exists.
The Host retains its WriteRequest/content until settlement and, on restart, must
validate/decode the archive and correlate captures before reconstructing any claim.
That coordinator integration is **not implemented or certified here**.

An asynchronous Reader is not a synchronous Blob. First stage and validate it;
`lease(operationId)` then yields the same completed OPFS `File`, zero-copy Blob
slices and bounded asynchronous reads. Completed files are never rewritten/deleted
by this adapter, so a subsequent save cannot change earlier leased bytes. Retain
the lease through media/import/save work. `release()` refuses later access and
late asynchronous read results; it cannot revoke a File/Blob already handed to a
caller. Whole-file ArrayBuffer materialization is not used by this adapter.

## Boundaries and budgets

- Candidate limits (proposals, not capacity/performance promises): 8GiB per file,
  16GiB maximum configured cumulative reservation, 64 retained operation records,
  64KiB reads/writes. Committed and unresolved candidates consume quota; no GC or
  automatic deletion of old versions. A separate retention policy is needed.
- Browser disk quota, origin eviction, filesystem durability and abrupt power loss
  are not guaranteed. No persistence permission is silently requested. Strict IDB
  durability is used; successful browser restart evidence is not a power-loss claim.
- General streaming browser ZIP/SHA/native verification is a Host dependency. The
  test Host verifies every chunk of exact, independently hashed synthetic fixtures;
  it is **not** a generic archive verifier or Video native round-trip proof.
- No external service, telemetry, private position, real media or credentials used.
  No Windows certification, user-PC permissions, UI acceptance, performance test,
  CI enablement, release or integration is included.

Platform references: [OPFS writable close behavior](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable),
[IDB transaction durability](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction),
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).

## Local functional checks

```sh
node packages/video-metadata/file-backed-storage/browser/check.mjs /tmp/video-browser-fresh-run
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage/browser
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Use a fresh output directory. `check.mjs` starts a local-only controlled Host and
persistent cloud Chromium, then closes and starts distinct browser processes on
the same profile/origin. It retains reports/screenshots outside Git. Mid-write
interruption is a browser process exit, not an OS power cut. QuotaExceededError is
an injected platform failure during real OPFS writes; configured quota rejection
is tested separately. No timing measurement or throughput assertion is made.
