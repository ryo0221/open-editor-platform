# File-backed portable Video storage candidate

Private, unregistered Node reference implementation for #75. Base #168 HEAD
`5b260e6013e9b678793c5625ab94a32aea729fc7`, tested product
`ffc4e560403bbf48c5c1e6053f5da63682191abe`; reviewed correctness foundation #164
`e450b45f27f7dcc4ad5c2307e493377328efc0f3`. Read the existing
[contract revision](../host-media/CONTRACT-REVISION.md),
[review fixes](../host-media/REVIEW-FIXES.md) and
[product workflow](../host-media/PRODUCT-WORKFLOW.md).

This adds only this directory. It does not change the browser Host, import limits,
VBP0 bundle, codec, SaveCoordinator, package exports, dependencies or shared schema.
It is an adapter proposal and reviewable executable candidate, not an adopted
portable format or a claim that the existing product can import large videos.
No public API compatibility promise is made.

## Ownership and proposed integration

The Video owner retains all existing Host/import/bundle/codec files. The storage
workstream owns only `file-backed-storage/**`. Before any integration, the owner
must review these proposed private boundaries:

1. Host flushes inputs, checks authority and obtains the existing immutable save
   capture. It supplies `Project`: full selected/retained `ArtifactVersion` roots,
   matching `SaveCapture`, operation ID, pinned interpretation plans and immutable
   original `Reader` capabilities keyed by their actual SHA-256. Metadata is
   copied before asynchronous work. The Host retains all readers until settlement.
2. `prepareProject` independently validates every native root/hash, parent chain,
   source interpretation and exact original closure. It hashes bounded original
   ranges before writing. The existing pinned pure `prepareImportSet` is imported
   read-only to validate the interpretation/native agreement; there is no codec
   execution, media probe, file picker, URL resolution or implicit capability grant.
3. `FileTarget.save(project, signal)` streams to a sibling staging file, syncs it,
   reopens its bytes through a range reader, validates the whole portable closure,
   computes its exact archive SHA-256, then closes and atomically renames it. The
   default Node backend also syncs the directory. All writes are awaited, including
   partial writes; no accumulating queue, whole-archive Blob or ArrayBuffer exists.
4. Adapt the result to the **existing** Storage/SaveCoordinator: `not-written` is
   definitive only before the commit attempt; `unknown` retains the capture and
   blocks new saves on this target. `reconcile(operationId)` rechecks the actual
   committed file, operation ID, exact capture and archive hash/length. A missing,
   foreign or damaged destination stays unknown. Concurrent reconciliation shares
   one promise; a late reader cannot publish an older selected root over a newer
   save. Correlate this evidence in the existing coordinator; a hash alone is not
   authority or a write receipt. `saved` does not mean browser download occurred.
5. For reopen, Host supplies a stable file reader to `openProject`, which returns
   data plus original **ranges of that file** only after every check. A new Host
   can reconstruct without the previous store or original path. The Host keeps
   the reader open/immutable while those ranges are in use, and activates the new
   state only after its own permissions/input/whole-view capacity checks succeed.

This is intentionally not a Blob-compatible replacement for `BundleTarget` or
`OriginalStore`. Large-file adoption also needs a Host range-backed original store,
leases, metadata probing and media decoding, plus reviewed integration with the
existing coordinator and controller capacity guards. The 16 MiB import, 32 MiB
VBP0 and short-media codec profiles remain unchanged. Do not feed large files into
those existing paths and claim this candidate lifts their limits.

## Closed ZIP64 profile

