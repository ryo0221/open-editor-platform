# Proposed ADR: exact audio presentation validity over an integer sample grid

Status: **implementation direction approved by the user on 2026-10-13**.
Versioned implementation proceeds in separately reviewed commits; approval does
not certify the portable/codec/Host acceptance gates below.
This refines #183's preferred rational-boundary option; it does not adopt rounding
or a shortened source interval. #181 storage integration remains held.

## Problem and coordinate systems

The unchanged iPhone original has a track edit [0,T), T=42251/600 seconds. Audio
rate r=44100 gives T\*r=6210897/2=3105448.5. The metadata sample grid spans 3107840
sample positions. A rounded 3105449 duration or floor 3105448 duration changes T.
The current AudioClip invariant duration=(sampleOut-sampleIn)/r cannot encode T.

Keep three coordinates separate:

- Integer decoded sample address n, on a declared source sample grid.
- Raw source-media time M(n)=sampleOrigin+n/r; actual packet/sample coverage must
  prove that requested n values exist. A declared grid is not fabricated PCM.
- Source presentation time P=mediaPresentationOrigin+M, and sequence time t with
  an independent clip placement. Nothing rebases the original bytes/timestamps.

All native times remain existing canonical `Time` safe-integer numerator/denominator
values. Arithmetic/comparison uses the existing BigInt-backed helpers. **Time,
sampleIndex's exact/no-rounding behavior, MediaReader/MediaLease and artifact
lifecycle/SaveCapture/WriteEvidence do not need changes.**

## Proposed versioned Core shape

New opt-in `VideoContentV1` discriminator: `video-core-prototype-v1`. Existing
`VideoContent`/v0 entrypoints remain valid and unchanged initially. Add explicit
versioned validation/evaluation/command entrypoints after API approval, sharing
internal invariant logic rather than another EditorSession/Undo implementation.
Other source/track/sequence identities and VideoClip fields keep their v0 meaning.

Proposed strict audio records (names are review proposals, not exports):

```ts
interface AudioStreamV1 {
  id: string;
  kind: 'audio';
  sampleRate: number;
  sampleCount: number;
  sampleOrigin: Time;
  presentationOrigin: Time;
  validity: { start: Time; end: Time };
}
interface AudioClipV1 {
  id: string;
  kind: 'audio';
  trackId: string;
  sourceId: string;
  streamId: string;
  start: Time;
  duration: Time;
  sourceIn: Time;
  sourceOut: Time;
  linkGroupId?: string;
}
```

`sampleCount` is the declared integer grid extent [0,N), not the length of the
presentation edit and not a claim that an unverified decoder returned N frames.
`sampleOrigin` is raw media time of sample address0. `presentationOrigin` is source
presentation time of raw media time0, matching the existing VideoStream convention.
`validity` is the original selected track's exact raw-media presentation interval,
not the current clip trim. Decoder-only head/tail padding outside that interval is
not presented; extra decoder padding outside declared grid extent is separately
accounted for and never admitted as valid source samples.

AudioClip sourceIn/sourceOut are **source presentation coordinates**, matching
VideoClip's convention. Do not retain redundant serialized sampleIn/sampleOut in
v1. For unity-speed audio:

- duration = sourceOut - sourceIn, exactly.
- At sequence t in [start,start+duration), P=sourceIn+(t-start).
- Raw M=P-stream.presentationOrigin.
- Fractional source-sample position x=(M-stream.sampleOrigin)\*r.

x may be rational. Actual decoder/read addresses remain integers. Fractional
positions are reconstruction queries, not fractional array indices or a new
sample rate. No audio speed/gain/mixing/resampler algorithm is added by this ADR.

The source grid is bounded: N is a positive safe integer, r remains within the
existing rate bound; all mapped endpoints must be representable. Require
sampleOrigin <= validity.start < validity.end <= sampleOrigin+N/r. The valid
integer point set is [ceil((validity.start-sampleOrigin)*r),
ceil((validity.end-sampleOrigin)*r)); it must contain at least one point. Each clip's
raw interval must be contained in validity; placement/end, track/type/link/lock,
nonoverlap, unique-ID and total native budget checks remain. Unknown fields and
schema tags reject. A metadata grid never authorizes zero-fill for missing PCM.

For this original: sampleOrigin=0, presentationOrigin=0, N=3107840,
validity=[0,42251/600), clip sourceIn=0/sourceOut=T/duration=T. The last valid integer
point is3105448; its distance before T is1/88200 seconds. Point3105449 is outside.
The ceiling computes a **set of discrete points**, not a replacement endpoint.
The last point is not multiplied by0.5; rational validity is a time interval,
not an amplitude/fade instruction.

## Editing and evaluation

