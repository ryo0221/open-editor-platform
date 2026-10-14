#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=/workspace/.tools/node-v20.20.2-linux-x64/bin:$PATH
export npm_config_cache=/workspace/.npm-cache
export npm_config_update_notifier=false
exec npm run dev