The candidate follows the STORE and ZIP64 structures in
[PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
No new dependency or permanent license decision is made. The implementation is a
strict subset, not a general ZIP reader:

- Manifest first, full native JSON entries, exact original bytes. Only paths
  `manifest.json`, `native/<lowercase SHA256>.json` and
  `originals/<lowercase SHA256>.bin` are permitted. No path extraction is performed.
- Every entry uses ZIP64 sizes/offsets, STORE, UTF-8 flag only, fixed timestamp,
  regular-file attributes and exact known extra fields. Local/central fields must
  agree byte-for-byte. Duplicate paths, compression, descriptors, encryption,
  symlinks/devices, comments, unknown extras, extra disks, prefixes and suffixes
  are refused. ZIP64 end/locator/classic end must match counts/size/offset exactly.
- Offsets and sums use BigInt. Local records must be contiguous from byte zero;
  central directory and end records must also be contiguous with no overlaps/gaps.
- Each entry is streamed for CRC32 and SHA-256. Native entry byte SHA is separate
  from the canonical native `contentHash`. Full envelopes preserve ID, parent,
  author, timestamp and reason. Parent absence/cycles and duplicate versions fail.
- Manifest and native JSON must be canonical data, bounded in bytes/depth/nodes.
  Interpretations are manifest data in the existing closed selected-stream schema.
  They do not authorize scripts, providers or network access.
- Closure comes from **every** retained native root, not a manifest required list.
  Unreferenced originals/plans, missing originals/plans and unknown entry kinds
  fail. Indexes, recipes and derived entries are not supported by this first slice;
  no transitive recipe/derived support is implied. Runtime Undo stacks are not
  serialized. Host must keep its live Undo/capture leases independently.

The manifest pins operation/capture/selected version and exact native entry paths.
Original paths pin exact bytes; native sources independently pin their lengths.
Hashes detect mismatch against these declarations; this is not a signed/authentic
archive format. Trust/permissions stay with the Host.

## Defensive budgets and actual evidence boundary

Provisional review limits, inherited from the prior proposal, are **not** practical
capacity guarantees: 8 GiB archive, 4 GiB aggregate originals, 100 originals,
8 retained roots, 109 total entries, 64 KiB per JSON record (including manifest),
24 JSON depth, 4096 JSON nodes per record. A read/write request is at most 64 KiB.
Central metadata and small native/manifest records may be buffered; originals and
whole archives are never buffered by the engine. Source immutability is a Host
contract; a changing source is also detected during streamed writing.

The reference target reserves previous completed-file occupancy plus full staging
size before writes. Its configured quota is an admission bound, not a filesystem
free-space reservation. Actual disk-full/I/O failures are handled separately.
Unknown operations retain staging occupancy and prevent reuse. Cleanup failure
also keeps the instance locked for Host recovery. No automatic retained-root
pruning or deletion of the previous complete file precedes rename.

The functional large fixture writes **40 MiB of actual synthetic original bytes**
(no sparse file), saves a ZIP64 archive larger than32 MiB, closes/deletes the old
original, then reconstructs two retained native roots from the archive alone.
The selected root has no media; the old retained root still requires the original.
Python's independent standard ZIP reader streams every member and validates CRC.
This tests functionality and bounded access requests, not heap/throughput or
performance. No benchmark or >4 GiB execution is claimed.

## Backend limits and remaining adoption gates

- Only the private Linux/Node filesystem backend is exercised. No browser OPFS,
  File System Access, Windows atomic replacement, iPhone, desktop picker or actual
  desktop permissions are requested/verified. Permission prompts belong to Host.
- The destination directory and source handles must be exclusively Host-owned.
  No cross-process/multiple-FileTarget locking or protection against a privileged
  actor mutating the private stage between validation and rename is claimed.
- Rename/directory-sync behavior is filesystem-specific. Attempted-commit errors
  are conservative unknowns. This is not power-loss/crash certification.
- Pending receipts/operation locks live in this target instance. A durable Host
  journal/restart-reconciliation adapter is still required before production
  adoption. Do not create a second target to bypass an unresolved operation.
  Completed operation IDs are bounded to1024 per target instance; exhaustion
  explicitly refuses. Old successful receipts are not a persistent audit journal.
- Host must recheck authority at its trusted commit capability. The default Node
  rename capability demonstrates I/O only, not authorization enforcement. Abort
  is checked before the commit attempt; cancellation after that boundary cannot
  claim no-write. A never-settling OS call still requires Host settlement policy.
- Unit/independent file evidence does not certify UI/SaveCoordinator integration,
  arbitrary original media, larger native documents, exports or product usability.
  Integration, durable recovery, device certification and budget adoption need
  explicit review; no merge/release/CI/performance gate is lifted.

## Functional acceptance mapping

| Fixture | Requirement and preserved failure behavior                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| F01     | >32MiB file-backed save; retained-only original; empty-Host reopen; full envelopes/plans/hashes; independent ZIP reader  |
| F02/F03 | Tamper/missing/path/offset/overlap/descriptors/symlink/extra/trailing/footer/size/duplicate refusal                      |
| F04     | Native/parent/capture/interpretation/original closure guards on writer                                                   |
| F05     | Cumulative quota + mid-write cancel; previous complete bytes unchanged; fresh retry                                      |
| F06     | Source mutation between passes refuses before publication                                                                |
| F07/F08 | Lost acknowledgement, concurrent reconciliation, newest-save preservation; missing/foreign/tampered target stays unknown |
| F09/F12 | Archive/metadata/count/depth limits, bounded range reads                                                                 |
| F10/F11 | Reader independently refuses closure/native hash failures despite internally valid ZIP checksums                         |
| F13     | Actual stage file corruption detected on readback; publish never called; old complete file preserved                     |

All binary fixtures and reports are temporary/external. Test source creates only
synthetic data. See VERIFICATION.md for exact source pins, commands and outcomes.

## Opt-in total-capacity candidate

The storage-owned [capacity adapter and usage contract](integration/CAPACITY-HANDOFF.md)
adds explicit Host-policy admission before scratch allocation, origin-wide logical
OPFS accounting and durable unresolved reservations. It preserves current caps and
archive formats. No GC, normal Host wiring, physical-disk guarantee or M2 portable
acceptance is implied. See the [capacity verification report](integration/CAPACITY-VERIFICATION.md) for
tested source and failures/limitations.

The subsequent [actual coordinator verification](integration/CAPACITY-COORDINATOR-VERIFICATION.md)
exercises the capacity-enabled factory through real scoped saves, refusal and
unknown/fresh-owner recovery. It adds fixtures only; numeric policy adoption,
normal capacity UI and corrected M2 profile dispatch remain separate gates.

## Private v2 portable candidate

[Explicit v2 dispatch and private #210 persistence handoff](integration/V2-HANDOFF.md)
retain the accepted capacity ownership path and immutable v0/v1 archives.
Generated small fixtures verify storage only; codec admission, normal Host adoption
and numeric capacity changes remain separate gates.
