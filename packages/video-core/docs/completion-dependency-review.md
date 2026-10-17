# Completion proposal: dependency and 1080p/audio follow-up

**最新確定要件：iPhone素材を対象、素材込みproject保存。**
[更新アーキテクチャ](iphone-media-project-architecture.md)を優先。再選択前提を完成仕様にしない。
以下の回答待ち・限定profile記述は先行検討の履歴であり、製品承認ではない。

Read-only review after #153 `4b92ddf94d274c3c9218285885139abc5b118ebf`.
Product runtime remains `082c698740cf30f78ec4f9a293e663633ba86f0a`.
**No installation, execution of candidate code, contract adoption or product implementation.**
Registry tarballs were downloaded into memory, integrity-checked and inspected as data;
selected manifests/licenses/source observations are retained under `/tmp/video-dependency-audit`.
They were not unpacked into node_modules or imported. Root manifests/locks are unchanged.

## Approval boundaries and pending user requirements

The parent is asking the user about audio-enabled 1080p MP4 import/export, initial
Windows Chrome/Edge support, whether iPhone MOV/HEVC/VFR must be included from the
start, and original-file reselection versus media-inclusive persistence. No answer
is assumed. The earlier 720p/Linux/48k-only profile is an **isolated evaluation
candidate**, not an approved definition of practical completion.

There are distinct decisions:

1. Direction and requirements: agree the user-visible workflow, formats, devices,
   image/audio quality, persistence and declared limitations.
2. Isolated evaluation: explicitly authorize specified dependency versions and
   bounded experiments. A successful experiment does not adopt a product API.
3. Product contract adoption: separately review concrete domain schema/migration,
   rational audio/rendering semantics, atomic commands, Host grants/resources,
   Save/export staging boundaries and dependency patches before integration.
4. Acceptance and release: pass applicable exact-pin functional gates. Main merge,
   distribution, release and performance resumption still need their own approval.

The word “approved” in the first proposal must always specify which of these is
approved. Direction approval alone does not authorize schema/API implementation.
This follow-up does not request a new decision from the user while the parent's
three questions are pending.

## Fixed candidates: downloaded bytes and functionality

All four tarballs matched registry SHA-512 integrity. SHA-256 identifies the actual
bytes inspected here, not an endorsement of authenticity, safety or acceptance.

| Candidate                      | Actual tarball SHA-256                                             | Inspected functional boundary                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| mp4box 2.4.1                   | `c24dd2e4a793afc080797bf3c69529f09add9880177b78289ef2a76603ed7388` | Public root `mp4box` for sample/probe/demux; `simple` is not the proposed sample path. No decoder/encoder or admission policy. Node >=20.8.1.        |
| @noble/hashes 2.4.0            | `e1946149b780017b2564fcc092cb01c04e1d7f20627d0296c17da8868f4436dc` | Public `@noble/hashes/sha2.js` incremental SHA-256. No trust/permission grant. Node >=20.19.0.                                                       |
| mediabunny 1.61.3              | `507e6f75def0ba3748b3b52e4a8ed2937cf311897f4984b90510b56b279bc3d1` | Unpatched public MP4 mux/read path; does not establish codec availability, exact raw input time or native Save semantics.                            |
| @mediabunny/aac-encoder 1.61.3 | `d2cec48cb1ed923f1c1c48b3bdabdd33e9f94e197405873f9f119abe8a913d5f` | Public AAC registration, browser worker and embedded FFmpeg WASM. Encoder only; not an AAC decoder, audio renderer, resampler, muxer or media store. |

