# Private general browser archive verifier

Based on reviewed #172 HEAD414514241ee0dff13159635826c7493f513c2865. This branch is
separate from #176/#178 journal work and does not adopt or modify their protocol.
All changes stay within file-backed-storage. No public package export, manifest,
lock, shared Host, bundle/import/codec or root dependency changes.

## One profile and one validator

`portable/io.ts` contains bounded Reader/Sink/CRC and an injected streaming digest.
`portable/zip64.ts` contains the existing strict ZIP64 STORE writer/reader, now using
Uint8Array/DataView instead of Buffer. `portable/project.ts` contains the existing
canonical metadata, exact fields/capture, native version hash, retained parent and
original/interpretation closure validation. Node entrypoints bind these same
factories to node:crypto and filesystem readers. There is no second browser
schema implementation. Content validation and interpretation still reuse existing
public Core and the unchanged private Host import function.

`adapter.ts` binds that shared profile to bounded Blob/File ranges. `open` returns
validated native versions, original range readers and a full-file receipt; optional
expected pins additionally require exact operation, capture, byte count and SHA.
`verify` is structurally compatible with the private journal verifier callback and
returns false on any mismatch, malformed closure, short read or cancellation. It
does not publish, overwrite, select or settle journal operations. The Host retains
the immutable completed File or corresponding journal lease until all original
readers/media work settle. Arbitrary changing readers are not snapshot guarantees.

Each read is at most64KiB, metadata is at most64KiB per record, whole archive at
most8GiB and originals at most4GiB aggregate (existing candidate budgets). The
implementation never requests a whole-file ArrayBuffer. Metadata-only WebCrypto
content hashing remains bounded. Tests track actual requested ranges and maximum
simultaneous reads; these are structural assertions, not performance measurements.

## Digest capability and adoption decision

The adapter takes a trusted `DigestFactory` (update/hex/dispose). It does not import
a digest library itself. The controlled local test Host injects the already
installed **@noble/hashes1.8.0**, pinned in the existing lock and used elsewhere in
the repository. No install, new dependency declaration or permanent Video adoption.

- Candidate: @noble/hashes1.8.0, incremental SHA-256, MIT; copyright2022 Paul Miller.
- Existing lock integrity: `sha512-jCs9ldd7NwzpgXDIf6P3+NrHh9/sD6CQdxHyjQI+h/6rDNo88ypBxxz45UDuZHz9r3tNz7N/VInSVoVdtXEI4A==`.
- The runner rejects any installed version other than1.8.0. Its browser metafile
  records actual included modules and rejects the Node backend. The SHA implementation
  is statically bundled locally; no provider, network request, server, worker or
  runtime code download is required. Test outputs remain private/outside Git.
- Any distributed bundle must retain the installed package's MIT copyright/license
  notice. A future Video dependency/notice declaration requires technical review;
  root/shared ownership is unchanged. Current installed LICENSE is the authority.
- WebCrypto digest alone requires the complete message buffer; it does not provide
  incremental SHA-256. A custom implementation would add unnecessary cryptographic
  review burden. Neither alternative is silently substituted.

This is a test-host capability evaluation, not dependency/security certification.
No arbitrary provider implementation may be accepted from untrusted content.

## Portable file versus scratch storage

The portable ZIP64 project file contains retained native versions, interpretation
plans and originals. OPFS staging/journal state is not a portable project format.
The verifier has no OPFS dependency. Tests download the actual verified File, verify
its SHA in Node, and reopen it in a fresh empty browser context after deleting the
source original. No OPFS scratch or original URL is needed. A failed verification
only rejects that candidate; this module never modifies earlier outputs or converts
an unknown journal state into no-write. Journal/normal coordinator integration is
a separate gate, with #178's rejected-ID corrections reviewed independently.

## Checks

```sh
node packages/video-metadata/file-backed-storage/browser-verifier/check.mjs /tmp/video-verifier-new-output
./node_modules/.bin/vitest run packages/video-metadata/file-backed-storage packages/video-metadata/host-media/workflow.test.ts packages/video-core/src
npm run lint
npm run typecheck
npm run build
npm run check:files
```

The output directory must not exist; failures cannot be overwritten. The runner
bundles the exact reviewed Node base as a differential oracle without changing the
checkout. It compares generated archive SHA/bytes and malformed-input verdicts
against the refactored engine, and independently reads large ZIP entries with
Python's standard-library CRC reader. Browser tests use a real File input and an
actual >40MiB portable archive containing a parent-only retained original. No
codec/media decode, ordinary Video UI, operating-system crash, power-loss,
user-file overwrite, full repository or performance acceptance is claimed.
