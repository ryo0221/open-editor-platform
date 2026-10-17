# MP4 hierarchy defense checkpoint

Successor to #182, with #182's pinned branch unchanged. Final implementation
`c8d02a6abbe08c3343b14ad3fc1d7b5c7d999064` (logic `d9dd954f`, declaration fix
`c8d02a6a`). Independent review is still required.

## Reason and scope

Source review of pinned Mediabunny1.61.3 found generic recursive container parsing
and a track sample-table location overwritten when another table is encountered.
Canonical-path checks alone did not cover every parser-interpreted location.
`mp4Index` now calls a bounded hierarchy validator before any indexed reader
constructs Input. It validates root/movie/track/media/edit/sample-table paths,
required singletons and duplicates, competing offset tables, sample descriptions
and codec children, QuickTime wave and metadata recursion. Audio/video entry
layout must agree with its track handler. The auxiliary QuickTime data handler
cannot redefine track kind. Data references must be self-contained.

Unknown constructs refuse the current narrow profile. Existing independent table,
packet count/size and scratch bounds still apply. Opaque metadata leaves remain
bounded by the existing 8MiB moov cap; this is not a general ISO BMFF validator.
The real iPhone original's sdtp/QuickTime/color/orientation admission remains a
separate expansion: do not infer it from this generated AVC/AAC regression.

The original finding was **source analysis**, not an executed reproduction. The
reviewer's synthetic execution was blocked by platform safety review. It was not
recreated or rerouted here. New tests pass plain box-kind lists only to our pure
grammar; integration uses the ordinary generated 48-second source. No malformed
input was sent to an external demuxer to reproduce the blocked probe.

## Verification

Initial exact code `d9dd954f7a1cb7fd92403933df738a50d746b07e`: typecheck and build
FAIL (TS7016 missing declaration for the new .mjs module). Lint, 243 scoped tests,
file policy, ordinary indexed-reader browser checks and actual integration PASS.
The declaration-only follow-up fixes that type boundary; it does not suppress the
error or alter runtime behavior. Initial logs `/tmp/video-hierarchy-*-pinned.log`.

At final exact code c8d02a6abbe08c3343b14ad3fc1d7b5c7d999064, Node24.19,
npm11.9, Chromium151:

- PASS root typecheck, lint, build, repository file policy.
- PASS 243 scoped Video Core/metadata tests, including 3 new pure grammar cases.
- PASS ordinary indexed-reader browser checks: verified late GOP seek, bounded
  PCM windows, scratch release/resource cases and browser errors zero.
- PASS ordinary real Host integration at1280/390: import original, late seek,
  split/independent trim/linked move, portable save then empty-context reopen,
  real AudioContext playback/seek/stop/suspend/underrun, actual AVC+AAC export.
  Independent FFmpeg decode:4seconds,100video frames,192000valid stereo frames,
  allfinite, retained right impulse atsample34560, removed left impulse absent
  (maxLeft0.0507874). Head/cut/tail PCM comparisons maxdiff0.0075083/0.0011895/
  0.0015123. Browser errors zero; mobile screenshot inspected.
  Final output SHA1280:3dbc6ae3c7bc5ec36da455714a101ab257b05c5ba3378ce1e1afb90179fca720;
  SHA390:ab2160dff2be38a1a0589b00fc022e42f091ee94870ebf6d118fc55a21561419.
  This is generated-source/v0 regression, not iPhone/v1 acceptance.

Final raw logs: `/tmp/video-hierarchy-{type,lint,unit,build,files,reader,integration}-final.log`.
Reader and integration results/screenshots stay outside Git under the corresponding
`/tmp/video-hierarchy-{reader,integration}-final/` directories.

NOT RUN: the denied synthetic demuxer repro; full iPhone import, full-original
export and general codecs; performance/real devices. Neither #184 storage nor
#186 rational native schema is incorporated into this branch. No broader
acceptance is inferred from these narrow checks.

No denied-probe reproduction, dependency/root/Core/storage change, CI dispatch,
performance measurement, main push, merge, deployment, release or license change.
