# Video completion: approval-gated implementation and first codec evaluation

Parent has asked the user to approve the overall direction and is awaiting a reply.
This plan does not infer that reply. No new dependency/toolchain is installed or
executed and no product contract is implemented. User direction approval enables
work within that direction; concrete API/schema/dependency patches still receive
parent technical review. Individual fields do not each require a new user vote;
changes to the agreed policy do.

## Small implementation slices and dependencies

| Slice | Deliverable and completion gate                                                                                                                | Dependencies / owner boundary                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| E0    | Exact source/toolchain and license inventory; frozen representative fixture manifest; declared assertions and failure classifications          | Direction/evaluation approval first. Existing read-only candidate audit is evidence, not adoption.                               |
| E1    | Isolated browser worker HEVC8/10bit decode with raw PTS, planes/color metadata, bounded packet/frame lifetime and cancellation                 | E0. No Core/native/Host API changes; source-derived experiment outside product runtime.                                          |
| E2    | Isolated AAC44.1/48k encode/MP4 mux/re-decode gate with actual sample bounds, priming/tail and cancellation                                    | E0; can be evaluated separately from E1. Native and local-WASM candidates have independent results. No Opus fallback.            |
| C1    | Concrete source-interpretation/audio rational-window schema and explicit migration, source+clip atomic command, pure validation/history tests  | Direction approval and parent review of the diff before adoption. Informed by E1/E2 metadata. Video-owned Core only.             |
| H1    | Host asset lease/staging and project capture/closure/save adapter proposal, portable archive choice, permission/commit-point/quota tests       | Parent #76 owns shared boundary. Coordinate reviewable patches; no competing shared edits or root manifest changes.              |
| I1    | Local file probe/hash and explicit track/alternate-group selection, including Apple stereo fallback; atomic insertion into an existing project | C1 + reviewed Host asset ports + required E1/native gates. Initially isolated domain harness, then reviewed Host integration.    |
| R1    | VFR display-interval mapping, rotation/SAR and explicit SDR conversion profile;44.1/48k rate/phase render and audible preview                  | E1/E2 + C1. HDR/resampler profile gets its own parent technical review and reference fixtures. No implicit25fps conversion.      |
| S1    | Portable project writer/reader, captured retained-version asset closure, incremental write/readback, empty-Host reopen                         | H1 + I1. ZIP64 is a proposal; choose/approve an actual implementation before installing it. Native size limits remain unchanged. |
| X1    | Immutable capture render→MP4 staged export→success-only delivery, independent full file decode                                                 | E2 + R1 + reviewed Host export boundary. Preserve native Save/project Save/export outcome distinctions.                          |
| A1    | Both Windows Chrome/Edge end-to-end material matrix: import/edit/save/empty-Host reopen/edit/export/re-decode and faults                       | I1/R1/S1/X1; exact runtime/package/browser/OS/source/output pins. Linux harnesses are not Windows acceptance.                    |

Implementation uses small draft PRs; experimental codec changes are not folded into
Core contracts by success alone. Independent read-only preparation may overlap,
but no product integration skips its dependency gates. No new subagents are
required by this plan. Tests and review, not a time estimate, determine progression.
Existing touch and legacy33-case work remain separately accounted.

## Fixed first-isolation candidates

Read-only refs verified before any new execution:

| Component         | Fixed identity / intended use                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg source     | tag `n7.1.5`, peeled commit `3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587`, tag object `eefb3654c445a9004712036be4ffb01a68b2c3e1`. First controlled HEVC/AAC library build candidate. This is a comparison pin, not a claim of latest/security-approved product release. |
| Emscripten source | `4.0.10`, commit `b7dc6e5747465580df5984e723b9d1f10d8e804b`. Candidate compiler for the first reproducible build.                                                                                                                                                    |
| emsdk             | `4.0.10`, commit `62a853cd3b3134398ce85cde8bb5cbb2ef0194cb`; release table maps4.0.10 to `8103ffedfb0c42d231c6af6859a5a1a832260b43`. Downloaded toolchain artifact hashes/build identity must still be verified after authorization.                                 |
| MP4 probe/hash    | `mp4box@2.4.1`, `@noble/hashes@2.4.0`; exact tarball hashes in the dependency review. Use public APIs only.                                                                                                                                                          |
| MP4 mux           | Unpatched `mediabunny@1.61.3`; fixed tarball from the audit. Never use the #115 Opus patch as accepted code.                                                                                                                                                         |
| AAC comparison    | `@mediabunny/aac-encoder@1.61.3` fixed inspected tarball; provenance and priming remain unverified. An experimental reference comparison is not permission to redistribute its embedded WASM.                                                                        |

