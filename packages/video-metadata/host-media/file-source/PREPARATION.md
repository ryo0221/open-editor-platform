# File-backed iPhone integration preparation — decisions not adopted

Separate branch `codex/issue-75-file-source-integration`; #180 remains unchanged.
Read-only native-codec feasibility code: `81e2fb7a` (full SHA in the verification
report). The real product path is not wired and the16MiB whole-buffer import limit
is not raised. No input proxy/transcode is substituted for the original.

## Verified input and concrete timing blocker

Original `/workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov`:
146163851bytes, SHA256
`69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`.
Unmodified public VISION iPhone6 original, user-authorized download. Attribution:
CSP Lab., Department of Information Engineering, University of Florence (2017),
CC BY-SA4.0. README/CSV/ffprobe/packet metadata remain alongside it outside Git.

The trailing moov is only30296bytes at offset146133555. Stored video is1920×1080,
display1080×1920,90°clockwise (FFmpeg reports−90°). Source PTS ticks are1/600;
2113 frames use19/600 and20/600 intervals. Audio is mono AAC-LC44100Hz. Its sample
entry is QuickTime version1 with wave/esds; video uses nclc1/1/1, not nclx.
These are explicit admission differences, not reasons to reinterpret the input.

**Important time decision:** both track edit spans are42251/600seconds. For audio,
that is **3105448.5 source samples**, while the coded stts total is3107840 samples.
Current `prepareImportSet` rejects fractional source spans; current Core requires
an AudioClip duration to equal its integer sample interval. Current PCM scratch
also requires an integer edit end. Merely changing file-size limits cannot admit
this original truthfully. FFprobe's rounded3105449 duration is not an exact oracle
for a native boundary policy. No silent floor/ceil or replacement input is adopted.

Options requiring parent/user decision:

1. **Recommended for full exact-source acceptance:** retain the rational container
   validity separately from the discrete decoded-sample domain, with a reviewed
   native/interpretation representation for a partial terminal sample interval.
   The original rational edit remains exact; samples remain integer-addressed.
   This requires a Core/interpretation/portable-validation contract review, not a
   local Host-only cast. Do not silently change the prototype schema.
2. **Narrow temporary selection policy:** explicitly import a whole-sample selected
   audio subinterval ending at floor3105448 while retaining the complete original
   and reporting the omitted terminal half-sample-equivalent interval (~11.34µs).
   The selected interval must remain distinct from original filter support; an
   arbitrary selected edge cannot become an edge-hold original boundary. This is
   not acceptance of the full original presentation. Any initial alignment/gap
   and user-visible policy must be approved before implementation.
3. Continue exact refusal until option1 is approved. This is the present behavior.

The planned trimmed/reordered acceptance ranges can lie on integer sample and
25fps sequence grids inside the original, but that alone does not resolve the
initial import/whole-source interpretation. No contract choice is fixed here.

## Storage ownership and conditional composition

Read-only handoff pin #181 `b807de140f96c129f8aca0be56da36c0869e10cc` retains limited-GO
#172 `414514241ee0dff13159635826c7493f513c2865`, #178
`28f467f35ad5bf75a38ea80650da7162884fb32a`, and #179
`e0e09a9b364d261c9b60e1266efa2cd85021d717`. Its new normal-coordinator integration is **HOLD**: completing capture A can
overwrite live original/plan B imported during that save. Normal and reconciled
commit need correction; cross-owner stale-history/head binding is also under review.
Do not adopt this pin as final. Parent approved exact @noble/hashes1.8.0; storage owner owns
the owning manifest/lock entry/full MIT notice. Video will not duplicate those edits.

Initial coordination
and handoff request
assign final ordinary browser-host/import/codec wiring to Video. Storage owns the
JournalVideoStorage capture/write/reconcile/journal implementation and shared ZIP
validator. A new external portable-File open helper is requested: current
restore(operationId) handles journal recovery, but empty-Host reopen must accept
the downloaded archive without any original journal/OPFS cache. It must reuse
shared validated dataOffset/native closure logic and return immutable Blob slices
plus their owner, not cast an asynchronous range Reader into a Blob.

