# Accepted PCM budget scope — correction and bounded fit

**Correction:** #237's initial non-fit/user-cap-decision claim compared the AAC
codec heap to a different budget. That claim and the associated decision request
are withdrawn. No cap, accounting scope, encoder or default changes are needed
or authorized by the17.25MiB fact alone. Previous source/fixture evidence is
retained, but its whole-codec admission interpretation is superseded.

The accepted boundaries are explicit:

- #211 README at f9c2562b
  limits backing buffers and excludes total browser/process, JS objects, JIT,
  codec, GPU and GC memory. Managed decoder/cache buffers beyond source windows
  must retain their own shared reservations; they are not automatically free.
- #215 README at cfe0ccd6
  retains the8MiB shared realm and2MiB source-session caps, read admission,
  input/output/copy overlap and scheduled native-audio-buffer ownership. Total
  process/JIT/codec/GPU memory remains excluded. That accepted runtime already
  invokes this AAC encoder separately.

## Classify by the actual owner, not merely the word PCM

| Allocation                                                                                                 | Accepted accounting / release obligation                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0 JS arena and fixed R0 WASM memory                                                                       | Shared managed ledger,657408+786432 per resident owner, including inactive owners.                                                                                                                                                                       |
| Module bytes/snapshot/digest; decoder range/collector/callback; complete source backing; source/mix planes | Shared ledger; count full buffers and all overlapping/outstanding leases. Preserve existing conservative overlap, including read plus borrowed backing.                                                                                                  |
| Host export original and hash copies; AudioSample aliases of that original                                 | Shared ledger. Alias close proof must precede release; no discount because an encoder is involved.                                                                                                                                                       |
| Host scheduled AudioBuffer backing                                                                         | Shared ledger under accepted native-audio accounting, through ended/fulfilled owned close and reference clearing. Not a promise of total native-engine RSS/GC bounds.                                                                                    |
| Existing AAC pendingBuffer, incoming extraction, frame-slice transfer and worker codec heap                | Existing codec-owned internals, separately inventoried and lifecycle-bounded by the pinned codec path. Not new charges against the Host managed ledger merely because the data is PCM. This does not exempt any Host-managed source/cache/transfer copy. |
| C input/AVFrame/codec allocations within AAC WASM heap                                                     | Suballocations of the separate codec heap; do not count both the whole heap and its suballocations.                                                                                                                                                      |
| Additional future Host worker/copy/cache allocation                                                        | Must be classified explicitly and admitted in the same ledger if Host-managed. No silent reclassification to evade admission.                                                                                                                            |

Separate inventory is not “unlimited” or invisible. AAC initially allocates276
pages, has an existing32768-page growth maximum, and starts with262144 bytes of
JS pending storage. The maximum is a declared growth limit, not observed resident
memory. Incoming bytes are4N; each transferred frame is4F (F from init); queueing
and buffer growth remain separately reviewed codec lifetime constraints. Do not
claim the whole codec or engine is8MiB, nor claim every internal high-water mark
has been measured. Fixed mono48k codec configuration, bounded submitted chunks,
existing source/worker teardown and the real-library alias proof remain necessary.

## Conservative managed envelope under unchanged limits

From accepted R0 constants and #215 SelectedPcmSession admission, for one active
mono source request, N<=4096 and W<=32768:

- Read/collector/seen/callback charge:9W+16384, maximum311296.
- Complete borrowed source backing: at most262144, even if its mono view is smaller.
- Current source output:4N, maximum16384.
- Maximum active increment:589824; including its resident base and local module
  allowance gives2043640, below unchanged2097152 session cap by53512.

| Simultaneous managed reservations                                           |       Bytes |
| --------------------------------------------------------------------------- | ----------: |
| Four resident WASM source bases + one shared module                         |     5785336 |
| One maximum active source read/backing/output increment                     |      589824 |
| Entire provisional mix-owner allowance, including old returned mixed planes |       65536 |
| Entire provisional playback-owner allowance                                 |      262144 |
| Entire provisional export-owner allowance                                   |      262144 |
| **Known bounded envelope**                                                  | **6964984** |
| Remaining within8388608                                                     |     1423624 |
| Envelope plus one idle coexisting JS-backend arena657408                    | **7622392** |
| Remaining in that configuration                                             |      766216 |

This fits numerically without changing policy. The ledger control reserves these
exact terms and releases each owner independently. It then verifies refusal of
an additional1MiB managed cache while preserving all existing reservations:
that combined overlap would be8670968, exceeding the realm by282360. Admission
refusal is expected, not a reason to evict leases, shrink numerical work or raise caps.

Conditions matter: one active source row, one module reservation, four resident
source bases, no extra unreleased source outputs beyond the current request, and
the listed mix/output owner allowances. Add actual old source leases, further
active jobs, additional modules, caches/preparation or managed copies explicitly.
The real mixer must release each source row after consumption and retain returned
mix planes separately; owner allowances are cumulative. Separate codec memory is
not added to this equation, but its input aliases remain charged until proven done.

For one mono4096-frame export, Host output backing plus hash copy is32768 bytes,
while its mixed input remains charged to the mix owner until copying finishes.
The per-input resource proof permits bounding outstanding original backings
without awaiting final track flush. Older native playback buffers stay within
the cumulative output admission. These facts support a bounded implementation;
they do not certify an unwired real consumer or arbitrary concurrency.

**Result:** known tracked terms fit the unchanged scope in the stated admitted
configuration. Unconditional real-composition fit is NOT established. Preparation
cache lifetimes and concurrent old owners still need the exact combined source/Host
review. #233 now has two-source-review GO at codea9f209eb465ba361245fe497082f24f2c12b8c81 /
docsb49091a8ec95914d590bb6b0412c391349274a8b; exact-pin legacy/kit gates remain
in progress. No production connection is made by this correction.

## Small reproducible codec evidence

[Generated aac-inventory.json](library-evidence/aac-inventory.json) records the
verified shipped bundle and embedded WASM hashes. On the actual509386-byte decoded
binary, memory section starts at byte1277 (`0507` header); its7-byte payload starts
at1279 and is **01019402808002**. Decoding: count1, flags1, min ULEB128 `9402`=276,
max ULEB128 `808002`=32768. These bytes were extracted from the actual pinned binary,
not supplied as an expected fixture string. `aac-inventory.mjs` regenerates them;
the real-library runner compares generated evidence with the tracked JSON.
No credentials/media/full payload are included, and no AAC worker is instantiated.
