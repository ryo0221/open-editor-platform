# M2 first multi-source slice — proposal, not an adopted contract

Base accepted private #198 runtime7cf47ab9/docs3b45be9f plus independently reviewed
#201 runtime463deb09/docsbbc154f9. Neither evidence set certifies this new slice.
No #76 public API, normal Host wiring, schema, dependency or capacity change is
adopted by this proposal. Shared/Extension owns normal Host and its33-case gate.

## Existing implementation to reuse

Video Core v1 already validates multiple sources/tracks, non-overlap on each track,
exact half-open source mappings, positive visual rate, independent audio placement,
link/unlink/trim/split/ripple, and atomic EditorSession Undo/Redo. evaluateSequenceV1
returns enabled-track source requests in track order. Reuse it, videoCommandV1,
audioMappingV1 and the existing resampler; do not create another domain/history.

Private Host import appends sources and retains immutable originals/plans. Storage
already validates all retained versions. But product timelinePlanV1 requires exactly
one source, both fully contiguous AV tracks and unity visual rate. Preview/export
assume a single oriented full-frame image; PCM renderer chooses one active clip.
Native v1 has NO gain/fade fields, and strict validation rejects additional fields.
ImportSetV1 currently requires one video, with optional audio; the probe profile is
AV-specific. Thus audio-only import and persistent gain/fade are not existing support.

## Smallest proposed useful end-to-end slice

Up to three originals: two sequential real AVC/SDR videos and a separately placed
mono AAC audio clip, with at most two active audio contributors. Keep the reviewed
25fps/48k output, exact source44.1/48k and existing90-second private sequence cap.
First visuals are cuts on one visual track, with explicit black for uncovered time;
audio gaps are zero. No implicit frame hold, rate conversion of linked audio, or
normalization. This is multi-source assembly, not picture-in-picture/alpha compositing.
The latter remains required M2 work, not silently deferred out of Issue75.

Reader admission remains existing #201 frame ceilings (two readers) and existing
PCM scratch limits (4files/128MiB, serialized index builds,2reads). Reuse/hash-key
readers; open sequentially; release inactive readers/leases without discarding
originals or retained history. Fail admission rather than increasing caps.

## Decisions to return before fixing output/persistence semantics

1. Persistent gain/fade: recommend a NEW private native/profile version with an
   explicit import/adoption step, leaving v0/v1 hashes and validators unchanged.
   Alternative is a reviewed additive revision with compatibility machinery; do
   not smuggle effects into private view state, loose sidecars or old v1 fields.
   Generic Artifact envelope remains1. Storage owner must own any new portable
   dispatch; no concurrent edits or new format implementation before agreement.
2. Gain/fade meaning: recommend amplitude gain0..1 and piecewise-linear amplitude
   envelopes whose exact rational anchors preserve the original time function on
   trim/split (slice with boundary values, not restart fade on each child). One
   fade-in/out UI can author those points. This needs approved model/command rules
   before implementation. Pan, dB UI, arbitrary automation and transitions remain
   subsequent original-Epic work.
3. Mix overflow (next profile only): gain<=1 does not prevent resampler overshoot
   or sum clipping. The common pipeline is resample -> evaluate gain/fade at the
   absolute sequence point k/R (mapped into the preserved envelope coordinates)
   -> stable track/clip-order summation -> final mixed-sample validation. Require
   every final sample to be finite and in [-1,1]. Do not range-reject finite partial
   sums: later contributors may cancel. Preview must validate the whole block before
   scheduling it; export must fail without committing a finished sink on violation.
   No automatic normalization/limiter/hard clipping. Existing v1's behavior remains
   unchanged; this new profile's semantics require approval. Preview/export share
   the same block renderer and policy.
4. Audio-only AAC/M4A: propose a separate explicit mono AAC profile using the
   existing decoder/rational clocks, not a fabricated video stream. Confirm this
   profile extension before changing probe/import acceptance. Independently
   positioned audio from an already admitted AV source can be tested immediately.

## Independent work started without those decisions

An isolated request planner owns a validated v1 snapshot, delegates visual requests
to evaluateSequenceV1, converts presentation origins exactly once, and intersects
all enabled audio clips with bounded output sample windows using half-open ceil
membership. It does not decode, mix, add effects, mutate native/history, or become
registered. This supplies a shared preview/export planning seam without inventing
new Core semantics. Tests cover two originals, separately placed audio, fractional
cut/gap boundaries, disabled tracks, existing trim/split commands, snapshot ownership
and chunk partition equivalence. No new native or mix policy is fixed by these tests.

## Following gates (NOT RUN, dependent work)

After decisions: real independent readers feeding one shared preview/export block
renderer; gain/fade commands via existing Session; multi-source import/Undo/save and
portable empty-origin reopen with originals retained; audio-only profile rejection
and capability tests. Independent FFmpeg oracles must check each selected source,
cut/gap boundaries, gain/fade amplitudes, full output PCM and video PTS, cancellation,
quota failure and resource drain. Real UI retains edited content throughout export.
Normal Host registration remains the Shared/Extension lane's work. Existing private
acceptance, physical mobile and the33-case legacy gate are reported separately.
No CI dispatch, performance measurement, main merge or release.

