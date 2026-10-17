# Video M0 — provisional contract v0, pending owner review

This is a reversible, unregistered Core prototype for #75/#77, not an accepted
Editor API, codec profile, complete M0 feasibility gate or M1 media foundation.
Basis: main `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`, including merged #52
(head `e9f3ea2b145828cc6357e26c0605eec1dac2d39d`). Open #37
`3da6d2cbc6a4d5e414d7596639471877ee3b6701`, #39
`93693c9631188b6dd9b7ee5c4098174118770183`, draft #41
`2613b7f041f856f94c8ed1cda2ec1d1cec04cd1f` are inspected, not incorporated.
No checkout .agents/skills exists. Repository development/acceptance guides apply.

## Purpose and scope

Native NLE placements and source windows have their own meaning; they are not
Animation layers or canvas nodes. Scope here: one sequence, visual/audio tracks,
media clips, strict unknown-input validation, pure atomic commands, exact source
mapping and an injected bounded reader/probe boundary. No UI, persistent media
store, AV scheduler, codec, export, shared entry, templates or production Host.
Only video-core files are owned. Private playhead/zoom/cache are not content.

## Decisions proposed to the owner (not fixed)

| Area          | Alternatives                                                      | Recommendation and reason                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time          | floating seconds; global integer ticks; rational seconds          | Canonical safe-integer `{value,timescale}` using internal BigInt arithmetic. Preserve negative source PTS and exact 44.1/48kHz samples without grid quantization. Overflow fails; no BigInt in JSON.                                                       |
| Grid/rounding | mandatory 240000 Hz grid; optional UI grid                        | Keep frame rate rational and no mandatory grid in Core. All ranges half-open, no implicit rounding. Decoder/sample/Animation/encoder rounding remains a separate reviewed boundary. Audio edits at fractional source samples fail.                         |
| Source        | nominal frame index; original PTS and sample index                | Video retains raw integer PTS/timebase/origin, mapped to rational time; audio stores integer sample windows/rate and presentation origin. VFR uses PTS, never nominal fps.                                                                                 |
| Edits         | implicit linked/ripple behavior; explicit cohort                  | Group move/split/delete, explicit independent trim, link/unlink without resync. No overlap accepted in this subset. Effects/transitions/keyframes rejected, not discarded.                                                                                 |
| Ripple        | implement full crossing split immediately; reject crossings in v0 | Explicit track cohort and range; reject boundary-crossing clips and linked outsiders. Delete fully contained clips and shift following clips atomically; insert an empty gap. Full crossing split/trim is a follow-up contract, not silently approximated. |
| Media         | stored URLs/blobs; immutable refs + Host lease                    | Immutable ID/SHA-256/byteLength; injected exact-range reader, byte/read budget, abort, release in finally. Host owns hashing, authorization, durability, retention and URL policy.                                                                         |
| Minimum codec | MP4/H.264+AAC; WebM/VP8+Opus; WASM/native backend                 | Propose a local browser WebCodecs WebM/VP8+Opus SDR 8-bit 4:2:0, opaque output, 48kHz stereo spike first; compare MP4/H.264+AAC. No backend/dependency selected or installed here.                                                                         |
| Animation     | exact native ref; pre-rendered media only                         | Isolated proposal type artifact/version/hash/composition, no model acceptance or evaluator connection before reviewed #74 Player and closure contract.                                                                                                     |

Video commands use the existing EditorCommand structural contract and local
EditorSession tests; no second history/sync engine. Commands validate before and
after, read the entire native content (`['*']`) conservatively and return one new
snapshot. Host must authorize submission and reject stale proposals. These pure
functions are not a security authority. No local fallback for shared edits.

## Prototype schema and bounds

Schema tag `video-core-prototype-v0` is intentionally not production schema 1.
One sequence has immutable source descriptors, tracks and clips with stable IDs.
IDs are unique globally; stream IDs unique within source. Empty sequence valid.
Sequence duration grows after edits, never shrinks automatically; explicit shrink
rejects clipping. Safe arithmetic overflow rejects the whole command. Video source
window equals duration times positive rate; audio rate remains 1. Sample trim/split
requires an exact integer sample. Links preserve independent J/L ranges; split
requires an interior point in every member. Caller supplies all new IDs.

Prototype validation budgets: 32 tracks, 1000 clips, 100 sources, 32 streams/source,
24-hour sequence, fps at most 240. These are rejection guards, not performance
claims or accepted product limits. Reader defaults are supplied explicitly by
Host; total bytes/read count/per-read bytes must be positive safe integers.
Unknown fields/capabilities are rejected. No migration or retained-version import
is claimed; a future production schema requires an explicit migration proposal.

## Media/codec feasibility and test plan

[WebCodecs specification](https://www.w3.org/TR/webcodecs/) does not mandate any
codec. Its [official MP4 sample](https://w3c.github.io/webcodecs/samples/video-decode-display/)
uses a separate demuxer. API presence/config support alone is insufficient.
No external media upload, remote encode or automatic WASM download is permitted.
Dependency/license/size/security review and owner approval precede demux/mux choice.

After approval: local synthetic flash/beep, CFR 24000/1001 and 30000/1001, VFR with
negative/nonzero PTS, video-only/audio-only, 44.1/48kHz, truncated metadata and
unsupported HDR fixtures. Probe/decode/mix/encode/mux/redecode must separately pass
with frame count, PTS, priming/padding and sample endpoints recorded; no timing
benchmark. SDR primaries/transfer/matrix/range, alpha composition, channel conversion,
resampling and export end padding remain pending decisions. Current fake probe
fixtures prove boundary behavior only, not codec compatibility or source hash.

## Shared changes requested later, not applied

- #76 owns Host kind/factory/validator/mount/capability integration after API approval.
- Activate `package.proposed.json` as package.json and add a root package-lock workspace entry/link; root manifest wildcard
  already includes packages/\*. Coordinate lockfile generation, do not merge lanes.
- README/status/domain tables and any build/alias registration are integration-owner
  changes. Package-local README/status records this prototype now.
- #74 must review exact ref/closure and time conversion before Animation adoption.
- Export address/sink/lease and collaboration codec/authority need later ADRs.

## Gates

Focused tests cover V02 rational/PTS/sample behavior and V03 atomicity subset,
N02/N04/N05 and N12 boundary subset. Local lint/type/unit/build and existing targeted
desktop/mobile embedding regressions are recorded against exact commits.
V01 and V04–V11, full V03 transitions/keyframes/shared, codec decode/mux, M0 approval,
M1 viewer/AV/storage, M2–M4 remain NOT RUN or unimplemented. No Epic completion.
Actions remain manual-only; ci/file-size/office are disabled_manually (read API).
All seven checked workflow files have workflow_dispatch only. Repository Actions
permissions API returned 403; no settings changed. Recheck before push.
Performance measurement/tuning, merge, main push, publish, release and license
changes remain prohibited. Draft PR is review material, not approval.
