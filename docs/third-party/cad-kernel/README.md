# CAD kernel notices and corresponding source

The 3D CAD kernel (`opencascade.d0-leakcheck.wasm` and its loader `opencascade.d0-leakcheck.js`, built by [`scripts/cad-kernel`](../../../scripts/cad-kernel/README.md)) is a separate WebAssembly program. EditorPlatform loads it at runtime and does not link it into its own bundles. The files in this directory are the upstream license texts it carries. `scripts/cad-kernel/bundle.sh` joins the section below and those texts into the `NOTICE.txt` that is served next to the Wasm, and writes the corresponding source next to it.

<!-- notice -->

EditorPlatform 3D CAD kernel (custom OpenCascade.js build)

This software makes use of, and is based on, facilities provided by the Open CASCADE Technology software (https://dev.opencascade.org/).

| Component                                      | Version in this build                                                                              | License                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Open CASCADE Technology                        | 7.6, commit bb368e271e24f63078129283148ce83db6b9670a                                               | LGPL-2.1 with the Open CASCADE exception 1.0                   |
| OpenCascade.js (generated bindings, `OCJS`)    | build image of 2023-03-23 (npm 2.0.0-beta.b5ff984)                                                 | LGPL-2.1                                                       |
| Emscripten runtime (JS loader, system library) | 3.1.14                                                                                             | MIT or University of Illinois/NCSA                             |
| musl libc (part of the Emscripten system lib)  | as shipped with Emscripten 3.1.14                                                                  | MIT                                                            |
| libc++, libc++abi, libunwind, compiler-rt      | as shipped with Emscripten 3.1.14                                                                  | Apache-2.0 WITH LLVM-exception, or University of Illinois/NCSA |
| dlmalloc (Emscripten's default allocator)      | as shipped with Emscripten 3.1.14                                                                  | Public domain (CC0), by Doug Lea                               |
| FreeType (Emscripten port, `-sUSE_FREETYPE=1`) | 2.6.0, emscripten-ports/FreeType tag `version_1` (commit 40a760c963bc2b76575918ff91a515c8474db4e0) | FreeType License (FTL)                                         |
| RapidJSON (headers, OCCT glTF code)            | commit 083f359f5c36198accc2b9360ce1e32a333231d9                                                    | MIT                                                            |

Portions of this software are copyright © 2006 The FreeType Project (www.freetype.org). All rights reserved.

Changes made for this build:

- OpenCascade.js applies two source patches to OCCT before compiling it (`standard_time.patch`, `using-statements.patch`, in `opencascade.js-src.tar.gz` under `opencascade.js/src/patches`).
- EditorPlatform restores the destructor of the value classes it binds (`patch-destructors.py`) and adds `OCJS.releaseException` and `OCJS.heapAllocatedBytes` (`opencascade.d0-leakcheck.yml`). Only the bindings listed in that file are linked, and Wasm memory is capped at 512 MiB.

Corresponding source and rebuilding:

- `source/` next to this notice holds the unmodified OCCT archive (`occt-bb368e2.tar.gz`), the OpenCascade.js generator and patches (`opencascade.js-src.tar.gz`), the EditorPlatform build inputs (`editor-platform-cad-kernel/`), the Emscripten version and the pinned build image digest (`image.txt`). `source/SHA256SUMS` lists every file.
- `editor-platform-cad-kernel/build.sh <dir>` rebuilds the kernel in that image. Two clean builds produce byte-identical Wasm, loader and type files.
- To use a modified kernel, rebuild it, put the new `.js` and `.wasm` in the kernel directory the Host serves (`CAD_OCCT_DIST` for the development Hosts) and set `wasmSha256` in `build.mjs` to the new Wasm hash. The Host refuses a Wasm whose hash differs from `build.mjs`; documents record the build they were made with and show the build mismatch instead of silently re-evaluating.

The full license texts follow.

<!-- /notice -->

## Where the texts come from

All texts were copied unchanged from the pinned image `donalffons/opencascade.js@sha256:3069f4c2e3ab62bb82d81843bad2c0f8552ee92373208f8f655ef9bf71c0524d`.

| File                              | Path in the image                                                        |
| --------------------------------- | ------------------------------------------------------------------------ |
| `occt-LGPL-2.1.txt`               | `/occt/LICENSE_LGPL_21.txt` (OpenCascade.js uses the same LGPL-2.1 text) |
| `occt-LGPL-exception.txt`         | `/occt/OCCT_LGPL_EXCEPTION.txt`                                          |
| `emscripten-MIT-NCSA.txt`         | `/emsdk/upstream/emscripten/LICENSE`                                     |
| `musl-COPYRIGHT.txt`              | `/emsdk/upstream/emscripten/system/lib/libc/musl/COPYRIGHT`              |
| `libcxx-Apache-2.0-LLVM.txt`      | `/emsdk/upstream/emscripten/system/lib/libcxx/LICENSE.TXT`               |
| `libcxxabi-Apache-2.0-LLVM.txt`   | `/emsdk/upstream/emscripten/system/lib/libcxxabi/LICENSE.TXT`            |
| `libunwind-Apache-2.0-LLVM.txt`   | `/emsdk/upstream/emscripten/system/lib/libunwind/LICENSE.TXT`            |
| `compiler-rt-Apache-2.0-LLVM.txt` | `/emsdk/upstream/emscripten/system/lib/compiler-rt/LICENSE.TXT`          |

dlmalloc carries its public-domain dedication in its source header (`system/lib/dlmalloc.c`) and has no separate license file.

The link adds the Emscripten FreeType port (`-sUSE_FREETYPE=1` in the image's build script), and OCCT's glTF sources are compiled against the RapidJSON headers (`-DHAVE_RAPIDJSON`). A string search of the built Wasm finds neither FreeType's module names nor OCCT's `RWGltf` type names, while OCCT type names such as `Standard_Failure` are present, so their code most likely does not survive dead-code elimination. That is not a proof, so the notice still carries both texts.

| File                | Source                                                      |
| ------------------- | ----------------------------------------------------------- |
| `freetype-FTL.txt`  | `docs/FTL.TXT` of emscripten-ports/FreeType tag `version_1` |
| `rapidjson-MIT.txt` | `/rapidjson/license.txt` in the image                       |

Verification: the CAD kernel distribution record, `docs/verification/cad-d0/distribution.md` in the source repository (not part of the public export).
