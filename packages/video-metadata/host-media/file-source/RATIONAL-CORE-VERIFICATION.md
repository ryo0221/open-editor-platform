# Rational Core v1 checkpoint

Implementation: `b410d534165c2f022bba574fe7bf1d927868a816`, based on ADR
`1de59db9` / #185 and #183. User approved rational presentation endpoints with
v0 save compatibility. This checkpoint implements explicit Core v1 and private
pure interpretation/render-boundary adapters; it does not switch the existing Host.

At this exact clean code commit, Node 24.19 / npm 11.9:

- PASS root typecheck, lint, build and repository file-size policy.
- PASS 280 Video Core/metadata tests, including existing browser suites at 1280
  and 390 CSS pixels and seven new v1 cases. `npx vitest run packages/video-core
packages/video-metadata`. Tests cover fractional origins/endpoints, exact
  split/trim and platform Undo/Redo, linked ripple, invalid/unknown fields, mono
  44.1→48 kHz chunk/split invariance and rejection of missing endpoint coverage.
- PASS read-only original feasibility browser harness: unchanged 146163851-byte
  original SHA `69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`,
  bounded metadata, real first AVC frame/orientation compared with independent
  FFmpeg and first eight AAC packets (8192 mono samples). Browser errors zero.
  This is #183 regression evidence, not a new v1 import/play/export claim.
- PASS v0 compatibility by unchanged v0 implementation files and existing v0
  regression tests. Existing entrypoint names still reject v1; v1 uses explicit
  suffixed APIs. No automatic migration, retained-version conversion or hash rewrite.

Logs: `/tmp/video-v1-{type,lint,unit,build,files,browser}-pinned.log`;
`/tmp/video-v1-original-pinned/results.json` and screenshot. Local raw evidence
is outside Git. Earlier focused development run: 85 tests PASS; final run adds
linked ripple coverage and includes all metadata suites. No failed test run.

## Remaining gates

NOT RUN: actual v1 Host import/edit/play/save UI; shared portable schema validation
and original-inclusive empty-Host reopen; independent decode of full-original
output. The renderer tests use generated PCM, not full iPhone AAC decode. Exact
output planning yields 3380080 samples at 48 kHz and 1761 video intervals at 25fps,
last duration 11/600 seconds. Native encoder timestamps/muxer duration/edits must
still prove that interval independently; no whole-frame truncation/padding.

Core commands/validation are version-isolated deliberately: v0 semantics remain
frozen. There is one existing EditorSession/Undo implementation, no second history.
The new import adapter is pure and does not claim stored metadata was probed;
Host/portable verification must bind it to original bytes and exact grid coverage.
Storage owner notified on #184; no #181/#184 or #182 code pulled into this branch.
Metadata hierarchy correction remains a separate successor to #182.

No common Time, MediaReader, root manifest, App, permanent Host registration or
license change. CI/file-size/Office disabled, all workflow triggers manual-only;
code Actions runs zero. No performance measurement, merge, release or deployment.
