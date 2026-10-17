# Private v2 portable storage candidate

This Storage-only candidate connects the exact private #210 `PersistenceFactoryV2`
port to the existing profile journal. It is not normal Host registration, public API
adoption, production media admission or a capacity-policy approval.

Dependency base `a171dfb02f7a060e990714573a9f6b1c60d93eda` combines accepted Storage
#209 `eb8c24edf72a1d6465030e05fc861839517b462b` (including #205 ownership fix),
corrected #207 `c0ab0657d784520d398115161b768fb33663ee42` / runtime
`33907d8b38d20f6930734bfa54367fc2ff84f277`, and private #210
`9fd99094fb9f1e009fd26ca370ec2b4741f0e394`. Video-owned files are unchanged
from those pins. That dependency merge is private verification only: it does not
accept #208 visual output or imply main adoption.

## Contract

- `portable/v2.ts` explicitly binds `video-file-zip64-candidate-v2` to the corrected
  v2 native validator and Video-owned AV/mono-AAC interpretation import functions.
  Each retained native version, plan, source interpretation, original size/hash,
  parent chain and selected capture is checked by the existing bounded engine.
- `portable/versioned.ts` is the new explicit v0/v1/v2 dispatcher. The existing
  v0/v1 writers and `createVersionedProject` stay unchanged; that legacy reader
  still refuses v2. Unknown and mixed schemas reject; no upgrade/relabel fallback.
- External-file verification now dispatches v2. `createPersistenceFactoryV1`
  still refuses anything except v1 before publishing a target journal or catalog.
- `integration/persistence-v2.ts` implements the exact private v2 factory, with
  fresh candidate namespace, full retained history, selected live source catalog,
  scoped in-flight drain, portable leases and same-owner reconcile evidence.
  Lifecycle code follows the accepted v1 factory without refactoring its runtime.
- `capacity` remains optional explicit Host input. When supplied, the same #205
  accounting and scratch-path ownership enforcement apply. No new defaults,
  cap raise, policy migration, archive deletion or GC is introduced. Legacy
  writers bypassing this optional policy are still outside global enforcement.
- Codec admission is separate. Interpretation metadata lacks channel count;
  archive verification cannot prove original bytes contain mono AAC, SDR video,
  or decodable media. Raw-byte admission remains the corrected Video Host probe.
  Synthetic fixture bytes in this test must not be presented as playable media.

## Functional acceptance map

| ID     | Scenario / expected evidence                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2-01  | AV + independent audio gain/fade, fractional timing, two versions; selected and retained-only sources roundtrip unchanged                                                                                  |
| V2-02  | v0/v1 immutable history and full ZIP SHA golden; legacy writer bytes unchanged                                                                                                                             |
| V2-03  | Unknown archive/profile, v1 label/plan, extra fields, unsupported channel claim, native-plan mismatch and missing retained original reject after ZIP rebuild                                               |
| V2-04  | Selected and retained unknown/v1 native, invalid gain/fade/noncanonical rational reject with native contentHash, native entry SHA, manifest capture, all ZIP CRCs and whole archive SHA recomputed/checked |
| V2-05  | Previously overflowing valid high-denominator fade anchors survive archive; exact corrected gain equals independent BigInt fraction                                                                        |
| V2-B01 | Existing v1 factory refuses v2 before altering live catalog or OPFS                                                                                                                                        |
| V2-B02 | Actual #210 Host/SaveCoordinator edit + save, old native versions unchanged, old v0/v1 files unchanged, reservation settled                                                                                |
| V2-B03 | Fresh namespace/Host reopen + save, four versions, prior namespace bytes and hashes unchanged                                                                                                              |
| V2-B04 | Retained-only originals verified without populating selected empty live catalog                                                                                                                            |

The Node suite has 14 test cases (V2-04 loops five faults for each of two version
positions). Browser runner has four functional groups. Raw reports, bundle
provenance and synthetic archives stay outside Git. No real media or private
location data is downloaded or sent.

Commands, exact source results and failures are in V2-VERIFICATION.md. Required
next gates: independent review of this private archive/factory contract, Video
owner wiring to the selected private Host, actual admitted-media verification,
and separate decision on any larger archive/total policy. The unanswered
512 MiB / 2 GiB proposal is not applied. Existing 1 GiB journal and 256 MiB
scratch/external test configuration remain. Four-MiB total in the generated
fixture is test policy only, not a production default or capacity guarantee.
