# Source-free native JSON save/reopen — preparation only

Next authorized #97 domain slice after #116's limited independent GO. This directory contains
headless conformance preparation and a #76 handoff, **not** a shipping Save definition, storage
adapter, native file format or new public API. Accepted editing files are unchanged. No installed
#117 code is incorporated or overwritten. The existing readonly/edit manifests still request no Save.

## Exact basis and limits

- Branch `prep/geo-native-save`, base #116 HEAD `7892f1c4707371a4c58895fb81d20f20d3dbc195`;
  independently accepted tested implementation `3e808d2e8c1be833110940db56e8bf3339e9b6ff`.
- Existing shared API/runtime basis #111 `d4da53d9615aba484ed79748d75688e442611bec`.
- Last locally recorded main `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`. On 2026-10-12,
  `git fetch origin main` and GitHub #117 lookup failed (credentials/HTTP401). This is **not** a
  fresh remote-main check. #117 installed edit acceptance and its exact adoption pin remain pending.
- Source-free mixed documents accepted by the existing Geo validator are preserved as a whole:
  Point, null geometry, Line, Polygon and Multi structures, scalar rows and stable layer/feature/
  row/field IDs. Editing targets remain Point-only. No source bytes/closure, GC, CRS migration,
  tiles, resources or provider. Validation warnings do not certify topology.
- The original Point-only save trial has been removed following preparation review. Native saving
  must not filter a document to its editable geometries. External source snapshots/refs still refuse.
- Existing Geo native budgets and controlled-view budgets are unchanged. New trial helpers are
  test-only. They do not establish a permanent on-disk schema, budget, package entry or compatibility.

## Domain requirements using existing contracts

1. Host validates the complete source-free native content before opening. Save flushes the existing
   PointInputBuffer through existing Inputs/controller. Invalid, stale or composing input remains
   in place and refuses before capture/write. Valid dirty input creates its ordinary single edit;
   persistence itself creates no command, Undo entry or content revision. A later storage refusal
   leaves that valid flushed edit unsaved and Undo-able; it does not silently roll back the edit.
2. Use the existing Save addon/SaveCoordinator and Host-provided Storage, not a Geo session,
   history, database or duplicate save queue. Capture fixes scope, local revision and canonical
   `contentHash` with the content. A local draft revision is not an immutable ArtifactVersion ID.
3. Existing `serializeGeo`/`parseGeo` validate content JSON. They do **not** define the artifact
   envelope or persist receipt/hash by themselves. Host keeps operation ID, capture and adapter
   receipt separately according to its existing storage contract. The trial `checkedReopen`
   verifies canonical content against a trusted expected hash; an arbitrary caller-provided hash
   is not independent storage proof. Canonical content hash is not a raw file bytes hash.
4. Reopen only after bounded parse, Geo schema/IDs/scalars/axis/profile checks and captured hash
   match. Construct the existing Host session only after complete validation. Failure leaves the
   old open document, pending input and stored record unchanged. Do not regenerate element IDs,
   convert coordinates or migrate implicitly. A new session starts with its own revision and
   local history; old undo stacks/private selection are not serialized as native content.
5. `committed` means adapter-acknowledged persistence of **that capture**, not latest-draft saved
   and not a durability guarantee beyond the adapter. Existing runtime `isCurrent` guards the
   saved marker using live scope/grants/revision. An old capture can commit legitimately while
   newer changes stay unsaved; reopening that version shows old values by design.
6. A conclusive no-write proof permits an ordinary explicit retry. Timeout, transport error or
   invalid receipt after dispatch is indeterminate, not a rollback or safe automatic retry. Retain
   operation ID/capture/claim; use existing Host reconciliation before retrying the same storage
   key. The original settled Promise remains indeterminate even after later reconciliation.
7. Revoke before dispatch prevents the write. After dispatch, revoke stops consumer delivery,
   but cannot claim the storage write was rolled back. Host retains the real eventual receipt,
   never marks a closed/replaced scope saved, and respects incomplete drain/retained ownership.
8. Surface Save status must distinguish current saved state, older capture committed, refused,
   aborted-before-write and indeterminate. No extension-side timer may infer success. Save and
   reopen are local explicit actions; no network resource fetch or external service is added.

## Executable preparation and required acceptance

