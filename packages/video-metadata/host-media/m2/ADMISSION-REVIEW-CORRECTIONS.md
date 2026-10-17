# M2 admission review corrections

Supersedes only the affected admission claims at #207 source1464fe3a and
predecessor #206; other prior evidence retains its exact pin.
Corrected source `33907d8b38d20f6930734bfa54367fc2ff84f277`.

## Confirmed defects and corrections

1. Stereo AAC was admitted by the audio-only probe; the previous combined
   inspect+PCM test caught only the later mono decoder guard. A new probe-only
   regression reproduced `Stereo interpretation was published` on the old parser.
   `trackSet=audio-only` now requires ASC channelConfiguration1 before returning
   interpretation. AV/v1 retains its existing admission. No public channel field
   was added. The regression proves no interpretation publication, unchanged
   native identity and no PCM scratch, then independently verifies mono44.1/48kHz.
2. An admitted clip with sourceIn1/100000003, sourceOut1/2 and
   fade.start1/100000007 could overflow serialized Time during gain evaluation.
   Fade.in0 and fade.in1/2 both exercise this boundary. Gain evaluation now uses
   exact BigInt intermediate rational differences and ratios, clamps exactly,
   then converts only the amplitude ratio to Number. Public/native Time bounds
   and schema are unchanged. This is not a floating-point time approximation or
   a zero-ramp-only workaround. The fixed number of bounded input terms also
   bounds intermediate integer magnitudes well below Number's exponent range.
   Tests cover the exact positive ratio8/10000001000000021, nonzero output-grid
   times, moved-clip invariance, real mixer chunks and unchanged native bytes.
   Existing command validation/rejection and pending Redo tests remain in the gate.

## Evidence

Same clean source: root type/lint/build/files PASS; focused87tests/8files PASS;
mono44.1/48kHz browser with FFmpeg oracle and admission-only stereo refusal PASS;
actual two-original plus independent AAC mix with FFmpeg oracle PASS.
Reports `/tmp/video-review-checks.json`, `/tmp/video-review-profile-pinned/results.json`,
`/tmp/video-review-mix-pinned/results.json`; logs `/tmp/video-review-*.log`.
Reproduced failures remain at `/tmp/video-stereo-admission-before.log` and
`/tmp/video-fade-overflow-before.log`. Development after-fix successes remain
separate from these fixed-pin results. Whole UI/visual/export/portable M2 and
performance/Actions remain NOT RUN, not certified by this correction.

Independent review is still required before Storage adopts this corrected chain.
No capacity increase, public API addition, v0/v1 conversion, release or merge.
