# Silent two-recording Video demo: domain handoff

Authorized limited implementation. Base accepted #125 HEAD
`75001ab853fb2bc41047e52c3fcb69ab5f886e2f` (implementation `b18369f2d5f28bab2da4e5e1a8030a231fc44ca5`).
No other lane branch adopted. No native v0, schema-edit token, #122 history hook,
Resources contract, shared manifest/lock/Host or production dependency changes.

## #76 wiring required

Expose `@editor-platform/video-metadata/demo` with `./demo: ./src/demo.ts` under
shared package ownership. The source uses existing public artifact-core/video-core
and extension-contract types only. Do not package `test-host/` as a production adapter.

Host supplies a real scoped `LocalReadSnapshot<VideoContent>` and its AbortSignal.
This is a Host-side experiment helper, not a Resource granted to an extension.
Host must authorize reads/submissions and own the renderer/bytes/play clock. No
new session, history, save adapter, storage or codec backend is provided here.

- `assertVideoDemoContent(content)`: valid v0; one visual track, <=2 sources,
  only unlinked unit-rate video clips. Core forbids accidental same-track overlap.
  It does NOT probe media or establish that bytes are silent/decodable.
- `planVideoDemo(content, at)`: Core evaluateSequence mapping, half-open clips,
  returns gap or a detached frame request with sourceId/streamId, exact sourceTime,
  sourceStart/sourceEnd (half-open), immutable asset identity and clipId. It does not infer
  PTS from nominal fps. Disabled track/outside sequence/empty space yields gap.