Registry manifests: [mp4box](https://registry.npmjs.org/mp4box/2.4.1),
[noble](https://registry.npmjs.org/@noble/hashes/2.4.0),
[mediabunny](https://registry.npmjs.org/mediabunny/1.61.3),
[AAC](https://registry.npmjs.org/@mediabunny/aac-encoder/1.61.3).

Mediabunny declares `@types/dom-webcodecs:0.1.13` and
`@types/dom-mediacapture-transform:^0.1.11` dependencies; the latter needs an exact
lock resolution and its own license inventory before installation approval is
turned into a patch. AAC declares peer `mediabunny:^1.0.0`; use the explicit chosen
1.61.3, not unconstrained latest. Other three manifests have no further runtime
dependency tree apart from these declared type packages. Build-time bundlers and
embedded WASM are not disproved by an empty npm dependencies object.

## License and redistribution review

Every tarball includes `package/LICENSE`. The filenames do not establish that all
embedded third-party obligations are fully satisfied.

| Candidate     | Confirmed license / required distribution preparation                                                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mp4box        | BSD-3-Clause text: retain copyright, conditions and disclaimer in source; reproduce them in binary documentation/materials; no endorsement using contributor names. Keep notices with bundled output.                                                                               |
| noble-hashes  | MIT text: retain copyright and permission notice in copies/substantial portions. No root-license replacement is needed merely to retain dependency notices.                                                                                                                         |
| mediabunny    | MPL-2.0 text: retain applicable notices; make covered source and covered modifications available under MPL and inform recipients how to obtain it when distributing executable/minified forms. Identify the exact source version matching the bundle.                               |
| AAC extension | Package wrapper/source declares MPL-2.0. This does **not** by itself establish licensing of the embedded FFmpeg WASM. Audit FFmpeg build/source provenance, LGPL or other enabled-component conditions, notices and replacement/relinking arrangements before product distribution. |

References: [fixed MP4Box license](https://raw.githubusercontent.com/gpac/mp4box.js/v2.4.1/LICENSE),
[fixed noble license](https://raw.githubusercontent.com/paulmillr/noble-hashes/2.4.0/LICENSE),
[fixed Mediabunny license](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/LICENSE),
[Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
[FFmpeg legal/build conditions](https://ffmpeg.org/legal.html),
[LGPL2.1 text, notably sections 4–6](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n7.1.5/COPYING.LGPLv2.1).
The last URL supplies license text, not evidence that AAC's embedded FFmpeg is n7.1.5.
Client-delivered JS/WASM is distribution for this review, not server-only use.
Root license and product distribution eligibility remain unchanged/unapproved.
Codec patent permissions are separate from package copyright-license compliance.

### AAC provenance is not yet closed

The fixed [AAC README](https://raw.githubusercontent.com/Vanilagy/mediabunny/v1.61.3/packages/aac-encoder/README.md)
describes static links to `libavcodec.a` and `libavutil.a`, with the AAC encoder
enabled, Emscripten SIMD and memory growth. It instructs cloning FFmpeg but does not
pin the FFmpeg commit or Emscripten toolchain. Its recipe does not show an
`--enable-gpl` option; that is not proof of how the shipped WASM was built.

The inspected 30-entry AAC tarball has one license-named file (`package/LICENSE`,
MPL), JS containing the WASM, bridge/worker/encoder sources and README. There is no
separate LGPL/COPYING/NOTICE-named file in that inventory. This is a provenance and
notice gap to resolve, not a legal finding against the upstream project.
The exact corresponding FFmpeg sources/configuration, toolchain and any patches,
embedded-license inventory, and practical library replacement/rebuild package
remain **NOT VERIFIED**. They block a claim that the WASM is ready for product
redistribution. No upstream communication, rebuild, patch or license change was made.
The package's encoder.ts, bridge.c and shared.ts match the v1.61.3 tag byte-for-byte.

### AAC functional review: separate from both license and #115

Tarball `src/encoder.ts` accepts both 44100 and 48000. Source inspection is not a
functional PASS. It rounds the initial sample timestamp, zero-fills the partial
last encoder frame, and emits packets from `nextPacketTimestampInSamples` plus
packet duration. `bridge.c` records packet PTS, and `PacketInfo` contains PTS, but
`emitPackets` does not use `p.pts` for its published timestamp. The inspected path
needs explicit evidence for encoder priming and final valid-sample extent through
MP4 mux and independent decoders. Do not compensate by guessed offsets or changing
expected waveform/sample counts. This is a concrete evaluation risk, not a new
reproduced failure or an assertion that every AAC route is blocked.

Before adopting this candidate: test 1/17/1023/1024/1025/nonpacket-multiple frames,
zero/nonzero origin, distinct channel impulses, input and output edit lists, flush,
cancel and worker/CSP failure. Compare actual saved MP4 on independent FFmpeg and
browser decode. Native AAC on each target Windows browser needs the same tests.
An available native route avoids this WASM's provenance gap but not codec timing gates.
The earlier Opus #115 six required short-input failures remain separately BLOCKED.

## Minimal design delta for 1080p and general 44.1/48kHz

These are candidate deltas to review after the user's requirements arrive, not
approved limits or implementation instructions.

| Area              | Minimal change from the earlier isolated profile                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1080p output      | Expose an explicit 1920×1080 or portrait1080×1920 render target, preserve aspect and orientation once, and remove forced720p. Source dimensions and native timing are unchanged. Keep 720p only as an explicit optional output preset if requested.                                                                                            |
| Codec config      | Probe/decode/encode the exact dimensions, frame rate, codec profile/level, channel/rate and bitrate in each target Windows Chrome/Edge version. A 720p25 H.264 query on Linux proves none of these. Bitrate/quality acceptance needs a declared preset and representative 1080p material; do not reuse 4Mbps as an accepted quality guarantee. |
| Frame resources   | 1920×1080 RGBA is8,294,400bytes/frame; four held frames33,177,600bytes before decoder/GPU/copies. Revisit per-job budgets and failure paths, not just a width constant. Performance measurement stays paused.                                                                                                                                  |
| Native audio      | Preserve each source's actual sampleRate and integer valid sampleCount; extend clip edit intervals to rational time only after schema/migration review. 44.1k cannot be relabeled48k or derived from rounded duration.                                                                                                                         |
| Render audio      | Propose an explicit output rate48k, with 44.1k→48k conversion ratio160/147, source rate kept intact. Output44100 can be separately selected if required; reverse conversion needs antialias filtering. Native clip boundary times never snap to either sample grid.                                                                            |
| Resampling        | A deterministic stateful band-limited/polyphase renderer must cover both rate conversion and fractional clip phase. The earlier linear-interpolation experiment is not a quality-approved general resampler. Filter/edge behavior, phase accumulator, delay and drain rules need review; no fifth dependency is introduced while waiting.      |
| Boundary math     | Use global output sample index and rational source mapping, carry state across blocks, and preserve the same signal across adjacent split clips. At29.97fps, 48k has1601.6samples/frame and44.1k has1471.47. Neither permits general integer-only linked cuts.                                                                                 |
| Preview/export    | Use the same accepted audio timing/render interpretation for audible preview and output; do not let device AudioContext rate silently define export. Output sample rate and codec config are explicit.                                                                                                                                         |
| Sample acceptance | 44.1-only,48-only,mixed clips,1frame linked trim/split at29.97/23.976, first/last partial sample, long phase continuity, impulse/channel alignment, antialias sweeps, block-size independence, Undo/Redo/native migration/reconnect. AAC lossy output is compared with predeclared waveform tolerance and exact timing/count requirements.     |
| Host staging      | Keep position-aware staged MP4 writes and success-only delivery. A larger1080p output may exceed the proposed512MiB memory cap; re-evaluate storage strategy after persistence/size requirements, not by silently raising the cap or adding OPFS.                                                                                              |

Windows Chrome and Edge require separate actual OS/browser evidence, including
codec configuration, full saved-file roundtrip, source picker/reconnect, CSP/worker,
finalization/cancel and download behavior. This environment is Linux; Windows
acceptance is **NOT RUN**. Browser brands do not guarantee hardware/OS codecs.

## Pending iPhone material and persistence answers

Do not lock the earlier CFR/H.264-only scope while the user is deciding whether
iPhone MOV/HEVC/VFR is required. If included, the minimum additional work is:
container/track admission for MOV, HEVC actual decode profile checks on the target
Windows browsers, variable sample intervals instead of whole-file CFR admission,
rotation/SAR/color/HDR interpretation, and VFR→declared output cadence semantics.
Do not discard VFR or transcode the original to25fps just to reuse old tests.
HDR/tone mapping and HEVC dependency/licensing are further explicit decisions.
None of the four candidates alone guarantees that scope works on Windows.

If the user chooses media-inclusive persistence, the earlier missing/reselect
proposal is not sufficient. Asset durability/quota/eviction, hash verification,
atomic metadata/asset publication, cancel cleanup, portability, migrations and
revocation need a separate Host design. Do not silently implement OPFS, a ZIP
bundle, a database or another synchronization system. Original files remain local.

## Evidence and status

PASS: four actual tarball SHA-512 integrity checks, contained license/manifest/source
inspection, AAC tag/source equality for three files, dependency/contract review,
document format/diff/file guards. Raw review manifests and selected files are local
under `/tmp/video-dependency-audit`; no binary/code is committed.

NOT RUN: package installation/import/execution/build/type compatibility, all new
codec/render/resampler functionality, Windows browsers, iPhone material, media
persistence, tests/type/lint/build/E2E for this docs-only change, and performance.
No runtime/shared/root-manifest/license changes. User answers, concrete contract
review, AAC provenance and functional gates remain open; no completion claim.
