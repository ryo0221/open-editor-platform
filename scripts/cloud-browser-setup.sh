#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/workspace/.tools/node-v20.20.2-linux-x64/bin:$PATH
export npm_config_cache=/workspace/.npm-cache
export npm_config_update_notifier=false
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright
test "$(dpkg --print-architecture)" = amd64
npx playwright install firefox webkit

# Download signed distribution packages and extract locally; no system installation or root needed.
deps_root=/workspace/.tools/browser-deps
mkdir -p "$deps_root/lists/partial" "$deps_root/archives/partial"
apt_options=(-o "Dir::State::lists=$deps_root/lists" -o "Dir::Cache::archives=$deps_root/archives" -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= -o "Dir::Log=$deps_root")
/usr/bin/apt-get "${apt_options[@]}" update
# There is no dpkg write during download-only, so no system dpkg lock is required.
/usr/bin/apt-get "${apt_options[@]}" -o Debug::NoLocking=1 --download-only --assume-yes install libgtk-4-1 libgraphene-1.0-0 libharfbuzz-icu0 libmanette-0.2-0 libhyphen0 libgles2
for archive in "$deps_root"/archives/*.deb; do dpkg-deb -x "$archive" "$deps_root/root"; done

# The bundled WebKit wrapper overwrites LD_LIBRARY_PATH. This equivalent launcher adds local libs.
cat > /workspace/.tools/webkit-launch <<'LAUNCHER'
#!/bin/sh
webkit_root=/workspace/.cache/ms-playwright/webkit-2359/minibrowser-wpe
export WEBKIT_EXEC_PATH="$webkit_root/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$webkit_root/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="$webkit_root/share"
export LD_LIBRARY_PATH="$webkit_root/lib:$webkit_root/sys/lib:/workspace/.tools/browser-deps/root/usr/lib/x86_64-linux-gnu"
exec "$webkit_root/bin/MiniBrowser" "$@"
LAUNCHER
chmod +x /workspace/.tools/webkit-launch
test -x /workspace/.cache/ms-playwright/webkit-2359/minibrowser-wpe/bin/MiniBrowser
mkdir -p /workspace/.config /workspace/.cache /workspace/.local/share
