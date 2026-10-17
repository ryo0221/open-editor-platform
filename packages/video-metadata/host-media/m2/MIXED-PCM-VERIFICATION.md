# M2 multiple-original PCM checkpoint

Private reversible implementation, tested source `1464fe3a4e127d7703caaae77952ed69a92368b9`.
Base #206 `dbbda3f3b0871b6d2a8d804f8918d8fc5a580c33`.
Main observed unchanged `5a32d355ac107258a604e5a4d7a45d03f3b9efdb`.
No other lane branch imported. This is not full M2 or Epic completion.

## Contract and ownership

Approved gain0..1 and linear amplitude fades from AUDIO-V2-CONTRACT.md are
applied through the existing exact global sample clock and JS resampler.
New AV interpretation is explicitly format `video-media-interpretation-v2`,
profile `av-sdr-v2`; independent audio uses profile `aac-mono-v2`.
Native schema is `video-core-prototype-v2`; generic Artifact envelope stays1.
Existing v1 imports remain unchanged. AV append preserves existing v2 gain/fade.
Storage version dispatch is requested separately from its owner, not implemented here.

The adapter owns an immutable content snapshot, verified original references,
bounded PCM files, source leases and renderer sessions. Original bytes are hashed
in65536-byte slices and exact source interpretation is checked before decoding.
It admits one active output block, returns only a fully validated mix, drains
pending work on disposal, and attempts every acquired-resource release on errors.
Existing scratch128MiB/four-file limits remain unchanged. It does not own
WebAudio scheduling, video frames, export sinks or Storage commit state.
No capacity, codec dependency, shared Host or Rust backend changes.

## Same clean source verification

| Gate                                                          | Result                                          |
| ------------------------------------------------------------- | ----------------------------------------------- |
| `npm run typecheck`                                           | PASS                                            |
| `npm run lint`                                                | PASS                                            |
| `npm run build`                                               | PASS                                            |
| `npm run check:files`                                         | PASS                                            |
| Core, rational boundary and M2 focused tests                  | PASS:85tests/8files                             |
| Actual two-original plus AAC browser PCM gate                 | PASS                                            |
| Normal Host/mobile UI, video assembly, scheduling, AAC export | NOT RUN                                         |
| M2 portable persistence/reopen                                | NOT RUN: dispatch and capacity approval pending |
| Performance, Actions, release/deploy                          | NOT RUN: held                                   |

Focused command: `npx vitest run packages/video-core/src packages/video-core/experiments/pcm-renderer/boundary.test.ts packages/video-metadata/host-media/m2 --maxWorkers=1`.
Browser command: `node packages/video-metadata/host-media/m2/mixed-pcm-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0002.mov /tmp/video-mixed-pcm-pinned`.

The browser reads both full approved originals (no whole File.arrayBuffer), trims
the first to its last2seconds, then uses source[.001,2.001) from the second.
A locally generated mono44.1kHz AAC/M4A tone is independently placed at.001.
Voice gain.25/fades.1seconds; music gain.2/fades.5seconds.
All192000 output points are independently compared with FFmpeg-decoded sources,
exact source offsets and explicit amplitude equations. Maximum absolute error
1.4569726772585556e-6; RMS2.4696802466312703e-7. Head/cut/tail windows also pass.
Irregular1/127/4096/997-point chunks and a repeated seek across the source cut
match bit-for-bit. Native hash is unchanged. In-flight disposal rejects output;
wrong second-source SHA refuses after partial preparation; both drain to
building0/reads0/files0/bytes0. Browser error gate passes.

Evidence stays outside Git: `/tmp/video-mixed-pcm-checks.json`,
`/tmp/video-mixed-pcm-{type,lint,build,files,unit,browser}.log`,
`/tmp/video-mixed-pcm-pinned/results.json`.
Initial development run `/tmp/video-mixed-pcm-pre.log` was FAIL (source ID collided
with track ID); test source renamed bgm. Pre-pin prototype success is separately
recorded at `/tmp/video-mixed-pcm-pre2`, not claimed as fixed-pin evidence.
Async contentHash comparisons and partial-acquisition cleanup were corrected
before the tested source commit. No hidden retries alter pinned results.

## Limits and next owners

Both full original files total298716660bytes, beyond existing256MiB portable
limits. No proxy, truncation or capacity increase is used to claim portable PASS.
Storage #205 corrected capacity ownership is separately reviewed; a512MiB archive /
2GiB total test policy still requires user approval, and journal1GiB is unchanged.
Real multi-source visual assembly, preview/export sharing, user editing UI,
Storage v2 round-trip and reviewed normal Host integration remain outstanding.
The separate Rust lane owns its backend and frozen-oracle gates; this slice uses
JS only and does not measure performance. Physical devices/general codecs and
opaque decoder/process memory are not certified by these checks.
