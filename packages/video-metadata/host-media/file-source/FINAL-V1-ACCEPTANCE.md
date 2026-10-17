# Actual edited-original portable acceptance — private v1 profile

Tested code `7cf47ab92dde3dcb3c6230b17bc408a8d58becdc`. This is the bounded
actual iPhone AVC/AAC workflow, not all of Issue #75 or permanent Host/API adoption.
The same code is used for all final checks below; no unrelated pins are aggregated
into the edited-portable claim. Main remains5a32d355ac107258a604e5a4d7a45d03f3b9efdb.

## Real source and edit

Unchanged original146163851bytes, SHA256
`69e089ae0cc9ad02b7d2461965d6a00d47cb91f7b02e620d10db9ec356731dd4`.
Original T42251/600 and raw mono44100Hz integer grid3107840samples remain stored;
validity end has sample coordinate3105448.5. The original is neither shortened nor
replaced by a proxy. Whole-input File.arrayBuffer is prohibited by the browser gate.

Visible UI commands split, independently trim both linked streams, move the linked
pairs and resize the sequence. The selected edited timeline, retained through Save
and reopening, is original[41051/600,42251/600) followed by
original[1/1000,2001/1000), total4seconds. These begin at source sample coordinates
3017248.5 and44.1, respectively. Undo/Redo is exercised and returns to this edited
content, never the original unedited timeline before the acceptance export.

Three retained versions are downloaded with the entire original. New browser
processes at1280x900 and390x900 assert empty origin storage and receive only the
portable file. They verify edited native/hash, retained envelopes/hashes/plans,
original byte length and SHA, save a fourth version, preview and play the selected
edit. Desktop additionally exports MP4 from the reopened content. Mobile export is
NOT RUN. All retained compressed originals are independently probed, including a
source ID reused with another original in a historical version; caching is by
original SHA, not source ID.

## Final results

Root typecheck/lint/build/file policy PASS. Related units PASS240/15files, run with
--no-file-parallelism. Host ownership browser regressions PASS/errors0: complete
view preflight, rejected mutations preserve revision and pending Redo, stale Open,
close during Open, unknown recovery and A->B->unknown->A.close refusal->B.Reconcile
->A.close retry. These injected Host fault seams are distinct from the real storage
browser suite, whose8groups PASS/errors0 using actual journal writes, lost
acknowledgement, aborted verification, same-owner reconciliation and next Save.

Actual edited portable result: PASS at the same clean code pin, page/console
errors0. Archive146174324bytes. Selected edited native SHA256
`eba3935133d716b3249ff4c164ce5d02f2cd6d53e3ed5bfb22ebdcadf70a8002`
is unchanged across both empty-origin reopens. Output MP4 SHA256
`b2b5c9a9965a517707c9ac1aff97e598d2a043f262ec6dd71b1645ff0f25038d`.
Last video packetPTS190080/duration1920 at1/48000. Raw decode192512samples
includes512outside-presentation codec padding. Whole-segment PCM RMS differences
0.000189988 and0.000151440; cut window max0.000559759/RMS0.000184069.
Picture means at frames0/25/49/50/51/99 are1.44668/1.31185/1.23578/1.37315/
1.79053/3.43496 (RGB255 scale). Both screenshots inspected.

Report SHA256:
- portable: `c10a23ddd8adcc9df44ff2c1ef1a0360d08ddc60311255f3c14dd99bd4f53000`
- Host: `496cd43215412514cec540fdc02bfcdc5d8a59afcb4d26f46ec8db29d73dbee0`
- storage: `08d3a5af6a2bb7f3c33389fb889b20bc19f0d6c51436c5d94447ca8e4c3bc1fd`

Reproduction: run `host-review-v1-check.mjs`, the owner
`file-backed-storage/integration/v1-check.mjs`, and
`portable-ui-v1-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov <fresh-output-directory>`.
Private Host scripts are in this directory. Each runner requires a new output
folder and preserves existing evidence.

Independent oracle uses native FFmpeg decoding. It maps expected output samples
to original48k samples[3284080,3380080) then[48,96048), compares both complete PCM
segments plus head/cut/tail windows, and selects original VFR frames independently
from ffprobe PTS for output frames0/25/49/50/51/99. It does not reuse the whole-
original oracle as edited evidence. Output is1080x1920 AVC + mono48k AAC,100video
intervals and192000valid PCM points. Raw decoded padding is reported separately.

Final artifacts/logs stay outside Git under /tmp/video-v1-*-acceptance/ and
/tmp/video-v1-acceptance-*.log. Full MIT notice and installed @noble/hashes1.8.0
input-to-bundle provenance accompany the local artifact; no dependency/license
change or registry-tarball attestation. Screenshots are inspected before reporting.

## Earlier failures and separate evidence

- eed4975c root type/build FAIL: old Storage harness host.handle access; fixed by
  reviewed #199 f2557aa0/docs ea00e2d3, now uses guarded editor.save.
- eed4975c concurrent unit run FAIL155/156: existing F01 archive timeout5000ms.
  Same pin serial rerun PASS156/156. Timeout and production limits were unchanged.
- 9f396149 root type/build FAIL: unreachable post-terminal replacement.close type
  narrowed to never after the delegated-close fix. Fixed in3406bb1c.
- 3406bb1c full edited146MB roundtrip PASS at06:20:39UTC, before the retained-source
  probe loop was strengthened. Its reports remain /tmp/video-v1-portable-final/.
- Environment disconnect notification06:22UTC did not interrupt this environment:
  at06:24:19UTC files/commands were accessible, no Node jobs remained, worktreeclean.
  No restart or overwrite of completed/live evidence occurred.
- Whole original T42251/600 export remains separately pinned in #192/#197. #197's
  export restored unedited content first and ran only at1280;390 was edit/preview/play.
  Those results are not relabeled as this edited-portable gate.

## Integration and limits

#190 atomicity plus approved #187/#188 -> context0e1564b1 -> #191 actual reader ->
#192 exact whole-original output; #193 admission fix joins at #194 Host port ->
#195 view/ownership fixes -> #197 ordinary UI. Reviewed Storage #196 joins at
context2537a7e7; #198 recovery/wiring plus #199 same-storage reconcile port and
Host delegated-close/retained-probe corrections produce this candidate. Preserve
all intermediate source and evidence documents if layers are consolidated.

Portable/native/interpretation explicitly use v1 profiles; generic artifact envelope
schemaVersion stays1 under reviewed #196. No silent v0 upgrade/hash/history rewrite.
The earlier envelope2 request and this compatibility interpretation were reported
before parent-authorized conditional integration. All ports remain private.

Still held/not claimed: CI dispatch/performance/power-loss acceptance/main merge/
release/deployment/publication/license change, permanent Host/shared registration,
general codec/format support and production total-memory guarantees. The fixture
uses separate original256MiB/liveUndo512MiB/scratch256MiB/external256MiB/journal1GiB
quotas; decoded video cache can retain64frames x2sessions without a total pixel/byte
reservation. Playback rejects non-integral48000Hz presentation endpoints. Full Video
Epic completion and unrestricted capacity are not established by this gate.