Affected Core files are `src/model.ts`, `validation.ts`, `commands.ts`, `evaluate.ts`
and versioned exports/tests. Existing v0 `slice()` continues its exact sampleIndex
rule. The proposed v1 audio slice shifts sourceIn by the rational sequence offset,
sets sourceOut=sourceIn+new duration and preserves original stream validity/grid.
Trim may choose a fractional source position explicitly; split at rational t gives
left [start,t) and right [t,end), with exactly adjacent source endpoints. A point
exactly at the cut belongs only to the right. Linked cohort/lock checks are unchanged.
Move/ripple shift sequence placement, not source validity or original sample grid.
Delete/reorder/link/unlink keep existing native transactions and Undo authority.

Versioned evaluate returns the existing source presentation request shape. It does
not request audio at clip/sequence exclusive ends. UI sample-specific commands may
still explicitly snap to the source grid; the generic rational edit command must
not secretly snap. Undo/Redo restores exact rational fields through the ordinary
native command/session path. No schema transition is inserted into an old Undo
stack or effected by a hidden metadata rewrite.

## Import and exact interpretation

Propose a new strict interpretation discriminator `video-media-interpretation-v1`.
The outer record is `{format, streams}`. Selected video entries retain current
id/kind/destination/mediaStart/mediaEnd/presentationStart. Selected audio entries
retain those fields and sampleRate, adding **sampleOrigin and sampleCount** for the
independently validated integer source grid. In v1 only, mediaStart/mediaEnd are
explicitly the rational original validity, not rounded decoded array bounds.

A versioned `prepareImportSetV1` derives audio validity=[mediaStart,mediaEnd),
presentationOrigin=presentationStart-mediaStart, and initial sourceIn=
presentationStart/sourceOut=presentationStart+(mediaEnd-mediaStart). It derives
initial sequence placement using existing exact relative track presentation starts.
No sampleIndex(duration,r) divisibility condition applies to v1 presentation spans.
The old untagged `{streams}` ImportSet and prepareImportSet remain v0-only.

Probe/parser must independently prove raw packet clocks, edit placement, sample
table hierarchy/ranges, grid origin/extent, codec interpretation, and supported
orientation/color/channel layout. Reopening must re-probe pinned original bytes
and compare the admitted interpretation exactly, not trust caller-supplied N or
validity. Metadata integrity/portable closure does not by itself prove codec or
continuous PCM coverage. AAC microseconds remain consistency checks; integer
sample/packet association and actual AudioData frame counts establish coverage.

Affected Host files: import.ts (versioned preparation/staging), mp4-probe.ts or a
versioned bounded probe, indexed-media/pcm-file.mjs, timeline.mjs, native playback
and product-codec.mjs. Unknown QuickTime version/color/matrix/codec semantics remain
explicit unsupported gates. The original146163851 bytes and SHA never change.

## Reconstruction, preview and export boundaries

Use the same rational mapping, global output-sample phase and original validity
for preview and export. To present clip [a,b) at output rate R, select integer
output indices k with a <= k/R < b, i.e. [ceil(aR),ceil(bR)). Adjacent clips cannot
reset their phase or duplicate a boundary sample. Decode/index windows cover the
needed integer kernel taps; missing interior support fails. Original valid sample
point membership is calculated against the rational validity, not an integerized
copy of its endpoint.

The reviewed edge-hold mode applies only beyond the **original** valid point set.
It must not clamp to a trim edge, scratch/read-window edge, missing packet, or
rebuffer boundary. Kernel support may extend outside the selected clip into valid
original material. No silent zero padding, clipping, endpoint normalization or
new fade policy. Preview's output-clock ownership/underrun/suspend/seek rules stay
with the reviewed Host player, including explicitly labeled estimated fallback.

For the complete fixture at R=48000, T*R=3380080 exactly. It therefore has3380080
valid output sample points, but this alone does **not** certify whole-source export.
At25fps, T*25=1760+11/24. The proposed video output plan has1761 presentation
intervals: ordinary [i/25,(i+1)/25), and final [1760/25,T)=[70.4,42251/600), whose
length is11/600 seconds. Select its image by the same raw VFR source PTS rule at
70.4; do not extend the movie to70.44 or drop the final interval.

Proposed MP4 policy: separate rational presentation end T from integer encoded
sample counts and codec padding. Choose a bounded exact movie/video timescale M
that represents admitted frame points and T (e.g.48000 for this fixture: normal
frame1920 ticks, final880 ticks, movie3380080 ticks). Audio media timescale remains
R. If T*R is fractional for another admitted file, encode ceil(T*R) sampled values
and express the exact presentation endpoint through movie-unit edit duration,
not count/R. Check LCM, timestamp, table-size and duration bounds before encoding;
if an exact supported clock cannot be represented, refuse export.

