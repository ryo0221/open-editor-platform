# File-backed archive candidate verification

Exact tested source: **`8fdb9d0f8acbd92cf327e6012809311ca68d2e4d`**.
Base #168 HEAD: `5b260e6013e9b678793c5625ab94a32aea729fc7`.
Main checked unchanged: `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
This record is a documentation-only follow-up. Private adoption remains pending.

Early ownership/adapter checkpoint
preceded implementation. Only new `packages/video-metadata/file-backed-storage/**`
files were created. No existing Host, Core, bundle, import, codec, package export,
root manifest, lockfile or configuration edits. See README for the concrete Host
adapter proposal and remaining integration/recovery gates.

## Results at exact source

| Check                                                          | Result                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| New file-backed/ZIP64 functional tests                         | PASS, 30 tests (F01–F13 including parameterized negatives) |
| Existing original-media Host workflow                          | PASS, 29 tests                                             |
| Existing Video Core/media                                      | PASS, 54 tests                                             |
| Combined focused unit                                          | PASS, 113 tests / 4 files                                  |
| Root lint                                                      | PASS                                                       |
| Root typecheck                                                 | PASS                                                       |
| Root build: TypeScript + both Vite targets + fixed font hashes | PASS                                                       |
| Repository file policy / diff whitespace                       | PASS                                                       |
| Python standard ZIP reader on actual large archive             | PASS, STORE member streaming and CRC checks                |
| Browser/UI/SaveCoordinator integration of this candidate       | NOT RUN; deliberately not connected                        |
| OPFS/File System Access/Windows/iPhone                         | NOT RUN                                                    |
| >4GiB actual data / general size guarantees                    | NOT RUN / not claimed                                      |
| Crash/power-loss/durable operation journal                     | NOT RUN / not implemented                                  |
| Full repository regression / whole product acceptance          | NOT RUN                                                    |
| Performance / CI dispatch / merge / release                    | NOT RUN; holds unchanged                                   |

The large functional fixture writes 640 chunks of 65,536 bytes to disk: **40 MiB
actual synthetic original bytes**, plus native/manifest/ZIP metadata. The archive
is asserted larger than32 MiB. All original reader requests are asserted at most
64 KiB. No sparse-file shortcut or whole-archive buffer occurs in that fixture.
The selected native version has no media; its retained parent alone requires the
original. After save, the source handle closes and original file is deleted.
A fresh file reader reconstructs both full native envelopes, selected version,
interpretation and original range solely from the portable file. Entry and archive
SHA-256 checks pass, and a separate Python ZIP reader consumes every member in
64 KiB reads and independently checks STORE/CRC integrity.

Small corruption fixtures intentionally buffer only their tiny synthetic archives
for mutation. These are not the large-file execution path. Functional tests retain
all old-file bytes after quota failure, mid-write abort and actual
staging-header corruption. The latter proves final publish was never called and
the stage was removed. Lost acknowledgement produces unknown and blocks new saves;
correlated readback settles it once. Missing/foreign/tampered targets remain
unknown. No earlier complete file is unlinked before successful atomic replacement.

JSON/ZIP bounds, CRC, exact entry SHA and native canonical hash are independent
checks. F10/F11 construct internally consistent ZIP bytes that nevertheless have
missing/extra originals or a wrong native canonical hash; the reader rejects them.
F03 mutates both local and central names consistently and still rejects duplicate
paths. No filesystem path is derived from an archive entry.

## Reproduction

Linux, Node24.19.0, repository-installed Vitest/toolchain and Python3 standard
library. No new dependency installation, browser download, external media service,
real desktop permission request or performance measurement.

```sh
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-core/src
npm run lint
npm run typecheck
npm run build
npm run check:files
```

Tests generate/delete synthetic files under temporary directories. Raw logs remain
outside Git; no source media/bundle/output bytes are uploaded to another service.

| External log                     | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `/tmp/video-file-8fdb-unit.log`  | `6f5626ddbc8203746eaa84f6775d7fa5ba8ef50c48945485b00918b1032e6647` |
| `/tmp/video-file-8fdb-lint.log`  | `62b8b4e023399c59cc1e7331f5d2722fd33f4dab9be6f11e136f58b68e10b3d6` |
| `/tmp/video-file-8fdb-type.log`  | `94d442b9e5ee147a71623cadc9818f0e017d0cea0565b41435d4e461cbd58280` |
| `/tmp/video-file-8fdb-build.log` | `fac84839d744efd84bc57284bf4c4e7915fabe1fba3cdd587ea16d17ae2bedb5` |
| `/tmp/video-file-8fdb-files.log` | `dd68f0c66bef8036586b96544278cfc7780e3ff33a4a76ad317360b00d4aff1e` |

## Initial development checks and limits

Initial lint caught a cleanup throw inside `finally`; cleanup was changed to
inspect both settlement results outside finally, retaining the target lock on
cleanup failure. Initial typecheck caught two test mutations of readonly capture
fields; fixtures now replace those records. Logs remain at
`/tmp/video-file-lint-initial.log` and `/tmp/video-file-types2.log`. Earlier functional
runs passed26 then29 tests; the final30 adds real staging-file corruption. None of
these intermediate runs is substituted for the exact source results above.

This is evidence of a bounded, file-backed portable archive candidate. It does not
certify original-media probing/preview at40MiB, the existing browser product's
16MiB import limit, VBP0 replacement, durable restart settlement or all ZIP tools.
Host adoption, permanent budgets/profile and cross-platform filesystem guarantees
need separate review. Existing draft/native limits and codec limits stay intact.
