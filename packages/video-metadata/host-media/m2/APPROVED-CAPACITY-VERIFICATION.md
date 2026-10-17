# Approved isolated capacity validation

Runtime/config pin: `52f3b1bf82ad05057401ccc306b6e806ff34e30c`.
Final strengthened test pin: `1cbb0cb3f972814094753a3dca2c1bf493f9d6e3`.
The successor changes only four test/diagnostic files; runtime/config unchanged.
Base merge: `3074731532a26204e919d3b0e1ff557d5b9cab06`, with accepted
#222 docs `172255a33946ce1d6560f5bc4e9b5918d0de8e2e` and accepted
#220 docs `9d0d53e1d33d3ad2051d0e96db4d0cd9051376e8` as parents.
Main remains `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`; this is an independent
validation branch, not main integration or completion of #75/#77.

## Explicit policy and guarantee boundary

The user approved file/archive512MiB, application-managed temporary plus saved
logical storage2GiB, existing per-project saved copies1GiB and no automatic saved
file deletion/GC. This supersedes the earlier two-original capacity approval hold
in OUTPUT-TIMING-CORRECTIONS.md. It does not approve a production default change.
Only the new opt-in validation configuration passes512MiB external/archive scratch
limits and the existing TotalCapacity coordinator to the admitted v2 factory.
No Storage implementation, root manifest, normal registry, v1 format/default,
existing PCM/source/output limit or Rust backend changes are included.

The accepted mount slot supplies ownership/drain; the real existing v2 Host,
media admission, persistence, SaveCoordinator and codec are used. External Open
uses the outer slot; inner Open remains disabled. Publication/leave checks require
a saved capture (including a save after portable import). No visible normal M2
route is exposed by this change. The user has separately approved the visible private entry
`Video（複数素材・音声編集）`; shared Host integration remains a separate gate.

This is a **dedicated local validation origin with controlled writers**. Its loopback
server serves the test entry, not the ordinary v1 app. One validation session holds
an exclusive validation Web Lock. That lock cannot exclude an old/uncoordinated
v1 tab, another app route, a service worker or arbitrary JS writing OPFS. It must not
be described as a whole-origin hard cap when composed with such writers. Inventory
observes existing files; it cannot reserve ahead of bypassing future writers.

TotalCapacity is reused without a second ledger: total2GiB, management allowance
144MiB (existing128MiB PCM allowance plus16MiB management withheld inside2GiB),
scan1000 entries/depth10 and20 reservations. Actual visible PCM is also inventoried,
a deliberately conservative charge. The isolated Host serializes Save and media;
media preview/play/encode requires128MiB available before using existing scratch.
This arrangement is not a general concurrent-media reservation API. Shared Host
must wire every participating archive writer, including v1, to the same existing
policy/ledger and coordinate/exclude concurrent temporary writers before claiming
an application-wide budget. No normal-origin guarantee is supplied by this factory
alone. Policy mismatch fails closed; no ledger reset/migration is added.

The guarantee is logical OPFS accounting plus explicit management allowance, not
physical disk/browser quota, RAM/GPU/codec buffers or a measurement of actual IDB
bytes. User-selected external originals/ZIPs and user-downloaded output files are
not origin OPFS entries; this ledger does not impose a filesystem-wide budget on
those external files or browser implementation temporaries. No browser quota
override is used. Existing archive preflight reserves two
copies before archive scratch chunks; journal and total admission may write bounded
intent metadata first. It is not a zero-metadata-write claim. Saved copies remain
immutable and counted; no history deletion makes room.

## Reproducible gates

Use a fresh output directory; full source hashes and attribution are documented
in ACTUAL-OUTPUT-VERIFICATION.md. Dependencies remain the fixed previously approved
local candidates, not new packages.

```sh
TMPDIR=/workspace/video-capacity-evidence/browser-temp \
node packages/video-metadata/host-media/m2/capacity-validation-check.mjs \
  /workspace/video-codec-eval/deps \
  /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov \
  /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov \
  /workspace/video-capacity-evidence/actual-final-pinned
node packages/video-metadata/host-media/m2/capacity-cross-version-check.mjs \
  /workspace/video-capacity-evidence/cross-final-pinned
```