`../../test-host/native-save-harness.ts` (relocated by #76 for packaging) uses existing public `ReferenceRegistry`, `FakeStorage`, `referenceBinding`,
`ManualClock`, controlled controller, EditorSession/Inputs and Geo serializer. It creates a
**test-only** headless manifest. It does not grant save to the accepted product definition.
FakeStorage is volatile; a JSON encode/decode plus fresh session proves semantic reopen, not
browser restart, file-system write, IndexedDB atomicity or installed independent Host operation.

| Case    | UC / FR / AC             | Assertion and next installed gate                                                                                                                                                                   |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GS01    | UC1, FR03/07/08, AC03/08 | Native JSON reopen preserves exact full values/IDs; save leaves content/revision/history unchanged; fresh session has empty history. Host must repeat with actual acknowledged bytes after restart. |
| GS02    | FR08/10, AC08/12         | r1 ack while r2 is current writes only r1; no r2 saved marker or history change. Host UI must show newer unsaved state.                                                                             |
| GS03    | FR07/08, AC03/08         | Save with Redo available preserves both history directions.                                                                                                                                         |
| GS04    | FR07/10, AC07/12         | Invalid/composing Point buffers refuse before job/write and remain intact. Native OS IME remains untested.                                                                                          |
| GS05    | FR10, AC12               | Proven no-write leaves state intact, no saved marker, fake adapter fences late commit. Actual adapter must prove equivalent behavior.                                                               |
| GS06    | FR10, AC12               | Deadline produces indeterminate with operation ID; SaveBusy prevents duplicate; reconcile releases hold without rewriting settled Promise.                                                          |
| GS07/08 | FR10, AC12               | Revoke before/after dispatch respects no-write vs real late receipt; no closed-scope state revival.                                                                                                 |
| GS09    | FR01/08/10, AC02/08/11   | Unknown schema, axis, duplicate IDs, source profile, hash mismatch and bytes overflow reject without touching open state. This preparation helper is not the installed import UI.                   |
| GS10    | UC1, FR07/08, AC03/07/08 | Save flushes valid coordinates+scalar once; one Undo reverts the edit; storage adds no history.                                                                                                     |

## #76 handoff and dependencies

After installed editing #117 gets an exact accepted pin, #76 should:

- Adopt only the reviewed save-domain changes separately; own manifest/public entry, optional
  Save addon negotiation, Host storage binding and save UI. Preserve readonly/edit-only routes.
- Name the existing local storage/envelope path and exact source used. Bind identity/key to the
  correct artifact; persist and reopen acknowledged capture plus required receipt evidence. If
  existing paths lack this, report the concrete gap before adding a new shared storage contract.
- Own trusted hash/envelope validation and atomic admission on reopen. Do not overwrite active
  draft during validation. Define explicit pending-input handling for Close/Reopen using existing
  Inputs/recovery; retain bytes/records on refusal. No silent migration, new IDs or data filtering.
- Repeat GS01–12 in independently installed Hosts through public exports, with actual local
  adapter persistence/restart, UI/headless parity and desktop/narrow views. Include missing save
  grant/storage, stale/oversized buffer, tampered/missing receipt, timeout-after-write, explicit
  no-write retry, scope replacement and delayed acknowledgement. Check errors and no external
  requests. Source-backed documents must refuse this profile without destructive conversion.
- Check controlled-view byte headroom including `lastSave` receipt/capture. Existing edit-only
  capacity preflight uses `canSave:false` and no receipt; its success alone cannot certify a
  save-enabled view near the cap. Preserve the shared limit; report required Geo-only preflight
  adjustment rather than relax it or silently omit receipt state.
- Keep local input/recovery/history policies explicit. No extra Session/history implementation;
  no durable checkpoint or full native-version migration claim from this test harness.

Unresolved: #117 accepted exact pin; actual Host adapter/envelope and saved-state UI evidence;
production capacity/durability choices. None requires a new shared API based on current evidence.
No main merge, CI restart/dispatch, performance work, package publication or M4 completion.

## Publication follow-up and null-geometry boundary

After the initial authentication failure, normal `git fetch origin main` succeeded: remote main
is still `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`. GitHub REST confirmed #117 remains open,
Draft and unmerged at `3c7b523f05312165de05532e8e93192aff6d4a73` (base
`codex/issue-76-geo-point-hosts`). This checks repository state, not independent acceptance.
The preparation stays based on accepted #116; it does not incorporate #117.

The existing `editFixture()` includes three Points, one null geometry and one LineString. The
save preparation now accepts and preserves this exact fixture. GS12 also covers all supported
Multi families and Polygon, including null scalar, zero, false and leading-zero string values.
It compares the complete native document after a real FakeStorage capture/hash acknowledgement,
JSON round-trip and fresh test-session open. No feature/row/field/geometry filtering occurs.

The removed whole-document Point-only rejection was never adopted as a formal save contract.
Point-only remains the geometry **editing** restriction; retaining unedited shapes does not grant
editing capability. Source-backed documents still reject with `GeoSourceFreeProfileRequired`,
using the candidate's correct hash in the negative test. Hash mismatch is a separate valid mixed
source-free candidate test requiring `CaptureHashMismatch`.

This preparation's full-value comparison proves JSON semantics, not a Host's atomic reopen or
pending-input retention. Actual adapter/envelope, replacement transaction, input recovery and
installed saving remain NOT RUN. Failed `checkedReopen` tests use an untouched separate open
session; they cannot certify the real Host admission/switch path.

**Mandatory #76 gate:** validate the complete controlled-view budget including `lastSave`,
SaveCapture and receipt for success, old-capture completion and indeterminate states. The existing
edit-only preflight omits these fields. Keep the shared byte/node/depth limits, do not truncate
receipt evidence, and determine any required Geo-only admission/preflight headroom before shipping.

GS11 (FR07/08/10, AC03/08/12): conclusive no-write after valid input flush keeps the accepted
edit and its single Undo, clears only the committed input buffer, and leaves the saved marker unset.

GS12 (UC1/3, FR02/03/08, AC03/04/08): exact mixed editFixture and extended all-geometry-family
fixtures preserve the whole document and correct capture hash; non-Point editing still refuses.
GS09 now uses correct candidate hashes and specific diagnostics so profile validation cannot
pass solely because of an unrelated hash mismatch. Shared WriteRequest capacity/cleanup review
belongs to #76; this preparation neither modifies nor certifies that runtime behavior.
