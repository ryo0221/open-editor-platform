# Private v1 Host port and real-tail playback checkpoint

Code `5007face5e00863231291b0de66cb80475561d76`, based on #192 plus #193.

`host-v1.ts` prepares a private Host around the existing scoped schema-edit
controller, EditorSession, Undo/Redo and SaveCoordinator. A PersistenceFactoryV1
must supply real v1 storage, validated content, original-inclusive portable
output and asynchronous close. Its independent live original/interpretation maps
last for the draft/Undo lifetime, separately from the saved retained tree. The
artifact identity uses Storage.key. Import hashes the original incrementally;
media work drains before Host ownership is released. Replacement verification
precedes old-Host disposal; failed replacement preserves the old draft. Editing,
file activation and Save are disabled during active jobs. Stop media applies only
to preview/play/export; it does not imply that durable Save was cancelled.

This is a reviewable port, not a runnable saved-project acceptance Host yet.
No fake persistence or alternate history was added. The Storage owner still
needs to supply native-v1/interpretation-v1 portable version dispatch and the
external File opener. The current approved #188 adapter is v0-only. Owner files
portable/project.ts, browser-verifier/adapter.ts and integration/storage.ts have
not been changed by this layer. Wiring, standalone Host bundle/notice provenance,
desktop/mobile UI acceptance and the actual 146 MB empty-Host portable roundtrip
remain NOT RUN / blocked on that port. No permanent Host or root registration.

The independent actual-file playback harness uses the same v1 product codec as
export. It starts at frame 1750, draws the initial original picture before the
audio anchor starts, then plays to exact T=42251/600. The last 880 samples match
the export input chunk hash from #192. This checks real AudioContext completion,
clock-based picture selection, exact last PCM membership and resource closure;
it is not a claim that every playback frame was displayed or that physical A/V
latency was measured. Whole-original arrayBuffer remains prohibited.

Initial code `611fbd9f942ca0f18290a6fcf373b76f4d738160`: type/build/file policy,
90 scoped tests and actual playback PASS; lint FAIL because the verification
harness used an unqualified structuredClone browser global. Final code qualifies
that global; no product behavior changed. Initial logs and results remain under
/tmp/video-v1-host-*-pinned.log and /tmp/video-v1-host-play-pinned/.

Final checks and artifacts are recorded below after completion. Raw media and
screenshots remain outside Git. CI dispatch, performance acceptance, main merge,
release, deployment, publication and license changes remain held.

At exact clean final code: PASS root typecheck, lint, build, file policy and
90 focused Core/v1 tests. Actual original tail playback PASS: initial frame 1750,
11 PCM chunks, last [3379200,3380080), hash
`2afd21805e407932f20e4d37c8af7f9f811eec00bfe04708da7290f1c3116610`,
AudioContext closed, browser errors 0. Final logs
`/tmp/video-v1-host-{type,lint,build,files,unit,play}-final.log`, results and
screenshot `/tmp/video-v1-host-play-final/`. The portrait last picture was inspected.
Full source encode/independent FFmpeg oracle remains pinned separately in #192;
this layer did not rerun or replace that export claim.
