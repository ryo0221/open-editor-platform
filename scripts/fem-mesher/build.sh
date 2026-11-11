#!/bin/sh
# Builds the fem-mesher Wasm (Netgen volume meshing, R3b) into <out> with the pinned image and
# sources of build.mjs. Requires Docker and git. IMAGE_PREFIX selects a registry mirror (e.g.
# mirror.gcr.io/); the digest pins the image either way. NETGEN_SRC / ZLIB_SRC may point at
# existing checkouts; they must be at the pinned commits.
set -eu
out=${1:?usage: build.sh <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
field() { sed -n "/$1: {/,/}/s/.*$2: '\([^']*\)'.*/\1/p" "$here/build.mjs"; }
image="${IMAGE_PREFIX:-}$(sed -n "s/.*'\(emscripten\/emsdk@sha256:[0-9a-f]*\)'.*/\1/p" "$here/build.mjs")"
mkdir -p "$out"
out=$(cd "$out" && pwd)
work="$out/work"
mkdir -p "$work"
checkout() { # name dir
  url=$(field "$1" url)
  commit=$(field "$1" commit)
  tag=$(field "$1" tag)
  if [ ! -d "$2/.git" ]; then git clone -q --depth 1 --branch "$tag" "$url" "$2"; fi
  have=$(git -C "$2" rev-parse HEAD)
  if [ "$have" != "$commit" ]; then echo "$1: $have is not $commit" >&2; exit 1; fi
}
netgen=${NETGEN_SRC:-$work/netgen}
zlib=${ZLIB_SRC:-$work/zlib}
checkout netgen "$netgen"
checkout zlib "$zlib"
netgen=$(cd "$netgen" && pwd)
zlib=$(cd "$zlib" && pwd)
cp "$here/fem_mesher.cpp" "$work/"
# shellcheck disable=SC2086
docker run --rm -v "$netgen:/in/netgen:ro" -v "$zlib:/in/zlib:ro" -v "$work:/work" -v "$out:/out" \
  ${DOCKER_ARGS:-} "$image" sh -ec '
  rm -rf /tmp/ng /tmp/zl && cp -r /in/netgen /tmp/ng && cp -r /in/zlib /tmp/zl
  mkdir -p /tmp/zb && cd /tmp/zb
  emcmake cmake /tmp/zl -DCMAKE_BUILD_TYPE=Release >/dev/null
  emmake make -j"$(nproc)" zlibstatic >/dev/null
  mkdir -p /tmp/zi && cp libz.a zconf.h /tmp/zl/zlib.h /tmp/zi/
  mkdir -p /tmp/nb && cd /tmp/nb
  emcmake cmake /tmp/ng -Wno-dev -DUSE_SUPERBUILD=OFF -DUSE_GUI=OFF -DUSE_PYTHON=OFF \
    -DUSE_OCC=OFF -DUSE_MPI=OFF -DUSE_JPEG=OFF -DUSE_MPEG=OFF -DUSE_CGNS=OFF \
    -DUSE_NATIVE_ARCH=OFF -DENABLE_UNIT_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
    -DZLIB_INCLUDE_DIR=/tmp/zi -DZLIB_LIBRARY=/tmp/zi/libz.a >/dev/null
  emmake make -j"$(nproc)" nglib >/dev/null
  cd /work
  em++ -O2 -fexceptions -std=c++17 -I/tmp/ng/libsrc/include -I/tmp/ng/libsrc \
    -I/tmp/ng/libsrc/core -I/tmp/nb -I/tmp/nb/core fem_mesher.cpp \
    /tmp/nb/libnglib.a /tmp/nb/libsrc/core/libngcore.a /tmp/zi/libz.a \
    -o /out/fem-mesher.mjs -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB \
    -sEXPORTED_FUNCTIONS=_fm_mesh,_fm_points,_fm_point_data,_fm_tets,_fm_tet_data,_fm_tris,_fm_tri_data,_fm_tri_face,_fm_error,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAP32,UTF8ToString'
cp "$here/NOTICE.txt" "$out/"
cd "$out" && sha256sum fem-mesher.mjs fem-mesher.wasm