## Planner-only verification checkpoint

Code `d714b83216dff3217e29c3847dbffe8cb83e644c`, clean tree:
PASS root typecheck/lint/build/file policy;18tests across the6new planner tests and
12existing rational-v1 tests, serial execution. Commands: root npm scripts plus
`npx vitest run packages/video-metadata/host-media/m2/requests.test.ts packages/video-metadata/host-media/file-source/rational-v1.test.ts --no-file-parallelism`.
Logs `/tmp/video-m2-planner-{type,lint,build,files,unit}.log`; report
`/tmp/video-m2-planner-checks.json`, SHA256 `d2eb7facf10a1fae724a18ad3af5a16ef834c4f0fbe536236ea67bc646987ffd`.
No failed check in this checkpoint. Browser/codec/mix/portable acceptance NOT RUN;
there is no connected new runtime/UI to claim. Test assets are synthetic metadata,
not proof of two real decoded originals. Node24/Linux.

The local approved fixture inventory currently contains one real iPhone original;
a second independently sourced/licensed real AVC/SDR fixture is needed for the
following end-to-end gate. Reusing the same file under another source ID will not
be represented as proof of two independent originals. No extra media was fetched.

## Second real-original candidate — metadata/HEAD only, approval pending

Recommended: [D06_V_indoor_move_0002.mov](https://lesc.dinfo.unifi.it/VISION/dataset/D06_Apple_iPhone6/videos/indoor/D06_V_indoor_move_0002.mov),
University of Florence VISION. Official [manifest](https://lesc.dinfo.unifi.it/VISION/VISION_files.txt)
lists this distinct original alongside the existing0001. [Dataset metadata](https://lesc.dinfo.unifi.it/VISION/statistics/VISION_stats/exifStatsAll/D06_Apple_iPhone6/D06_V_summaryOrigin.csv)
reports iPhone6/iOS8.4, AVC(avc1),1920x1080, mono mp4a44100Hz, nominal71seconds,
rotation0 (existing original has rotation90). These are publisher metadata, not our
codec/container/color verification. SHA256, exact PTS, AAC profile/color and actual
content distinctness require the approved download and independent inspection.

HEAD2026-10-13 returned200, Content-Length **152552809bytes**,
ETag `"59ca1d89-917c569"`, Last-Modified Tue26Sep2017 09:27:37GMT,
Content-Type video/quicktime, Accept-Ranges bytes. No media-body bytes were read;
only metadata text and HEAD responses were fetched. ETag is not a content hash.

[License/errata](https://lesc.dinfo.unifi.it/VISION/README.txt): CC BY-SA4.0,
CSP Lab., Department of Information Engineering, University of Florence(2017).
Neither D06 candidate is named in the dataset's native-content errata. Preserve
attribution/license and original bytes locally; no publication/upload is proposed.

Capacity decision surfaced BEFORE download: existing146163851 + candidate152552809
= **298716660bytes**, exceeding the current external/scratch portable256MiB budget
before metadata, though below live-original512MiB. Other HEAD-checked same-device
indoor/still/flat candidates were also too large in aggregate. Do not increase caps
or replace either original with a trimmed/reencoded proxy to hide this condition.
A smaller independently licensed source, or an explicit reviewed Storage capacity
change, is needed for the combined portable gate. Rotation0 versus90 also requires
an explicit output fit/orientation policy; do not silently stretch either source.

The old4-second edit uses two intervals of ONE146MB original and one source hash.
It proves fractional mapping/reorder/retention for that original, not distinct
source-byte/stream dispatch, multiple-original closure or cross-source reader
lifecycle. Copying that file under another ID is not two-independent-original proof.

## Review coverage correction — tests only

At original planner pin d714b832, the6new tests did NOT exercise a trim command, an
actual enabled visual-track gap, or irregular mid-clip chunk boundaries; earlier
planned-coverage prose must not be read as proof of those scenarios at that pin.

Test successor `897f26d966563ed3a07f1018b1c84ca299cd4bf7` adds those three cases:
independent fractional audio trim preserves source phase and unrelated data;
visual trim creates [1,2) gap on an enabled track with exact half-open endpoints;
irregular boundaries46000/46017/47003/48004/48006/49211/50000 preserve every one of
4000output-point identities and exact source times across a fractional split.
This is request-planning equivalence, not decoded PCM/rendered-picture acceptance.

PASS at897f26d9: root typecheck, changed-test ESLint,21tests (9planner+12rational-v1),
git diff --check. Logs `/tmp/video-m2-coverage-{type,lint,unit}.log`. Build and browser
NOT RUN for this test-only successor; prior root build remains at d714b832 and is
not relabeled. Runtime planner/native/profile/capacity code is unchanged. User
approval for gain/fade/mix/audio-only/new-save-profile/contain-fit/512MiB portable
and second media download remains pending; none is implemented or downloaded.
