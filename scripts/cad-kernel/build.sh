#!/bin/sh
# Builds the development CAD kernel into <out> with the pinned image (README.md). Requires Docker.
# Extra docker args (e.g. a proxy CA) go in DOCKER_ARGS; IMAGE_PREFIX selects a registry mirror
# (e.g. mirror.gcr.io/). The digest pins the image either way. FREETYPE_SRC points at a checkout of
# emscripten-ports/FreeType tag version_1 for hosts that cannot download the port archive.
set -eu
out=${1:?usage: build.sh <out-dir>}
here=$(cd "$(dirname "$0")" && pwd)
image=$(sed -n "s/.*'\(donalffons\/opencascade.js@sha256:[0-9a-f]*\)'.*/\1/p" "$here/build.mjs")
image="${IMAGE_PREFIX:-}$image"
mkdir -p "$out"
out=$(cd "$out" && pwd)
cp "$here/opencascade.d0-leakcheck.yml" "$here/patch-destructors.py" "$out/"
freetype=
if [ -n "${FREETYPE_SRC:-}" ]; then
  freetype="-v $(cd "$FREETYPE_SRC" && pwd):/freetype-port:ro"
fi
# Emscripten skips the download when the unpacked port carries the URL marker it would write.
# shellcheck disable=SC2086
docker run --rm -v "$out:/src" $freetype ${DOCKER_ARGS:-} --entrypoint sh "$image" -c \
  'if [ -d /freetype-port ]; then
     ports=/emsdk/upstream/emscripten/cache/ports/freetype &&
     mkdir -p $ports && cp -r /freetype-port $ports/FreeType-version_1 &&
     rm -rf $ports/FreeType-version_1/.git &&
     echo https://github.com/emscripten-ports/FreeType/archive/version_1.zip > $ports/.emscripten_url
   fi &&
   python3 /src/patch-destructors.py /src/opencascade.d0-leakcheck.yml &&
   python3 /opencascade.js/src/buildFromYaml.py opencascade.d0-leakcheck.yml'
sha256sum "$out/opencascade.d0-leakcheck.wasm"
