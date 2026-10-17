# Private decoded-frame reservation correction

Accepted predecessor stays runtime `7cf47ab92dde3dcb3c6230b17bc408a8d58becdc`,
documentation `3b45be9f53e7a32c881f226cd0e5a44728fc449e` / #198. This is a
separate successor; it does not rewrite the accepted edited-portable evidence.

Tested successor code: `463deb091a8c21c31287954bdb419ab5594eb9b7`, clean tree.

## Scope and ownership

Only private indexed-media reader, budget helper, fault tests and this report.
Normal Host/App/model/registry/root manifests and approved #76 public contracts
are unchanged. Shared/Extension owner was notified in #198 comment6139948581;
consume this successor only after review by exact pin. Public readiness and the
original33-case legacy regression remain the integration owner's separate gate.

Previously, frame count and dimensions had independent limits, with no aggregate
pixel/byte reservation. The reader now reserves the entire verified GOP before
constructing/configuring VideoDecoder, and a separate charge before each clone.
Per-session and realm pixel AND byte checks are atomic. Reserve failure creates no
decoder/clone and does not partially debit either ledger. Symbol.for shares one
private ledger across independently bundled readers in the same realm. Different
browser realms/workers are not combined by this ledger.

Limits are derived from the existing profile, not raised: maximum padded frame
1920x1112, 64 cached outputs + 2 outstanding clones; existing 2-reader bound.
Session:140912640 pixels /563650560 bytes. Realm:281825280 pixels /1127301120 bytes.
These are conservative RGBA-equivalent accounting ceilings, not a recommended
mobile allocation or performance/production-memory acceptance. The baseline
640x360 profile is charged at its own maximum dimensions. Clone charges remain
separate even if a browser shares their backing allocation.

Owned frames close before reservations release. Decoder closes before failed-GOP
reservations return; generation invalidates late output. Clone failure returns
its own charge. Lifetime and call cancellation are combined. Dispose waits for
outstanding caller leases; it cannot return their capacity early. Original input,
GOP64, two outstanding requests/leases and all content/storage caps are unchanged.

This bounds application-held decoded-frame accounting, not opaque browser codec
reference surfaces, decoder working memory, GPU texture/driver duplication,
canvases, encoded bytes or PCM. It is not a total-process memory guarantee. The
existing whole-buffer legacy reader is outside this indexed-reader correction.
Multiple-source *reader admission* is tested; multi-source timeline compositing is
not newly enabled.

## Exact-code checks

At `463deb091a8c21c31287954bdb419ab5594eb9b7`:

- PASS root typecheck, lint, build and file policy.
- PASS focused budget units3: both dimensions/scopes, competing source reservations,
  atomic refusal, immutable limit/cost capture, invalid/unsafe charge rejection,
  idempotent release and drain-before-close.
- PASS real-reader fault harness7 cases: constructor/decode/clone failures;
  two-source outstanding-lease drain; pre-decoder/pre-clone realm refusal;
  abort during flush; independent bundles sharing one ledger. Fault I/O/decoder
  is injected; these are ownership/admission assertions, not native codec proof.
- PASS native Chromium real146163851-byte iPhone reader: full raw AAC/tail PCM
  and final indexed video frame against the existing independent oracle.
  Screenshot inspected. This is reader correctness, not another portable gate.
- PASS existing baseline indexed-reader browser suite, including cross-GOP leases,
  third-request refusal and dispose drain. Both browser reports have errors0.
- NOT RUN full edited-portable rerun, normal Host33 regression, physical mobile,
  mobile export, performance, cross-worker aggregate budget, total GPU/process
  memory acceptance. Prior #198 evidence remains valid only at its own fixed pin.

Before this pin: uncommitted first lint failed on harness globals; implementation
commit `9ed83285ca739b97951cfc946a697f18e210fede` retained one harness no-this-alias
lint failure. Successor463deb09 captures only the late-output callback. Production
reservation code is unchanged between these two commits. Initial logs remain
/tmp/video-frame-budget-pre-*.log; failures are not erased by final PASS.

## Reproduction and evidence

Run root `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:files`;
`npx vitest run packages/video-metadata/host-media/indexed-media/frame-budget.test.ts --no-file-parallelism`;
`node packages/video-metadata/host-media/indexed-media/frame-budget-check.mjs`.
Native reader runners:

```
node packages/video-metadata/host-media/file-source/reader-v1-check.mjs /workspace/video-codec-eval/deps /workspace/video-fixtures/vision-iphone6/D06_V_indoor_move_0001.mov <fresh-directory>
node packages/video-metadata/host-media/indexed-media/check.mjs /workspace/video-codec-eval/deps <fresh-directory>
```

Node24.19, Chromium151/Linux. Logs `/tmp/video-frame-budget-*.log`; reports below.
The frozen external codec dependencies and original are prerequisites; this change
installs nothing and sends no media remotely. Outputs stay outside Git.

- `/tmp/video-frame-budget-checks.json`: `df9206707482db5e5c85fa99730c94c56eb3d767ef274f44a04a107cc147b3f7`
- `/tmp/video-frame-budget-faults.log`: `b79e7379f39cb5c3f0b224fbdef87c17eff458e46c2844a7351d0206dd7712b3`
- `/tmp/video-frame-budget-reader/results.json`: `a28195ad33e4272c09d3ff3ece6896fc2ff56d1699e33aba9b0d1a74de8f156a`
- `/tmp/video-frame-budget-v0/results.json`: `d2befeb2c11399cd0d5685a28950d07e9eac2f4f79d49bcb51d1247912329dc1`

All workflow triggers remain workflow_dispatch-only; CI/file-size/Office disabled.
No dispatch, performance measurement, main push/merge, release/deployment/publication
or license change. This private correction requires review before integration.