Full originals total298716660 bytes. They are not trimmed/reencoded to fit storage.
The4sec native edit selects2sec from each, plus independent mono AAC with gain.2,
source-anchored fades.5 and presentation endpoints.001/3.999. The test saves a ZIP
containing all original bytes, verifies its native/version/original closure, closes
the context, and opens only that ZIP in a fresh context with initially empty OPFS.
It plays, exports portrait1080x1920 contain output, and runs the accepted independent
FFmpeg full192000-sample/boundary/six-picture/exact100-frame timing oracle. Then it
changes fades to.25 and resaves two retained versions with unchanged original SHA
keys and prior version. This is the1280px validation UI; prior mobile evidence is
not relabeled as new configuration/mobile acceptance.

Quota refusal uses explicit competing **no-write reservations**, each at most512MiB
archive obligation, to leave insufficient two-copy headroom. These are test-only
owners, not saved files. The actual new Save must refuse at total preflight without
new scratch chunks, native/revision/history mutation or replacement of the saved
archive. The result must be outcome/aborted-before-write with adapter-no-write-guarantee,
zero retained captures/unresolved writes, all scratch records done, and no Host
busy/unknown latch. Full old archive SHA is checked before/after. Other owners remain reserved
through refusal and explicitly settle no-write afterward; all reservations then
clear. A fresh Save through the same live Host/coordinator, with no reconcile,
remount or reset, must commit a different operation and a third retained version.
It preserves the prior versions and old saved ZIP bytes held through an immutable
lease; new capture equals the unchanged native. Ownership and reservations clear
again. Downloaded first/second ZIP hashes and original input hashes are unchanged.
This tests logical contention, not successful physical allocation of2GiB.

The simultaneous cross-version gate uses two pages in the **same browser context
and origin**, real v1/v2 factories/Hosts/SaveCoordinators and the same coordinator.
Both initially save empty metadata-only projects, then edit. A holder reserves
successfully and pauses before archive scratch; competing test reservations fill
logical headroom. The peer's real Save must refuse before chunks and preserve its
old portable SHA, complete journal/native/revision/history. Resuming the holder
commits and releases only its reservation; test owners are then separately settled.
The refused peer then makes a fresh successful Save with the same live owner;
its old archive bytes/native/prior versions remain intact and ownership clears.
Save-enabled/Reconcile-disabled UI states are checked for both versions, plus the
v2 internal transition state. Both directions run in fresh contexts: v2 holder/v1 refused and v1 holder/v2 refused.
v1 retains256MiB external/scratch and1GiB journal limits; v2 uses the approved config.
This is persistence coordination evidence, not codec evidence or proof that an
unmodified legacy entry is automatically coordinated.

## Preserved attempts and evidence

The initial full-original prototype at the merge base with uncommitted new files
saved/reopened/exported/resaved successfully but **FAIL**ed during retained filler
file setup with Chromium QuotaExceededError. `/tmp/video-approved-capacity-pre`
contains both ZIPs, first-save/resave/oracle JSON; its log remains alongside it.
No physical quota was increased and no old archives were removed. The test changed
to competing existing-ledger reservations rather than claiming physical capacity.

Cross-version prototype build initially **FAIL**ed on incidental codec imports;
extracting policy/digest into a codec-free module removed that dependency. pre2 was
interrupted during diagnosis; its original suspected scratch-lock diagnosis was
premature and the correction is recorded separately. pre3/pre4 **FAIL**ed because
test reservation identifiers/paths did not meet the existing coordinator contract.
The fixtures now use namespace:operation ids and preparation-UUID paths; no validator
was weakened. Held scratch inspection also avoids reentering the active writer lock.
pre5 **PASS**ed both directions. All `/tmp/video-capacity-cross-pre*` evidence remains.

The first clean52f3 gate completed PASS and remains in
`/tmp/video-approved-capacity-pinned` (archive sizes298797537 and298802754 bytes).
Review correctly found it did not assert definitive no-write outcome/ownership or
same-owner retry, so that PASS is not acceptance of those stronger properties.
The returned outcome happened to contain adapter-no-write-guarantee; an unasserted
value does not retroactively close the gap. New assertions and retry were added.
An initial retry diagnostic used a nonexistent v1 button id and FAILed; fixed to
actual action buttons. Exact3276648a cross-version retry PASS is retained separately.
Its full-original retry run was stopped early/NOT COMPLETED after prior evidence
proved JSON.stringify would falsely reject equal canonical archive values with a
different object-key insertion order. The final test uses existing canonicalJson;
no product semantics or Storage validation changed. Interruption notes, partial
files and original checks remain under `/workspace/video-capacity-evidence`.
Final media output/browser temporary files use that workspace filesystem because
preserved evidence consumes much of the smaller `/tmp` filesystem. No browser
quota setting or application limit was overridden. Final exact-pin outcomes follow. Full media/ZIPs/screenshots/raw evidence stay outside Git. No performance work,
CI enabling/dispatch, main push/merge, deployment, release, publication, consuming-product or
license change is performed.

