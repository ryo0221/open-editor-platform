# fem-mesher build

`build.sh <out-dir>` builds `fem-mesher.mjs` and `fem-mesher.wasm`, an Emscripten module with Netgen's volume mesher and the thin wrapper `fem_mesher.cpp`. Its inputs are pinned in `build.mjs`: the Netgen and zlib commits and the emsdk image digest. The script checks out the sources with git on the host (or uses `NETGEN_SRC` / `ZLIB_SRC` at the pinned commits) and then compiles inside the image. The container needs no network.

```sh
IMAGE_PREFIX=mirror.gcr.io/ sh scripts/fem-mesher/build.sh work/fem-mesher
```

- **Reproducible:** two builds on 2026-11-05 gave the same `wasmSha256` and `jsSha256` as `build.mjs`. The package test checks a dist against those hashes.
- **Built without:** Netgen's GUI, Python, OCC, MPI and threads. Only the volume mesher is linked (about 2.4 MB of Wasm). zlib is compiled from source because the emsdk port download is not reachable everywhere.
- **Licence:** Netgen is LGPL-2.1. `NOTICE.txt` travels with the Wasm and names the corresponding source: the unmodified tagged Netgen release, this wrapper and this script, so anyone can relink against a modified Netgen. zlib is under the zlib licence.
- **Distribution:** not released yet. The dist sits in the project's shared files (`kernels/fem-mesher-4cad8e8476e3`). A public release, like the CAD kernel's, waits for the owner's approval.
- **Development use:** the Playground dev server serves a dist named by `FEM_MESHER_DIST` at `/fem-mesher/` after checking both hashes (`scripts/dev/fem-mesher.mjs`); a static build carries none.
