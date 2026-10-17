# Private R0 PCM kernel candidate

This isolated, opt-in experiment implements the selective Rust/WASM arithmetic
boundary reviewed in PR #203 at c2c3130.
Base is accepted normal Host **f60aa218a7c27831b3aa359b057c0b60bbdbb73a**
(documentation), with executed Host code **7d90adeeedee9a86defe00211d0a043e66885ecc**.
Its evidence remains unchanged. This directory is not exported by video-core,
registered in the normal Host, or added to a public kit. No M2 schema, mix/gain,
rounding, source membership, output profile or existing session interface changes.

**Status:** private decoded-window backend and test adapter, not enabled product
integration. Functional/build results belong to the exact pins in VERIFICATION.md.
Normal Host Save/reopen, preview/export and original/edited FFmpeg gates with this
backend are still required before selection. The accepted base's passes do not
certify this implementation. Performance measurement and tuning remain held.

## Arithmetic and oracle

`prepare.ts` retains JS BigInt rational mapping, global sample grid, bounded
fractional phase, physical source domain, Math.sin/cos, Blackman/sinc coefficients,
ordered weight totals and existing limits. Rust processes at most 64 rows, each
with at most 513 ordered taps, two channels and 32768 source frames. It performs
scalar f64 multiply then add, division, and one f32 conversion. It does not use
SIMD, FMA, parallel reductions, fast math, a heap allocator or transcendental math.
Rust validates shape, row extent, finite coefficients, total threshold, source
addresses and referenced PCM before writing any output. ABI arguments are counts;
there are no caller-controlled pointer/offset arguments. Fixed `repr(C)` arena
layout is independently validated in JS, Rust's array bounds and the build gate.
Status is typed numerically (0 success, 1 shape, 2 row/total/weight, 3 address,
4 nonfinite PCM), with a separately checked initialized output count. Failure
exposes count zero and no caller result, even if old arena output remains.

`frozen/render.ts` preserves the WHOLE old renderer, independently of new
preparation and arithmetic. Its only change redirects the original Core barrel
import to `frozen/time.ts`; all imported runtime symbols originate in that file.
The complete used dependency closure and original Git blobs are pinned in
`oracle-inputs.json` and checked by `oracle.test.ts`. No new preparation is shared
with the frozen oracle. Existing renderer/session/FFmpeg oracle sources are untouched.

Acceptance means identical f32 **bits**, including signed zero, in the same
engine using identical JS coefficient/source bytes. It does not mean cross-browser
libm identity. `check.mjs` requires actual bytes and build hash, fails on unavailable
or failed WASM, and records engine, module hash, input coefficient/source tile
hashes, backend, real invocations and successful completions. Raw Infinity from
finite-to-f32 overflow remains raw Infinity. `guard-check.mjs` separately bundles
the unchanged existing `timelinePcmV1` product function, with controlled decoder
and session bindings, to verify its SAME finite/clipping guard for both paths.
That fixture is not native codec, full timeline semantics or Host acceptance.

## Ownership, bounds and cancellation

`PcmBackend` accepts an already decoded, bounded window. Existing generation,
AbortSignal, decoder/cache/source leases and Host session remain authoritative;
this experiment does not replace their owners. One backend processes one request
at a time; overlapping calls refuse before allocation. An owner must drain before
replacement, or create a separate admitted backend. All source samples and native
scalar metadata are snapshotted before yielding. No caller input is transferred
or neutered. A returned `OwnedBlock` is an explicit private lease; its consumer
must drop all plane references before calling `release()` (idempotent). `close()`
discards unpublished work, drains idempotently and drops its arena, but does not
silently release consumer-owned output. A replacement cannot access the old arena.

A synchronous WASM call cannot be interrupted. Cancellation is checked before and
after every tile, after task-queue yields (including the final tile), and before
publication. A late abort/close discards the entire result. Runtime trap poisons
and drains that owner, with no JS retry. Semantic/input errors and cancelled work
are never retried. `auto` can select JS only before a request if module creation
or self-test fails; forced `wasm` fails instead. A caller can explicitly retry the
unchanged input snapshot with a fresh JS owner. No mixed partial output is returned.

Backing-buffer ledger (concurrent lifetimes are summed, views are not separate buffers):

| Owner                                                              |                                                                             Reservation |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------: |
| JS staging arena, including source snapshot and copied tile output |                                                                            657408 bytes |
| WASM memory, including arena, 65536-byte stack and linker slack    |                                                      786432 bytes (12 pages; min = max) |
| Caller source window/cache backing buffers                         |                                   Actual distinct complete ArrayBuffers, even for views |
| Final output planes, retained across close until consumer release  |                                       `(end-first) * channels * 4`, at most 32768 bytes |
| Module input + verified snapshot + digest                          | `2 * moduleBytes + 32`, conservatively retained until module disposal and session drain |
| Dedicated worker, transfer or structured-clone buffers             |                                                                 Zero: this R0 uses none |