- `prepareVideoDemoOrder(snapshot, allClipIds)`: exact temporal permutation of ALL
  clips, including split descendants; retains leading/inter-slot gaps, source
  windows, sources and sequence duration. Locked edits/invalid permutations reject.
  Existing move commands park clips beyond the old end on a private intermediate
  copy, move them into new slots, then resize to old duration. Core bounds still
  apply (parking exceeding v0's duration limit refuses). One prepared command,
  one submission/history entry; intermediate states are never committed. Identical
  temporal order returns null, retaining Redo. Submit through existing controlled
  facade, with normal stale/authority/Inputs checks. No direct session access in UI.
- `createVideoDemoPreview(port, signal)` returns `update(snapshot)`, `render(at)`,
  `dispose()`. Update pauses playback, cancels pending work, clears old pixels, and
  takes a detached snapshot. Call after accepted edits/Undo/Redo, not every input
  notification. A changed scope retires the bridge; create a new one on reopen.
  Host should pause on editing intent as well; preview state never changes native
  content. No-op commands do not require a content update. Invalid updates clear
  old media and reject; missing/failed decodes must remain visible failures.

## Host preview port

`pause(): void` stops Host's private playback clock synchronously.
`clear(): void` hides previous pixels immediately (gap/loading/error, no frame hold).
`prepare(frameRequest, AbortSignal): Promise<{present(): void; release(): void}>`
decodes a DETACHED frame; no visible DOM mutation during preparation. `present`
synchronously copies/displays the frame; `release` is idempotent and called immediately
after present or stale discard. Thus present must not retain a released ImageBitmap.
Host is responsible for validating returned source/frame identity and clipping frame
selection to the supported source window. Unsupported boundary frames must fail,
not be relabeled exact. Reject missing assets, unsupported codec and failed seek.

Each new render/update/gap/dispose invalidates older work; even an abort-ignoring
late result is released without display. Failures from current work propagate; old
cancelled failures are suppressed. Revoke pauses, clears, and retires permanently.
Host must honor cancellation and bound decoding; this helper cannot free a hidden
resource held indefinitely by an uncooperative adapter.

Host owns File/Blob, actual SHA-256/length checks, verified probe metadata, URL leases,
source-to-HTML media timeline mapping, decoder cleanup and any playback scheduler.
Use one serialized render loop (await render before requesting another, coalesce
new desired times); repeatedly starting seeks every rAF can starve slow prepares.
Private silent playback time comes from a monotonic anchor, not accumulated frame
rounding. Pause/rebase on edit, seek, buffering and visibility/scope changes. Seamless
continuous playback and frame-exact output are not certified by domain tests.

## Recording and persistence boundary

Host creates initial native content from the TWO actual recordings, not synthetic
hashes or duration-derived invented PTS. Source timeline correspondence must be
verified for those bytes; the fixture tests below use zero-origin WebM only.
Host checks there are no audio streams and retains source provenance/rights and GIS
attribution. These remain ordinary raster media sources, not native Animation clips.

Native JSON saves only the recipe/refs. Same-Host reopen may rebind retained bytes;
page/process restart does not restore media. No durable bytes/relink/proxy claim.
No audio, Opus fix, WebCodecs/mediabunny adoption, encoder, muxer or Video export.
Any final demo recording is an external capture of REAL Video operations, labeled as
such. Fixture generation and external probe tools are test/production-of-demo steps,
not features implemented by Editor Platform.

## Acceptance scope

Domain tests cover source mapping, gap/boundaries, order/trim/split, single history,
no-op Redo, invalid/locked/subset rejection, pending seek supersession, current decode
failure, change pause, scope replacement and abort/dispose. Browser tests generate
clearly synthetic silent two-color VP8 clips in /tmp with local FFmpeg, independently
read PTS via ffprobe, verify exact hash/bytes, and decode/seek in actual Chromium via
an explicitly TEST-ONLY Host port. Tests assert decoded colors/mediaTime, trimmed and
split source mapping, ordering/Undo/Redo/no-op, gap transparency, released object URLs,
late actual decoded frame rejection and scope retirement at 1280/390px. Functional
timeouts are test settlement limits, not performance benchmarks.

Animation/GIS actual recordings: NOT RUN (not supplied yet).
Production Host preview adapter / UI / play scheduler / installed package gate: NOT RUN
here; #76 owns them. Actual installed authority/history/save gate remains separate.
Audio/export/bytes persistence, VFR/nonzero-origin/backends/other browsers, full legacy
E2E, performance and full #75 Epic acceptance are not established by these fixtures.

## Exact checkpoint

Tested code `65522f779919eae2adbff86855c0ef3b1beb6ebe`.
PASS123 focused tests /7 files: existing108 +13 domain/coordination +2 Chromium
fixture-decode cases. PASS root typecheck, lint, ordinary Vite builds, file policy
and diff check. Initial lint found two unused ternary expressions in the TEST Host;
fixed before this pin. No other gate failure. Following checkpoint commit is docs only.
Node24.19.0/npm11.9.0/Chromium151.0.7922.173/FFmpeg7.1.5.
Logs `/tmp/video-demo-final-*.log`; generated fixture files remain outside Git.
All NOT RUN limits above remain. Main read-only rechecked at
`5a32d355ac107258a604e5a4d7a45d03f3b9efdb`; seven workflows manual-only, CI/file-size/
Office disabled. No performance measurement, merge, dispatch or publication.

## Review correction: reentrant Host callbacks

Latest tested code `67de2c145050a8311d28c0f8593e6e60224f72b9`; following commit
is documentation only. Each operation claims a token and detaches the previous
pending controller BEFORE abort callbacks execute. Ownership/scope is rechecked
after Host callbacks; older work cannot inherit a newer token or clear newer output.
Update removes the old snapshot before pause/clear; render during that transition
is explicitly refused with NoVideoSnapshot. An update superseded by callbacks throws
VideoPreviewSuperseded (or ScopeRevoked). A render retired by callback-triggered
scope abort resolves superseded, with no deleted-snapshot TypeError. Dispose is
terminal before its callbacks; cleanup does not revive a snapshot or pending handle.

Before at `95f21a8e`: all6 new regression cases FAIL, including an actually resolved
stale frame in update/pause (not merely a timeout). After at the exact tested pin:
PASS129 focused tests/7 files, root typecheck/lint/build/file and diff checks.
Regressions: clear→render; update pause→render with changed source window;
abort listener→render; clear→scope abort; update pause→scope abort; decode-error
pause→render. Both retired/presented detached frames release exactly once.
Evidence `/tmp/video-reentry-before-six.log`, `/tmp/video-reentry-final-tests.log`,
`/tmp/video-reentry-{types,lint,build,files}.log`. No public/shared/native contract,
Host implementation, dependency or scope changes. Actual H.264 installed integration
remains #76's separate gate; fixture PASS is not actual-recording acceptance.