`encoder-timing.mjs` would need a reviewed signature separating presentation
interval, sampled PCM count, exact video frame plan and actual encoded packet
proof. Native WebCodecs microsecond timestamps cannot be the authoritative movie
clock. The muxer output must be verified/adjusted against the exact rational plan
without changing coded payloads. B-frame DTS/CTS and final packet duration must be
proved for the admitted encoder profile; otherwise reject that export profile.

**Gate, not a claim:** shorter final video presentation interval and exact movie
edit need actual pinned muxer + independent decoder compatibility checks. Current
whole-frame/10second export restrictions may continue to refuse whole-original
export until those pass. Full exact import, shorter edited exports, and whole-source
export are separate gates. Do not use integer48kHz audio length to conflate them.

## Portable schemas and backward compatibility

Initial adoption should be new-project opt-in, with no automatic v0 migration.
Keep v0 content bytes, old hashes, version IDs, parent links, captures and journal
records unchanged. Opening a v0 project continues through its v0 validator/Host
route. Inserting a v1-only source into a v0 project must explicitly refuse or offer
a separately reviewed migration; it must not change the project's schema in place.
Standalone v0 content lacks raw media binding facts for a truthful conversion.

Proposed v1 native envelopes use schemaVersion2 and content.schema v1; v0 envelopes
remain schemaVersion1/v0. Propose `video-file-zip64-candidate-v1` manifest discriminator
for projects with the new interpretation/native schema. ZIP64 STORE framing,
original hash filenames, original bytes, canonical JSON rules, metadata bounds,
capture/retained-parent closure and journal protocol stay unchanged. In the initial
profile, a v1 project has v1 retained native versions; unsupported mixed-schema
histories reject explicitly until a migration contract is reviewed. No retained
v0 record is relabeled or rehashed to simulate compatibility.

The single shared portable validator dispatches explicitly on manifest/native/
interpretation versions. It derives source records using the matching Core/import
validator and compares canonical results for **every retained version**, not only
the selected draft. Unknown versions, mismatched triples, altered origins/validity/
counts, wrong asset length/hash, extra interpretations and missing retained-only
originals reject. New readers support existing v0 portable files unchanged; old
readers reject v1 formats rather than ignoring added fields. The old VBP scaffold
is not expanded into a large-file or v1 format by this work.

Affected storage-owned code: portable/project.ts and its Project/Manifest/version
dispatch, browser-verifier/adapter.ts return types, integration/storage.ts history
binding and external-file-open conversion, fixtures/tests. This is a requested
patch contract, not authorization for Video to edit the storage lane concurrently.
Codec validation remains a separate Host re-probe gate after portable verification.
Shared lifecycle, save evidence and current-capture marking semantics do not change.

## Acceptance matrix (all proposed-contract rows NOT RUN)

1. Exact original import: T unchanged, integer grid facts unchanged, original SHA
   unchanged; initial audio/video placement ends exactly at T. Reject validity
   outside grid, noncanonical/overflow times, unknown fields and missing grid data.
2. Positive/negative sample-grid origins and nonzero presentation origins: preserve
   source mapping; integer-aligned v1 cases match v0's evaluated presentation times.
3. Half-sample and fractional-start validity: ceil point selection, exact-end
   exclusion and full-amplitude last valid point; no invented sample or duration.
4. Fractional trim/split/link/move/ripple/Undo/Redo: exact adjacent source endpoints,
   correct current revision/authority checks, no phase restart or validity rewrite.
5. Continuous decode callbacks: actual count/rate/channel proof; missing/duplicate
   interior samples reject; terminal padding remains outside validity. Test filter
   taps beyond trim but inside original, and refusal at missing read-window support.
6. Preview/export common PCM across multiple chunk sizes, seek near source end,
   cuts/reorder and original endpoints, at44100→48000 mono. No silent stereo copy.
7. Exact final-video interval:1761 frames with last880/48000 duration, exact total
   T, independent FFprobe/decoded PTS and visible last-frame marker. Test AAC edit,
   decoded padding, muxer readback, browser playback end and external decoders.
8. Portable original-inclusive save → new empty Host (no old journal/source cache):
   verify full SHA/native/interpretation/retained closure; reproduce mappings and
   edited output. Reject unknown schema or native/interpretation clock mismatch.
9. v0 regression: legacy schema/input rejection behavior and hashes unchanged;
   byte-preserved original/retained records. No automatic migration/Undo reset.
10. File-backed lifecycle/resource gates: delayed reads, revoke, decode/cleanup
    failures, unknown saves, imported-B-during-captured-A, reconciliation and
    cross-owner stale-head behavior. #181 corrected successor required.

Only existing read-only original/codec feasibility and structural validation are
implemented separately. This ADR does not lift design, storage, codec, full-device,
performance, CI, merge or release gates.
