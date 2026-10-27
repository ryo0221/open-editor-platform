#!/bin/sh
# Writes the notice and corresponding-source bundle for a kernel built by build.sh into
# <kernel-dir>: NOTICE.txt next to the Wasm, and source/ with the OCCT source archive, the
# OpenCascade.js generator and patches from the pinned image, this directory's build inputs and
# SHA256SUMS. Requires Docker. IMAGE_PREFIX selects a registry mirror as in build.sh.
set -eu
out=${1:?usage: bundle.sh <kernel-dir>}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
notices="$root/docs/third-party/cad-kernel"
image=$(sed -n "s/.*'\(donalffons\/opencascade.js@sha256:[0-9a-f]*\)'.*/\1/p" "$here/build.mjs")
# The current build's file name: the first entry (cadKernelPrevious lists the same names again).
wasm=$(sed -n "s/.*wasm: '\([^']*\)'.*/\1/p" "$here/build.mjs" | head -n 1)
test -f "$out/$wasm" || { echo "bundle.sh: $out/$wasm not found; run build.sh first" >&2; exit 1; }
out=$(cd "$out" && pwd)
rm -rf "$out/source"
mkdir -p "$out/source/editor-platform-cad-kernel"

# Upstream sources exactly as the pinned image holds them. occt.tar.gz is the unpatched OCCT
# archive; the generator's patches/ show what the image changed before compiling it.
# Every step must succeed: an incomplete source bundle must never get checksums. No pipeline,
# so a tar failure is not masked by gzip.
# shellcheck disable=SC2086
docker run --rm -v "$out/source:/out" ${DOCKER_ARGS:-} --entrypoint sh "${IMAGE_PREFIX:-}$image" -c '
  set -eu
  cp /occt/occt.tar.gz /out/occt-bb368e2.tar.gz
  tar -C / --sort=name --mtime=2023-03-23 --owner=0 --group=0 --numeric-owner \
    --exclude=__pycache__ -cf /tmp/opencascade.js-src.tar opencascade.js/src
  gzip -n -c /tmp/opencascade.js-src.tar > /out/opencascade.js-src.tar.gz
  test -n "$OCCT_COMMIT_HASH_FULL"
  cat /emsdk/upstream/emscripten/emscripten-version.txt > /out/emscripten-version.txt
  printf "%s\n" "$OCCT_COMMIT_HASH_FULL" > /out/occt-commit.txt'

for f in README.md build.mjs build.sh bundle.sh opencascade.d0-leakcheck.yml patch-destructors.py; do
  cp "$here/$f" "$out/source/editor-platform-cad-kernel/"
done
printf '%s\n' "$image" > "$out/source/image.txt"

{
  sed -n '/^<!-- notice -->$/,/^<!-- \/notice -->$/p' "$notices/README.md" | sed '1d;$d'
  for f in occt-LGPL-2.1.txt occt-LGPL-exception.txt emscripten-MIT-NCSA.txt musl-COPYRIGHT.txt \
    libcxx-Apache-2.0-LLVM.txt libcxxabi-Apache-2.0-LLVM.txt libunwind-Apache-2.0-LLVM.txt \
    compiler-rt-Apache-2.0-LLVM.txt freetype-FTL.txt rapidjson-MIT.txt; do
    printf '\n==============================================================================\n%s\n' "$f"
    printf '==============================================================================\n\n'
    cat "$notices/$f"
  done
} > "$out/NOTICE.txt"

(cd "$out" && find source NOTICE.txt -type f ! -name SHA256SUMS | LC_ALL=C sort | xargs sha256sum) \
  > "$out/source/SHA256SUMS"
cat "$out/source/SHA256SUMS"