Planned private Host patch, conditional on review:

- Inject the reviewed streaming digest into original staging and export integrity
  checks, using64KiB reads and one in-flight range. Retain actual immutable File
  references; replace whole-original probe reads with bounded moov inspection.
  Do not merely enlarge MAX_ORIGINAL_BYTES or whole-arrayBuffer hash limits.
- Configure an explicit file-reference admission budget, archive scratch budget
  covering the entire original-inclusive ZIP, and cumulative journal reservation.
  The40MiB test's48MiB scratch default is insufficient. Proposed local fixture-only
  budgets:256MiB archive preparation and512MiB journal, checked with actual archive
  sizes and origin quota failures. These are not practical-capacity guarantees or
  automatic storage-persistence requests; no general product default is approved.
- Substitute the Storage object in the existing scoped installed.open binding.
  Configure capture callbacks before admission. Keep canonical EditorSession,
  native Undo, SaveCapture/WriteEvidence and SaveCoordinator unchanged.
- Retain original owners independently for live media, every retained version,
  and unsettled saves. Playback scratch disposal cannot release original/unknown
  save ownership. Scope replacement must drain consumers before releasing its
  original owner; cleanup failure must not skip unrelated drains (#182).
- Download the verified completed archive File. External-file reopen verifies full
  archive/hash/native/original closure, derives File slices, and opens a new scoped
  session/grants. Never manufacture an old coordinator job or treat stored scopes
  as authorization. Reconcile live unknowns only through their actual owner.
- Include the full approved digest MIT notice in final generated bundle banners
  and notices/provenance. Source-only notice inclusion is insufficient.

## Codec preparation, without changing original bytes

VFR selection continues to use rational source PTS intervals. Right-angle source
orientation can be applied to decoded pixels after validating the exact matrix;
arbitrary transforms remain unsupported. Natural portrait output is proposed,
with no crop/stretch; no output geometry contract is fixed yet.

1080p decode must not multiply the previous64-frame cache into a large full-GOP
allocation. Proposed approach: sequential bounded packet/decode queues, close
nonselected output frames immediately, and retain only explicitly leased selected
frames under a pixel/byte budget. Full-resolution GOP cache expansion is not an
acceptable substitute for indexed reading.

Mono44100Hz native PCM should remain mono in scratch (about12.4MiB for this original),
with the existing rational renderer producing proposed mono48000Hz AAC output.
Do not duplicate mono into stereo silently. Existing filter phase/boundary rules
remain; no new resampler is proposed. Mono encoding, exact edit-end handling and
full preview/export/bundle acceptance remain to be implemented and reviewed.

## Read-only native feasibility evidence

`inspect-check.mjs` opens the actual146MB File, forbids original.arrayBuffer, reads
bounded metadata, checks declared packet sizes/ranges, and uses the existing pinned
Mediabunny/native WebCodecs configuration. It does not bypass ordinary import and
claim success: current probe refusal is recorded. It decodes one actual raw video
frame, rotates it90°clockwise, and compares the displayed image with independent
FFmpeg autorotation. It also actually decodes the first8 AAC packets as8192 mono
44100Hz samples. It does not yet test all source audio or export.

At the clean code pin: `/tmp/video-file-source-pinned/results.json` PASS, browser
errors0, independent oriented-frame mean absolute difference1.04011767/255,
max11 (declared mean tolerance<8). Node64KiB streaming SHA equals the preserved
original hash. The diagnostic screenshot is outside Git. No input bytes changed.

```sh
node packages/video-metadata/host-media/file-source/inspect-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /tmp/video-file-source-pinned
```

This is a concrete feasibility/contract checkpoint because exact time interpretation
and #181 composition review block adoption. Actual original import, full synchronized
playback, edits, portable save/reopen and MP4 export are NOT RUN/pending. No Actions,
performance measurement, main push, merge, deployment/publication or license change.
