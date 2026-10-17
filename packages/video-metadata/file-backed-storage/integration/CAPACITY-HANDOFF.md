# Private total-capacity adapter: non-destructive first slice

This opt-in adapter adds admission and usage data to the existing private storage
binding. It does not register a normal Host capability, adopt a new numeric budget,
raise any existing cap, delete archives, prune native/Undo history, or certify M2
portable dispatch. Existing automatic scratch/failed-candidate cleanup retains its
original evidence and authorization requirements; no new file deletion is added.

## Host contract

Open `TotalCapacity` from `./capacity` with an explicit `TotalCapacityPolicy`:
`totalBytes`, `managementBytes`, `maxEntries`, `maxDepth`, `maxReservations`.
There are no numeric defaults. These are private candidate APIs, not a public
compatibility promise. `managementBytes` is a Host allowance for IDB and other
management overhead, not a measurement or physical-disk guarantee. Host must
choose and review these values; the small numbers in tests are synthetic only.

Pass the resulting instance as `capacity` to `createPersistenceFactoryV1`, or the
last constructor argument of `ProfileJournalVideoStorage` / `JournalVideoStorage`.
The Host owns its lifetime; drain all participating owners before closing it.
Closing it never clears durable reservations or files. Independent instances in
other tabs use the same fixed origin-wide IDB database and Web Lock. Different
policies fail closed; this slice has no policy migration or force-reset command.

Every active managed writer in that origin must participate. Before enabling this
capability, the Host must drain incompatible legacy writers; do not mix enabled
and bypass writers and claim global enforcement. Existing files from all old
namespaces are counted even if their owner/format is unknown. No legacy native,
portable, journal or scratch schema is rewritten. The capacity ledger is separate.
An origin reset/corrupted ledger, external bypass writes, browser eviction and
physical storage pressure are not repaired or certified by this adapter.

## Admission and accounting

`prepareProject` validates/hashes the captured closure and `archiveSize` computes
exact stored ZIP bytes A. Before creating a scratch **file**, capacity-enabled
storage performs the existing journal head/quota/operation checks early, then
atomically reserves `2*A`: one scratch and one candidate. Directory/IDB intent
creation may precede this check; no full archive is allocated before admission.
Journal save repeats its own checks at dispatch. Other active reservations are
included across namespaces/tabs.

Under the fixed origin lock, an entry/depth-bounded read-only OPFS inventory reads
file sizes, including unrecognized and closed-Host files. Accounting is:

```
observed OPFS file bytes
+ sum(2*A - visible reserved scratch bytes - visible reserved candidate bytes)
+ Host management allowance
<= Host totalBytes
```

Candidate identity is attached durably after journal intent and before its file
is created. Both candidate attachment and settlement require the exact original
scratch file path as well as the journal/operation identity. A direct constructor
may use a different scratch namespace; its rejected duplicate operation cannot
settle another owner's reservation, even before that owner's file exists. The
path already lives in the durable scratch/capacity records, so recovery can
validate it without a new schema or an in-memory-only token. Existing files cannot be adopted as reservation credit. Per-file
credit cannot exceed A. Invisible in-progress writable bytes remain covered by
the full reservation. Completed files replace, rather than duplicate, reservation
charges. Equal hashes in separate archive files still count separately. Partial
inventory, bounds overflow, missing/corrupt DB state and inconsistent policies
refuse admission; they never produce a zero-usage success.

Scratch/journal/source/external/live limits remain independent and unchanged.
The early journal check is advisory, not a CAS reservation; a later stale head or
permission loss can still refuse. Total admission is likewise not an OS disk
reservation. OPFS backing overhead, browser temporary/download copies, external
original files, codec memory and other origin IDB usage are not exactly measured.
The usage discriminator explicitly says `logical-opfs` and
`physicalDiskGuaranteed: false`. No `StorageManager.estimate()` value is presented
as exact free physical disk.

## Unknown results and settlement

An unresolved write retains its durable reservation with no TTL, age-based release
or close-time clearing. In particular, a lost committed acknowledgement keeps its
reservation even when existing cleanup has removed scratch. Reconcile must obtain
identity-correlated final evidence. Interrupted cleanup must first finish via the
existing authorized `recoverScratch`; ordinary reconcile does not remove files.

Only after final evidence and completed scratch cleanup can storage settle the
reservation. `settle` additionally observes scratch absence and either the full
committed candidate size or no-write candidate absence. This method is a trusted
storage-internal accounting port: file length alone is not commit evidence. The
storage owner, not UI or extension code, verifies hashes/closure and supplies the
outcome. Settling removes only the active accounting reservation, never the
journal evidence/fences, native versions or archive files. Committed archive bytes
remain in the next inventory. Capacity rejection returns no-write only after the
existing capture fence proves it; uncertainty still returns unknown.

## Usage-display adapter

The Host retains the `TotalCapacity` instance and calls `inspect()` on demand or
at its own bounded refresh cadence. It returns detached data, never native content:

| Field                           | Meaning / display                                                   |
| ------------------------------- | ------------------------------------------------------------------- |
| `policy`                        | Explicit Host limits and allowance; never label totalBytes as RAM   |
| `observedBytes`                 | All visible OPFS file sizes, including closed/unknown namespaces    |
| `namespaces`                    | Namespace name, observed bytes, file count; root files also counted |
| `reservedAdditionalBytes`       | Capacity promised but not already visible in those files            |
| `reservations`                  | Operation identity, archiveBytes, additional reserved bytes         |
| `accountedBytes`                | Observed + additional reservation + management allowance            |
| `availableBytes` / `overBudget` | Headroom under that logical policy; not OS free disk                |

The private storage `capacityRefusal` supplies operationId, `journal`/`total`
stage, exact prospective archiveBytes and two-copy additionalBytes for the most
recent preflight refusal. Stage identifies where admission failed, including
head/scan/policy errors; it must not always be rendered as “disk full”. If inspect
fails, show unavailable/blocked rather than zero. Usage alone is not permission to
save, release reservations or delete. No shared Host return type or UI was edited.

For the reviewed two-original example, original bytes alone total298716660.
Actual A also includes metadata/framing. Three committed A-sized archives occupy
3A; saving the third peaks at4A. A single512MiB portable cap is not a512MiB total
cost promise. This implementation does not raise the existing256MiB scratch or
external cap, so that combined-original portable gate remains blocked.

## Follow-up boundaries

No GC/retention policy has been implemented. Latest-plus-previous archive retention
still requires separate user confirmation and a retirement-evidence/lease design.
It would not remove the native-version8 or operation64 limits. A total policy must
be supplied before this opt-in path can be used; there is no silently selected
origin budget. Cross-application policy coordination and normal Host wiring belong
to the integration owner.

Video owns the proposed v2 native/import schema; Storage owns a future explicit
portable profile/reader dispatch patch after exact reviewed source pins arrive.
v0/v1 bytes/hashes/history remain on their existing profiles. Mixed-profile native
ancestry must not be silently converted or dropped. Explicit adoption/provenance
is a separate contract. No second VISION file was downloaded by this task.
