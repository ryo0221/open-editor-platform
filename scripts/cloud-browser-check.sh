#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/workspace/.tools/node-v24.19.0-linux-x64/bin:$PATH
export npm_config_cache=/workspace/.npm-cache
export npm_config_update_notifier=false
export PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright
export LD_LIBRARY_PATH=/workspace/.tools/browser-deps/root/usr/lib/x86_64-linux-gnu
export XDG_CACHE_HOME=/workspace/.cache
export XDG_CONFIG_HOME=/workspace/.config
export XDG_DATA_HOME=/workspace/.local/share
# The outer cloud sandbox disallows Firefox's nested user-namespace uid_map write.
# This is test-runner process configuration; iframe/CSP/content isolation stays enabled.
export MOZ_DISABLE_CONTENT_SANDBOX=1
export EDITOR_WEBKIT_EXECUTABLE=/workspace/.tools/webkit-launch
export E2E_SUITE=cross
exec npx playwright test "$@"