First custom FFmpeg build should contain avcodec/avutil with HEVC/AAC decoders and
AAC encoder, required parser/bitstream support only. Packet input comes from the
fixed demux path; do not pull a network/CLI/general file subsystem into the decoder
bridge. Explicitly disable autodetection/network/devices/GPL/nonfree/version3 and
external codec libraries; inspect the actual resolved configuration/license and
linked object inventory rather than assuming requested flags are sufficient.
No x264/x265/libfdk/native helper/server path is introduced. Toolchain compatibility
and missing internal components may require a reviewed experiment-only build patch.
No silent version bump or enabling broad configure defaults to get a successful build.

Start with one worker, no shared memory/pthreads, bounded WASM memory and explicit
packet/plane/PCM transfer ownership. Do not copy the whole movie into MEMFS. The
application packet bridge must preserve DTS/PTS/timebase/config changes and decoder
side metadata; returning only browser seconds or RGBA8 is insufficient for HEVC10/HDR.
The bridge is private to the experiment, not a new Extension API.

The installed `/usr/bin/ffmpeg` identifies7.1.5 Debian and `--enable-gpl` plus many
external libraries. It may serve as an existing local reference tool; it is **not**
the selected product build, corresponding WASM, or evidence of an LGPL-only build.
Comparison with that binary alone is not independent implementation evidence when
the decoder algorithm is the same FFmpeg source. Include native browser decode on
supported configurations and Apple/color references for distinct oracles.

## Predeclared evaluation gates

E0 records source commits, tarball/toolchain hashes, configure/link inventory,
licenses/notices/corresponding source/relink recipe, fixture origins and original
SHA-256/size. Dynamic references, unexplained binary provenance or unexpected
GPL/nonfree linkage stop product consideration. Performance is not measured.

E1 inputs: synthetic functional fixtures plus authorized actual iPhone originals
with MOV/HEVC Main/Main10, B-frames, nonzero origin/edit, VFR, portrait rotation,
HLG/Dolby8.4 and1080p/4K30/60 where available. Synthetic cases do not certify iPhone.
Compare decoded frame identity/order, raw presentation intervals, plane bit depth,
color tags, first/last visibility and seek boundaries. Assert packet and frame
ownership, no stale delivery after cancel/revoke, no application-held leaked frames,
malformed/truncated packet rejection and bounded input/queue counts. A case that
cannot run is NOT RUN and blocks that declared compatibility row.

E2 inputs:44.1/48k mono/stereo,1/17/1023/1024/1025/44101/48123valid samples,
nonzero origin and separate-channel impulses. Supply continuous PCM from an
independent expected-render fixture, record real encoder delay/padding and packet
PTS, write actual MP4, reopen and decode with both native browser and FFmpeg.
Assert valid sample count/start/end, channel association, A/V alignment, MP4 edit
interpretation and fixed waveform tolerance. Never fit expected offset to observed
output or hide padding by changing duration. Compare native AAC, inspected AAC
package and controlled-build AAC separately; one PASS never certifies another.

MP4 stage writer gets positioned overwrite/backpressure/close tests: finalization,
cancel-close, write/close failure, revoke during finalize, stale completion and
partial-byte faults must never publish an incomplete result. Decoder/encoder flush
and final sink closure are distinct assertions. Hash saved bytes before/after reads.
If the candidate lacks mandatory timing metadata, retain the failing proof and
stop; proposing a patch is a later reviewed experiment, not immediate adoption.

The first codec experiment intentionally does not certify tone mapping, Dolby
metadata rendering, resampler quality, project persistence or Windows compatibility.
Those are subsequent R1/S1/A1 gates, not waived requirements. HLG→SDR and spatial
fallback choices remain versioned explicit transformations with original bytes kept.

## Fixture/environment handoff required after approval

Parent should supply or arrange authorized original files and Windows test access,
not request public upload. Record iPhone model/iOS, capture options (AutoFPS/HDR/
Spatial/rotation), transfer route and hashes. Include enabled/stereo/spatial
alternate groups; confirm selected fallback rather than mixing all tracks.
A clean empty-Host profile with no source cache/old permissions must receive only
the completed bundle and successfully reopen/re-edit/re-export.

The current environment lacks `emcc`, Windows and actual iPhone originals. Existing
Chromium151 Linux and FFmpeg are available. These are explicit NOT RUN dependencies,
not reasons to infer Windows/iPhone acceptance. Once direction/evaluation approval
arrives, start E0 then E1/E2; while waiting, no install, configure/build, new codec
execution or product schema/API implementation is authorized by this plan.

PASS for this change: read-only fixed refs/source review, document format/diff/file
guards. NOT RUN: all proposed builds/codec tests, product tests and performance.
No shared files, manifest/lock, license or executable source is changed.

Sources: [FFmpeg fixed configure](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/configure),
[fixed HEVC decoder](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/libavcodec/hevc/hevcdec.c),
[Emscripten4.0.10](https://github.com/emscripten-core/emscripten/tree/4.0.10),
[emsdk release mapping](https://raw.githubusercontent.com/emscripten-core/emsdk/4.0.10/emscripten-releases-tags.json).