## Final outcomes

| Exact pin                                | Check                                                                                                                                       | Result                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 52f3b1bf82ad05057401ccc306b6e806ff34e30c | Root typecheck/lint/build/file policy;173 unit tests in15 files                                                                             | PASS                                      |
| 52f3b1bf82ad05057401ccc306b6e806ff34e30c | Existing Storage capacity coordinator5 cases; accepted mount-race4 cases                                                                    | PASS                                      |
| 52f3b1bf82ad05057401ccc306b6e806ff34e30c | Original full-original gate and initial cross-version gate, before review-strengthened assertions                                           | PASS, limited as above                    |
| 1cbb0cb3f972814094753a3dca2c1bf493f9d6e3 | Focused lint/file policy; strengthened same-origin v1/v2 contention/retry in both directions                                                | PASS                                      |
| 1cbb0cb3f972814094753a3dca2c1bf493f9d6e3 | Full originals save/fresh reopen/play/export/independent oracle/resave/definitive no-write/same-owner retry                                 | PASS, clean checkout, browser errors0     |
| 1cbb0cb3f972814094753a3dca2c1bf493f9d6e3 | Root typecheck/units/build rerun after test-only correction                                                                                 | NOT RUN; unchanged runtime covered at52f3 |
| This configuration                       | Mobile, ordinary Library/locator/shared-host integration, Rust integration, physical2GiB allocation, whole-origin bypass-writer enforcement | NOT RUN / not claimed                     |
| All pins                                 | Performance/Actions/main merge/release/deploy                                                                                               | NOT RUN, held                             |

Final evidence: `/workspace/video-capacity-evidence/final-checks.json`,
`actual-final-pinned/results.json`, `cross-final-pinned/results.json` and adjacent
logs. Old exact-pin summary remains `/tmp/video-approved-capacity-checks.json`.
The screenshot `actual-final-pinned/quota-refusal.png` is the **post-refusal successful
retry** state: Save complete, controls available, Reconcile disabled. It was visually
inspected. The old52f3 screenshot retains the original refusal display.

Final archives are298797537 /298802754 /298807973 bytes for first-save/resave/retry.
The first two are downloaded fixtures; the third is the actual retained OPFS archive
whose bytes were independently reopened/hashed by the test. Retained native versions
progress1→2→3. The compact runner console's retainedVersions2 refers to the first
resave; the final3 is asserted and retained at proofs[0].refusal.retry.stored.versions.
Old saved archive SHA is unchanged through refusal and successful retry. After retry,
the journal retains2 actual saved archive files totaling597610727 bytes; with the
150994944-byte explicit management allowance, accountedBytes748605671, reservations0,
reservedAdditionalBytes0 and overBudgetfalse. No saved archive was deleted.

The refusal result is aborted-before-write with adapter-no-write-guarantee;
refusedOwnership has captures0/unresolvedWrites0, refusedTransition has busyfalse/
unresolvedSavefalse, and every scratch record is done. Same-owner retry is committed
with a new operation id and again releases capture/reservations. The retry necessarily
clears Storage's last capacityRefusal diagnostic; use the retained refusal result and
explicit pre-retry assertions, not a post-success diagnostic value, as the proof.

Independent final output: all192000 valid PCM samples max error0.0011913538013274471,
RMS0.00015960722474604483; six picture comparisons worst mean3.809508101851852.
Exact audio interval starts0, time_base1/48000, duration_ts192000;512 decoded tail
samples are classified outside that verified interval. All100 video packet and
all100 decoded-frame PTS/durations pass n/25 and1/25, plus timing negative controls.
Original input SHA keys remain unchanged; encoded tolerances are not widened.

Both coordinated cross-version directions fill logical headroom to2147483648 bytes
with explicit reservations, refuse the competing Save definitively, preserve its old
archive/native/history, and later commit a fresh operation on that same owner with
reservations0. This does not upgrade the known uncoordinated-writer bypass into a
PASS. #229 separately covers that control; no #229 runtime/branch was incorporated.

Source review and shared-host adoption remain pending; no full Epic/M2 normal-Host
completion is claimed. The approved visible entry is owned by #223's successor.
It must wire all managed writers or explicitly bound/exclude bypass and concurrent
media writers, preserve v1 data/default UX, and run its own exact-pin integration gates.
