# M2 private portable media integration

Tested clean code: `1421e7aae7bfd016c33f713d33fcb625966c4896`.
Approved dependency merge: `3bc6b95a1191ed53c097a14af09c23a0f380ceaf`,
with Video #214 `4e71b2868c9dff6c4c478b366b0a0c8dbdc3c589` and reviewed
Storage #213 `047596e02c087471b90cc86c5dcde1eae35888c7` as parents.
Storage runtime remains #212 `524af950ea237096f5ed646793dc4dd6c861be27`.
This authorized private integration does not register the normal Host or #76 API.

## Admission and ownership

`createAdmittedPersistenceV2` opens the bounded v2 archive and verifies every
retained native version's source against its original bytes before calling the
reviewed Storage factory. Verification binds SHA/size and raw media metadata to
the exact source interpretation. The per-opening cache uses the entire source's
content hash, not just original SHA. External leases are released in finally,
including rejection/abort; the same immutable input Blob then reaches Storage.
Invalid retained media cannot publish a target journal, namespace or live catalog.
Valid retained-only originals remain available to history without joining the
selected version's live catalog.

This is raw metadata/source-binding admission, not universal decoder-support
certification. The explicit mono AAC-only profile is checked early; AV admission
and downstream decoder bounds preserve the existing profile semantics.
The private bootstrap supplies the existing scoped SaveCoordinator and v2 factory,
with journal1GiB and external/scratch256MiB unchanged. It supplies no optional
total-capacity policy and makes no new global-capacity guarantee. Its allow-all
authorization callback belongs only to this local reference Host.
Artifact envelope1/native v2 are unchanged. Output canvas/background remain
explicit per-job Host settings, not silently persisted native fields.

## Exact-pin results

At the tested code above, all of the following are PASS:

- Root `npm run typecheck`, `lint`, `build`, `check:files`.
- Focused Vitest:173 tests /15 files, using `--maxWorkers=1` and paths
  `packages/video-core/src`, `packages/video-core/experiments/pcm-renderer/boundary.test.ts`,
  `packages/video-metadata/host-media/m2`, `packages/video-metadata/file-backed-storage`.
- New portable browser gate:5 groups, browser errors0.
- Existing Storage v2 integration, v2 ownership faults, legacy v1 integration,
  and capacity-coordinator gates. Their synthetic metadata/fault scopes are
  unchanged and are not substitutes for real decoded-media verification.

The new gate uses small actual decodable locally generated media from #214:
729574-byte rotated AVC/AAC,111786-byte landscape AVC/AAC and35430-byte mono AAC.
They are generated fixtures, not shortened/proxied university originals.
The Host imports/edits the three sources, explicitly sets both voice gains25%
and music20%, saves once, sets music fades, then saves a second retained version.

Selected-stereo and retained-only-stereo archives have recomputed valid content
hashes, entry CRCs and whole-archive integrity; opening either rejects at raw mono
admission, preserves the current native/revision and creates no target namespace.
A positive retained-only mono case opens with selectedSources2/liveOriginals2/
retainedOriginals3 and closes its owner.

Fresh browser contexts at1280 and390 pixels first prove empty OPFS before mounting
the Host, then open only the saved archive. Both recover the exact native content,
preview, play, export an MP4 that FFmpeg decodes, and save a third version preserving
the previous two versions and original SHA keys. No horizontal overflow; all three
screenshots inspected.390 is desktop Chromium mobile-layout coverage, not hardware
mobile certification. These exported downloads are decode checks, not an independent
full PCM/pixel oracle; #214 retains its separately pinned generated-output oracle.

## Reproduction and development failures

`node packages/video-metadata/host-media/m2/portable-check.mjs /workspace/video-codec-eval/deps /tmp/video-delivery-final /tmp/video-portable-m2-pinned`
requires the locally generated #214 fixtures in the second argument. Use fresh
output directories on reruns. Existing Storage runners under
`file-backed-storage/integration` are `v2-check.mjs`, `v2-ownership-check.mjs`,
`v1-check.mjs`, and `capacity-coordinator-check.mjs`, each taking an output directory.
Summary `/tmp/video-portable-m2-checks.json`; gate logs
`/tmp/video-portable-m2-*.log`; portable report/screenshots/downloads in
`/tmp/video-portable-m2-pinned`. Raw evidence remains outside Git.

Prototype FAILs remain recorded: JSON-string comparison incorrectly depended on
object key order after canonical archive serialization; compare parsed native
values instead. The initial loud fixture mix correctly failed the final clipping
guard; the harness now explicitly edits voice gains25%, without normalization or
a relaxed product guard. Focused lint found unused OPFS iteration values, fixed
before the tested pin. Logs `pre.log` and `pre2.log` under the same prefix preserve
the failures; later prototype passes do not replace the clean exact-pin results.

## Held work

The two unchanged university originals total298716660 bytes, exceeding the current
256MiB portable bound. Combined actual-original portable is BLOCKED pending explicit
numerical capacity approval; no cap increase or history deletion was made.
Normal Host adoption, Rust integration, broad codec support, hardware mobile and
performance acceptance are NOT RUN here. No Actions dispatch, main push/merge,
deployment, publication or license change. This is not full M2/Epic completion.
Main observed `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`; workflows remain manual-only,
with CI/file-size/Office disabled manually.
