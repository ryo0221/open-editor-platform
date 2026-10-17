# Private v2 portable: author verification

Tested source: `524af950ea237096f5ed646793dc4dd6c861be27`, clean tree.
Subsequent report-only commit does not change executable source. Dependency base
and exact Video/Storage pins: [handoff](V2-HANDOFF.md). Node 24.19.0, npm 11.9.0,
Linux, Chromium 151.0.7922.173, localhost persistent profiles. This is author
functional evidence; independent review and private Host adoption remain pending.

## Commands and results

| Command / scope                                                                                                                                                                                                                                     | Result                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                                                                                                                                                                                                                      | PASS                                                                                                                   |
| `npm run build`                                                                                                                                                                                                                                     | PASS: strict `tsc --noEmit`, fixed font hash check, both Vite builds; existing chunk-size warnings, no limits disabled |
| `npm run check:files`                                                                                                                                                                                                                               | PASS, 1778 tracked files checked                                                                                       |
| `npx vitest run packages/video-metadata/file-backed-storage packages/video-core/src/v2 packages/video-metadata/host-media/m2 packages/extension-runtime/src/draft2/save.test.ts packages/extension-runtime/src/schema-edit-experiment/save.test.ts` | PASS 142 tests / 13 discovered files; nonexistent CLI filters are not additional tests                                 |
| `node packages/video-metadata/file-backed-storage/integration/v2-check.mjs /tmp/video-v2-browser-final`                                                                                                                                             | PASS V2-B01–04, four groups, browser errors 0                                                                          |
| `node packages/video-metadata/file-backed-storage/integration/v1-check.mjs /tmp/video-v2-legacy-browser-final`                                                                                                                                      | PASS eight legacy groups, browser errors 0                                                                             |
| `node packages/video-metadata/file-backed-storage/integration/capacity-coordinator-check.mjs /tmp/video-v2-capacity-browser-final`                                                                                                                  | PASS SCAP01–05, browser errors 0                                                                                       |
| `git diff --check`                                                                                                                                                                                                                                  | PASS                                                                                                                   |

The new unit suite passes V2-01–05 (14 test cases; ten fully rehashed semantic
faults across selected/retained positions). See the [acceptance map](V2-HANDOFF.md).
Unknown/mixed schema failures are not checksum-only negatives: each native
content hash, native entry name/SHA, capture hash where selected, all ZIP CRCs
and whole-archive SHA are recomputed and independently inspected before the
semantic reader is expected to reject the named reason. A valid corrected
high-denominator fade fixture remains accepted and gives the independently
computed exact gain fraction.

V2-B02 saves through the actual #210 private Host/SaveCoordinator, not a mocked
coordinator. Original payloads are generated 4-byte and 7-byte arrays; gain/fade,
rational timing, plans, original hashes and full ancestry roundtrip. Save creates
version 3; fresh-owner reopen/save creates version 4. Two closed-namespace legacy
archives and all preceding candidate files preserve their exact bytes/hash.
Capacity reservations settle to zero, without quota changes or deleting archives.
V2-B04 separately verifies retained-only closure with an empty selected catalog.
The test does not decode these fake media bytes and never claims mono admission.

Legacy ZIP golden SHA-256 values:

- Empty v0: `8931aff5109c063640fd368f60ce1e4870aeaf2cb2c77daeadb0bd390863f1ad` (1445 bytes).
- Retained-only v1: `434e18d36167e4ccd9d9ffb5c9b96e484da1ef1d5e6e928a6f9d8cc248b2896b` (4352 bytes).

`portable/v1.ts`, `portable/project.ts`, `integration/storage.ts`,
`integration/capacity.ts` and `browser/journal.ts` are byte-for-byte unchanged
from accepted #209. V1 factory only changes its rejection message to describe
all non-v1 profiles. SCAP regression retains actual input flush/refusal, committed
capture, tight-budget refusal before scratch, unknown ownership, same-owner
reconcile and controlled fresh-process recovery. That remains a functional
controlled restart test, not power-loss durability certification.

## Evidence and failures

Raw evidence is local `/tmp`, not committed or uploaded. Reproduce with the above
commands; it is not a durable remotely downloadable artifact.

| Evidence                                             | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-v2-browser-final/results.json`           | `25b6d07127cbef4f22e62ad6e92007fcd9e633f3a2675a0a1cf654af6b830146` |
| `/tmp/video-v2-legacy-browser-final/results.json`    | `32d80361d04abe7aa43aece7a7561ed802a0c2458e2771db0080d16c3a681c88` |
| `/tmp/video-v2-capacity-browser-final/results.json`  | `293968e016aef8cc1b122ef3c60484afdd43908f40fb1eedbeec3caab72c54bf` |
| `/tmp/video-v2-units-final.log`                      | `e919c17057eb8cd1c9acbea3e4640388c8d829f7560990c3edd9142780e61307` |
| `/tmp/video-v2-browser-final/digest-provenance.json` | `ab7cca8c221434fc40bf691baf6876e30d692968bf4d7e4a4e7ee1a1c7f73b63` |
| `/tmp/video-v2-browser-final/v2-storage.png`         | `fc801142cacd32adbae0ee76d96de68db4b99dfe40fc09518e3d890a00112c43` |

Inspected screenshot shows the actual private Host after save/close, with disabled
terminal controls and blank preview. No codec was invoked; this is not visual,
mobile or playback acceptance. Existing full MIT notice and exact installed/lock
`@noble/hashes` 1.8.0 provenance are checked by the runner; no dependency added.

Initial development failure: synthetic independent audio was placed on the same
track as source audio; 13/14 new tests correctly failed `Unsupported same-track
overlap`. Fixture now uses its own music track. Initial log SHA-256
`a274eb2a57e3c84f5d9474fb5a542247ff976b3154a334fd7576c6e4695fc293` at
`/tmp/video-v2-unit-dev.log`. Development typecheck also caught assignment to a
readonly capture hash and missing DOM directory iterator typing. Replaced capture
immutably and added the same explicit iterator type used by the existing harness.
Final checks pass without suppressions or changes to Video Core validators.

## Remaining gates / NOT RUN

- Full repository unit/E2E regression, real admitted media roundtrip, codec/audio
  decoding, mobile/real device, v2 unknown-outcome fault injection, physical power
  loss and platform durability: NOT RUN in this slice. Existing v1 coordinator
  unknown/recovery regressions do not certify all v2 UI paths.
- No automatic original probing on archive open is claimed. Corrected Video-owned
  raw-byte probe and any caller use of it remain separate admission gates.
- No new public API compatibility promise, ordinary/shared Host registration,
  automatic migration, #208 visual acceptance or complete M2/M4 acceptance.
- Numeric 512 MiB archive / 2 GiB total proposal remains unanswered and unapplied;
  no GC/history deletion, policy migration, dependency adoption or capacity default.
- No CI enable/dispatch, performance measurement, main merge, package publication,
  deploy or release. Private source branches and Draft PR only.
