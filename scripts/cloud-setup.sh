#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# This cloud workflow uses the existing checkout and the image's Chromium.
# Never create a worktree or rewrite repository content during setup.
node_root=/workspace/.tools/node-v24.19.0-linux-x64
if [ ! -x "$node_root/bin/node" ]; then
  test "$(uname -sm)" = 'Linux x86_64'
  mkdir -p /workspace/.tools
  archive_path=$(mktemp /tmp/editor-node.XXXXXX.tar.xz)
  trap 'rm -f "$archive_path"' EXIT
  curl --fail --silent --show-error --location --retry 2 https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -o "$archive_path"
  printf '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  %s\n' "$archive_path" | sha256sum --check -
  tar -xJf "$archive_path" -C /workspace/.tools
fi
export PATH="$node_root/bin:$PATH"
export npm_config_cache=/workspace/.npm-cache
export npm_config_update_notifier=false
test "$(node --version)" = v24.19.0
test -x /usr/bin/chromium
npm ci
npm run fonts:fetch
npm run typecheck
