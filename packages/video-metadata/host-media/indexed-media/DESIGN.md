# Longer-media / synchronized preview proposal

Base #168 evidence remains fixed at `5b260e6013e9b678793c5625ab94a32aea729fc7`.
Work is isolated on `codex/issue-75-indexed-preview`; this is not an acceptance claim.

Archive implementation is delegated to the separate private storage workstream.
This lane owns media reading, playback, codec and the existing Host integration.
No shared API, root dependency or permanent format change is proposed here.

## Reader / audio choice

Read bounded ISO BMFF metadata by Blob/File ranges, preserving raw sample index,
PTS and edit intervals. Use the already pinned Mediabunny BlobSource for packet
ranges with a bounded cache. Do not call arrayBuffer on an entire original.
Video seeks begin at an independently verified key packet and decode a bounded
GOP window; out-of-profile GOP lengths refuse rather than seeking from file zero.

For audio, arbitrary AAC packet restart with an assumed fixed preroll is risky:
matching timestamps does not establish matching decoder state. The proposed first
path instead makes one continuous, bounded decode pass into an owned OPFS PCM
scratch file. Timestamped callbacks prove exact original sample coverage; writes
are streamed with backpressure. All subsequent PCM/filter windows read only their
indexed byte range. This removes repeated packet-zero preroll and whole-PCM RAM
storage without pretending to know an arbitrary AAC random-access distance.
The scratch file is disposable derived data, never canonical history and never a
replacement for the original. Bundle-only reopen regenerates it from included
originals. First use therefore may require a decode pass; startup performance is
not measured or accepted by this work.

Playback uses the AudioContext clock as master. Small scheduled PCM chunks and
video frames share one rational sequence origin. Seek/stop/cancel/revoke replace
one owned playback generation and stop scheduled sources; lifecycle drain awaits
pending writes/decoder disposal and scratch cleanup. Do not use wall-clock elapsed
time or an independent HTML video clock to infer A/V synchronization.

## Storage adapter coordination

Retain original `Blob`/`File` identity in MediaStore; permit archive readback to
supply range-backed Files. Existing SaveCoordinator capture, retained closure,
unknown reconciliation and staged publication stay canonical. Request from the
archive adapter review: bounded streaming SHA-256, staged file readback as Blob,
abort/commit/reconcile and source ownership/disposal. Current digest uses whole
arrayBuffer and must not silently remain the large-file path.

Installed transitive `@noble/hashes` 1.8.0 is a possible incremental SHA-256
candidate, but is **not adopted**: a direct/external dependency decision requires
technical review. No new hash implementation will be improvised. Large-original
integration stays gated on an approved hash adapter; longer small originals can
exercise the media path independently now.

## First validation target

Known non-HDR 48 kHz stereo / 25 fps input longer than 44 seconds, edits and seeks
past the old 2,048 AAC-packet boundary, and an actual longer export. Compare indexed
PCM windows and first/last/impulse samples against independent continuous decoding;
validate video packet/frame clocks and AudioContext scheduling. Include cancel,
revoke and delayed writes. Keep #168's failures and exact pin intact.

Real iPhone, Windows, HDR, general mixed codecs, practical file sizes and performance
remain separate gates. No claim of the <=1-second fixture completing Video #75.
