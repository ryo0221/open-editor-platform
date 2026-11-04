#!/bin/sh
# Prepares the release of a kernel built by build.sh and bundled by bundle.sh (README.md,
# "Released builds"): the loader, Wasm, types, NOTICE.txt, the corresponding source as one tar and
# SHA256SUMS, in <kernel-dir>/release/. With --publish it also creates the GitHub release named by
# build.mjs (gh CLI with write access to that repository). Publishing makes the kernel public.
set -eu
dir=${1:?usage: release.sh <kernel-dir> [--publish]}
publish=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
dir=$(cd "$dir" && pwd)
# The current build's names, hashes and release coordinates, from build.mjs and fetch.mjs.
eval "$(node --input-type=module -e "
  const { cadKernelBuild: b, cadKernelRelease: r } = await import('$here/build.mjs');
  const { cadKernelReleaseTag: tag, cadKernelReleaseFiles: files } = await import('$here/fetch.mjs');
  const f = files(b);
  const q = (s) => \"'\" + s + \"'\";
  console.log([
    'js=' + q(f.js), 'wasm=' + q(f.wasm), 'types=' + q(f.types), 'tar=' + q(f.source),
    'wasm_sha=' + q(b.wasmSha256), 'js_sha=' + q(b.jsSha256 ?? ''),
    'repo=' + q(r.repository), 'tag=' + q(tag(b)),
  ].join('\n'));
")"
check() {
  actual=$(sha256sum "$dir/$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || { echo "release.sh: $1 is $actual, build.mjs expects $2" >&2; exit 1; }
}
check "$wasm" "$wasm_sha"
[ -n "$js_sha" ] || { echo "release.sh: build.mjs has no jsSha256" >&2; exit 1; }
check "$js" "$js_sha"
for f in "$types" NOTICE.txt source/SHA256SUMS; do
  test -f "$dir/$f" || { echo "release.sh: $dir/$f missing; run bundle.sh first" >&2; exit 1; }
done
(cd "$dir" && sha256sum --quiet -c source/SHA256SUMS)

out="$dir/release"
rm -rf "$out"
mkdir -p "$out"
cp "$dir/$js" "$dir/$wasm" "$dir/$types" "$dir/NOTICE.txt" "$out/"
tar -C "$dir" --sort=name --mtime=2023-03-23 --owner=0 --group=0 --numeric-owner \
  -cf "$out/$tar" source
(cd "$out" && sha256sum "$js" "$wasm" "$types" NOTICE.txt "$tar" > SHA256SUMS)
cat "$out/SHA256SUMS"

[ "$publish" = "--publish" ] || { echo "Prepared $out; rerun with --publish to create $repo $tag"; exit 0; }
notes="EditorPlatform 3D CAD kernel, a custom OpenCascade.js build (Wasm SHA-256 $wasm_sha).

Open CASCADE Technology and the OpenCascade.js bindings are licensed under LGPL-2.1 (OCCT with the Open CASCADE exception 1.0); NOTICE.txt lists every component and carries the license texts. $tar is the corresponding source: the unmodified OCCT archive, the OpenCascade.js generator and patches, the build inputs and the pinned build image. Rebuild with source/editor-platform-cad-kernel/build.sh.

Download and verify with scripts/cad-kernel/fetch.mjs."
gh release create "$tag" --repo "$repo" --title "CAD kernel ${wasm_sha%"${wasm_sha#????????????}"}" \
  --notes "$notes" "$out/$js" "$out/$wasm" "$out/$types" "$out/NOTICE.txt" "$out/$tar" "$out/SHA256SUMS"