657408 includes the original logical tile arrays **plus 256 bytes of row lengths**.
It is not the peak bound. Typical full two-plane input plus maximum output and the
4972-byte module reserves **1748728 bytes** including module loading allowance.
The private per-session ceiling is 2097152 bytes and realm ceiling 8388608 bytes;
reservation must succeed before allocating staging, instance, source copies or
output. This does not raise any media/frame/PCM or Host quota. Larger retained
source backing buffers may be refused even if their views fit. Source buffers
shared by two planes count once. Simultaneous requests in different sessions are
conservatively charged independently. The module has its own realm reservation
and session-local allowance; module references delay release across close.

This is bounded backing-buffer accounting, not a total browser process, JS object,
compiled-code/JIT, codec, GPU or garbage collector memory guarantee. A decoder or
cache owning buffers beyond the supplied source plane backings must retain its
own reservations in the same realm/Host ledger until its real leases end. The
future product integration must connect that ownership; this decoded-window
adapter does not infer unexposed caches or change existing source budgets. Returned
consumer leases and prepared-module leases must not be used after release/disposal.

## Reproduce manually

Node/npm dependencies use the unchanged repository lockfile. Python 3.12+ is used
for safe archive extraction. The toolchain is exact official **Rust 1.90.0**, host
x86_64-unknown-linux-gnu, target wasm32-unknown-unknown, rustc commit
1159e78c4747b02ef996e55082b704c09b970588, LLVM20.1.8, Cargo1.90.0.
`toolchain-inputs.json` pins the official manifest and all four component archives.
No rustup/bootstrap executable or floating channel is used by the installer.

From repository root, using fresh external directories:

```sh
python3 packages/video-core/experiments/pcm-wasm-r0/install-toolchain.py /tmp/r0-rust /tmp/r0-downloads
# Installation also supports --offline with cached verified archives and fresh extraction paths.
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-rust /tmp/r0-build-a
node packages/video-core/experiments/pcm-wasm-r0/build.mjs /tmp/r0-rust /tmp/r0-build-b
cmp /tmp/r0-build-a/pcm.wasm /tmp/r0-build-b/pcm.wasm
cmp /tmp/r0-build-a/manifest.json /tmp/r0-build-b/manifest.json
npx vitest run packages/video-core/experiments/pcm-wasm-r0 packages/video-core/experiments/pcm-renderer packages/video-core/src
node packages/video-core/experiments/pcm-wasm-r0/check.mjs /tmp/r0-build-a /tmp/r0-correctness
node packages/video-core/experiments/pcm-wasm-r0/guard-check.mjs /tmp/r0-build-a /tmp/r0-guard
```

Builds use `cargo build --release --frozen`, exact target/features/link flags,
fresh target directories and path remapping. Installed component files are checked
against the installer's verified inventory before each build. The manifest records
source commit/tree status, input hashes, compiler, flags, imports/exports, actual
memory bounds, WASM hash and all notices. Empty imports and the exact small export
surface are mandatory. A direct runtime test proves memory.grow(1) fails. The
compiler warns that explicit disabling of `atomics` is an unstable target-feature
switch. The final linked module has nonshared fixed memory and no imports or
atomic/SIMD features. Its official precompiled core/builtins still advertise
`bulk-memory`, `bulk-memory-opt`, `call-indirect-overlong`, `multivalue`,
`mutable-globals`, `nontrapping-fptoint`, `reference-types` and `sign-ext`, despite
per-crate disabling flags. The build gate pins this actual emitted list in the
manifest and rejects changes; this is **not an MVP-only compatibility claim**. This warning is retained rather than hidden.

Cargo has **zero third-party dependencies**. Compiler-supplied core/compiler-builtins
are part of the official Rust target distribution. Build output includes complete
installed Rust/Cargo notices, COPYRIGHT-library.html, COPYRIGHT.html and their
license texts with hashes, rather than only a link. This private repository has
no root LICENSE; the existing public-export MIT overlay is copied under an explicit
`EXISTING-PUBLIC-EXPORT-LICENSE-NOT-A-PRIVATE-LICENSE-GRANT` name solely as existing
provenance. It does not grant a new license to this private backend. No package,
dependency or repository license is changed. Generated WASM, raw logs, manifests,
notices and test bundles remain outside Git; no opaque binaries are committed.

No workflow was added or dispatched. Existing CI remains disabled/manual-only.
No main push/merge, release, deployment, public publication, new public API,
security-setting change, benchmark or speed improvement claim is included.
