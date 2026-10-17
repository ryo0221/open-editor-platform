# Actual-original v1 session UI verification

Exact code `4e3755365564279fb1b9d80265d4995cdd88f262`, after #195 Host fixes.
The private HTML/entry uses mountV1Host with real EditorSession/scoped controller
and productCodecV1. No Storage is bound; portable Save/Open are disabled and the
page persistently states Unsaved session. This is normal editing/media UI proof,
not durable Save or empty-Host portable acceptance. No permanent Host/root route.

PASS root typecheck, lint, build, file policy and91focused Core/v1 tests. PASS
actual original UI at1280x900 and390x900, browser errors0; screenshots inspected.
All edits use visible controls: streamed-digest import; linked split at1/1000;
Undo; refused invalid split with unchanged revision/content; existing Redo;
independent trims for both clips; linked move; sequence resize to52813/750;
Undo restoring exact whole original. Stored original metadata/validity is unchanged.
Both views preview frame880 and play from1750 to the exact fixture endpoint.
Playback of a1/7-second interval explicitly refuses non-integral48000Hz endpoint;
three Undos restore the full original afterward.

Desktop Export MP4 downloads the whole original timeline through the normal
button. Independent FFmpeg full decode and first/mid/last image+PCM comparisons
PASS. Output1080x1920 AVC,mono48000Hz AAC,1761video intervals,T42251/600;
last packetPTS3379200,duration880,timebase1/48000. Valid3380080mono samples;
3380224raw decoded samples include144outside-presentation codec padding.
PCM max differences0 /0.000349832 /0.000852002; RGB mean differences
2.038148 /1.584697 /1.223699 at output frames0/880/1760 versus independently
selected originalPTS0/21116/42231 at600Hz. No proxy or original shortening.
Output SHA256 `c8e561dd81ae9f2ee7111766e7f780869ddc5d43fb7c57cd8e7bad532a4b250f`.

Logs `/tmp/video-v1-ui-{type,lint,build,files,unit,ui}-pinned.log`; raw results,
screenshots/output under `/tmp/video-v1-ui-pinned/`. Installed @noble/hashes1.8.0
input-to-bundle provenance and full MIT notice are emitted alongside those local
artifacts. No dependency/license change; no registry tarball attestation.

The exploratory working-tree run under `/tmp/video-v1-ui-first/` passed before
Host review fixes. Its resize input211253/3000 left a small extra interval;
the pinned test corrects this to exact52813/750 and asserts each clip duration.
The full-original export in both runs occurs only after exact content restoration.
Exploratory results are not substituted for the final code pin.

Dependency chain: #190 atomicity -> integration-context
`0e1564b100028a0a1953ae4992a097ec38e9a64e` (also approved #187/#188) ->
#191 bounded actual-file reader -> #192 full exact output; #193 admission correction
joins at #194 Host port -> #195 Host ownership/view fixes -> this UI layer.
Keep their verification documents and implementation when reviewing/closing layers.

NOT RUN: actual146MB portable save->fresh empty Host reopen, pending Storage owner
v1 version dispatch/opener and trusted same-coordinator reconciliation. Prior
native-v0 compatibility evidence stays pinned in #191. Performance remains held.
No Actions dispatch/main merge/release/deploy/publication/license change.
