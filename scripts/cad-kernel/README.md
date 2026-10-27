# Development CAD kernel (custom OpenCascade.js build)

The kernel the CAD Hosts, `cad-kernel-occt` tests and CAD e2e suites use through `CAD_OCCT_DIST`. It replaced the npm `opencascade.js@2.0.0-beta.b5ff984` build as the development kernel on 2026-10-22 because the npm build cannot free returned OCCT values or kernel exceptions (#355, leak-check record). It is still a development build, not the distributed kernel: the Host-side build manifest of the D0 gate is missing.

- `build.mjs`: the pinned image digest (`donalffons/opencascade.js`, published 2023-03-23 with the npm `2.0.0-beta.b5ff984` package: Emscripten 3.1.14, OCCT `bb368e271e24f63078129283148ce83db6b9670a`), the output file names, the expected Wasm SHA-256 and the `kernelProfile.id` for new documents.
- `opencascade.d0-leakcheck.yml`: only the bindings `cad-kernel-occt` and the D0 probes use (D1 modelling, the D2 STEP writer and reader with their base classes, `BRepTools` with `BRep_Builder` for the normalized BRep asset of an imported body, and the R1 set: shape maps, lists and history for persistent topology names, the edge polygons of the display mesh, fillet, chamfer, shell, draft, arcs, loft and sweep; and the R2a set: B-spline curves and surfaces with their arrays, surface filling, sewing, shells and solids from faces, splitting, projection, free bounds and surface properties; and the R2b set: XDE documents, labels, names and colours, the STEPCAFControl writer and reader, and `gp_Cylinder`; and the R2c set: plane sections, half-spaces and polygonal hidden lines with their projector), `-sMAXIMUM_MEMORY=512MB`, and these additions to `OCJS`:
  - `releaseException(ptr)`: frees an OCCT exception object that reached JS. Without it, every caught kernel exception stays allocated.
  - `heapAllocatedBytes()`: bytes currently allocated by malloc (`mallinfo().uordblks`), for the leak check.
  - `setStaticInteger(name, value)` and `staticInteger(name)` (R2b): `Interface_Static` integer settings, such as the STEP schema the writer uses (`write.step.schema`, 5 for AP242).
  - `labelName(label)` (R2b): the UTF-8 `TDataStd_Name` of an XDE label, or an empty string.
- `patch-destructors.py`: the pinned generator makes `delete()` a no-op for every class with a placement `operator delete` (almost every OCCT value class), so a `TopoDS_Shape`, `gp_Pnt` or `Bnd_Box` returned by value is never freed. The script restores `delete ptr` for the linked bindings and recompiles them before the link. Standard_Transient subclasses and classes without a public destructor keep the no-op.
- `build.sh <out-dir>`: runs both steps in the pinned image and prints the Wasm SHA-256. Requires a Docker daemon and takes about an hour on 4 cores; the link needs the Emscripten FreeType port, downloaded once from `github.com/emscripten-ports/FreeType/archive/version_1.zip`. Where that download is blocked, set `FREETYPE_SRC` to a checkout of the same tag (`git clone --depth 1 --branch version_1 https://github.com/emscripten-ports/FreeType`); the build copies it into the image's port cache instead. Linking every binding of the full build ran out of memory (wasm-ld killed at 15 GiB), so the build keeps to the D1 set.
- `bundle.sh <kernel-dir>`: writes `NOTICE.txt` (the notice section of [`docs/third-party/cad-kernel`](../../docs/third-party/cad-kernel/README.md) plus the license texts) next to the Wasm, and `source/` with the corresponding source: the unmodified OCCT archive and the OpenCascade.js generator from the pinned image, these build inputs and `SHA256SUMS`. Anyone serving the kernel outside a development machine serves both. The development server serves `NOTICE.txt` at `/cad-kernel/NOTICE.txt`.

```sh
npm run cad:kernel            # builds into work/cad-kernel (outside Git)
# Behind a TLS-intercepting proxy or a Docker Hub rate limit:
IMAGE_PREFIX=mirror.gcr.io/ \
  DOCKER_ARGS="-v /path/to/ca.crt:/ca.crt:ro -e SSL_CERT_FILE=/ca.crt" npm run cad:kernel

sh scripts/cad-kernel/bundle.sh work/cad-kernel   # NOTICE.txt and source/
export CAD_OCCT_DIST=$PWD/work/cad-kernel
npx vitest run packages/cad-kernel-occt
npx vitest run --config experiments/cad-kernel-d0/vitest.config.ts experiments/cad-kernel-d0/leakcheck.probe.ts
E2E_SUITE=cad npx playwright test
```

`scripts/dev/cad-kernel.mjs` and the tests refuse a Wasm whose SHA-256 differs from `build.mjs`.

## Replacing the kernel

Documents name the exact build that evaluates them (`kernelProfile.buildHash`). When a new build replaces this one:

1. Move the current entry of `build.mjs` into `cadKernelPrevious` (keep `id`, `js`, `wasm`, `wasmSha256`). Set `substitute: true` once the new build has been checked on the old documents' features, so the Hosts show those documents read-only with the new build. Set `revoked: true` instead to stop a build entirely.
2. Put the new build's file names and hash in `cadKernelBuild`.
3. To keep evaluating old documents exactly, keep the old output directory and list it in `CAD_OCCT_RETAINED` (comma-separated). The development server checks each Wasm against `cadKernelPrevious` and serves it under `/cad-kernel/<hash prefix>/`.

Editors move a document to the new build with "Migrate to current kernel", which is one undoable edit. Saved versions keep their build. Documents created with the npm build name its hash and report `kernel-build-unavailable` with this kernel.
