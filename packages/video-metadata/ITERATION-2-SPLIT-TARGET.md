# Practical UI iteration 2: split target versus Player position

Base accepted #134 `db6e7056b662c0b3744cebacafa7a359e720c90f`.
Tested domain copy/harness `35d8a041d6c55605ead3760e4de9595b49b93560`.
This is a sibling of #136, NOT stacked on or adopting its unreviewed focus fix.

## Finding and intended semantics

Shared owner's operation QA iteration1 (retained in #137 at
45f65726524bc2ae78e78e0d96945405745fb875, docs/extension-76/operation-qa-iteration-1.md)
observed a split target100f staying fixed while the Player was sought to50f and
played/paused around51f. Current code agrees: domain frame input/ruler updates its
private split target and requests the existing optional preview seek; Player render/
clock does not feed a new target into the Surface. That is intentional current scope,
but the text "S splits at playhead" suggested the Player's current frame.

Minimal correction: marker reads "Split Nf"; help explicitly distinguishes fixed
split target from Player playback/seeking, and explains ruler/field targeting with
optional preview seek. Matching input accessibility description and split-button
tooltip explain the same behavior. Existing accessible field/button names retained.
No command/time/history/selection/clock/Host-seek/callback logic changed. No new
synchronization API, Resources grant, media backend, save or bytes-retention policy.

## Actual installed re-operation

Rebuilt/verified offline kit and installed both consumers from this exact code pin.
PASS4: both Hosts x1280/390, field50f -> marker/description -> button splits exactly
at2s in1 history -> Undo -> field37f -> S splits exactly at37/25s in1 history -> Undo.
Setting target alone leaves revision unchanged. Real native clip windows/IDs checked,
not just copy assertions. Screenshots inspected at desktop and narrow widths, no
browser errors/document horizontal overflow. Existing installed Video edit/Save4 PASS.
Domain163 tests/8 files, root typecheck/lint/build/file/diff checks PASS.

Kit /tmp/video-iteration2-kit, source35d8a041d6c55605ead3760e4de9595b49b93560;
provenance e6d9cf1ec0861070aed0e0338ae761affe4d7d4f28ac69182ab8d65d557d747e.
Consumers /tmp/video-iteration2-consumers. Harness:
packages/video-metadata/test-host/installed-split-target-check.mjs CONSUMERS.
Logs /tmp/video-iteration2-{pack,verify,prepare,installed,save-regression,tests,types,
lint,build,files}.log; screenshots /tmp/video-split-target-{reference,independent}-{1280,390}.png.
No new video recording; artifacts remain outside Git. Following checkpoint commit
is documentation only. Source and evidence are separate from iteration1/#136.

## #76 handoff and remaining gate

Adopt this small display-only domain diff independently of #136. No Host code change
is necessary for the copy; rebuild package and verify the actual-media route with
split target100f versus Player50/51f. Actual H264 source bytes were absent here, so
that real-Player re-operation remains NOT RUN by this lane; shared-owner prior QA
is evidence of the original finding, not acceptance of these new rendered labels.
Do not silently make split follow a different clock. A future synchronization change
requires an explicit Host/domain design, outside this patch.

Known-file media limits and actual-media canSave=false remain. General import/probe,
source bytes/reconnect, audio/export, full practical/Epic completion, performance,
full legacy E2E and physical touch/native OS IME are not claimed. Main/CI/performance/
publication holds unchanged. No other lane code or #137 implementation adopted.
