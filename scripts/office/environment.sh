#!/usr/bin/env bash
# Source this file from the repository or call setup-renderer.sh first.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
node "$repo_root/scripts/check-office-fonts.mjs" || return 1
office_deps=${EDITOR_OFFICE_DEPS:-/workspace/.tools/office-deps}
export EDITOR_SOFFICE="$office_deps/root/usr/lib/libreoffice/program/soffice"
export LD_LIBRARY_PATH="$office_deps/root/usr/lib/libreoffice/program:$office_deps/root/usr/lib/x86_64-linux-gnu"
export URE_BOOTSTRAP="vnd.sun.star.pathname:$office_deps/root/usr/lib/libreoffice/program/fundamentalrc"
export PYTHONPATH="$office_deps/root/usr/lib/python3/dist-packages:$office_deps/root/usr/lib/libreoffice/program"
office_font_cache=${EDITOR_OFFICE_FONT_CACHE:-/tmp/editor-office-font-cache}
mkdir -p "$office_font_cache"
export XDG_CACHE_HOME="$office_font_cache/runtime"
mkdir -p "$XDG_CACHE_HOME"
export FONTCONFIG_FILE="$office_font_cache/fonts.conf"
python3 - "$repo_root/apps/playground/public/office-fonts" "$office_font_cache" <<'PY'
from pathlib import Path
from xml.sax.saxutils import escape
import sys
fonts,cache=map(Path,sys.argv[1:])
(cache/'fonts.conf').write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>'+escape(str(fonts))+'</dir><cachedir>'+escape(str(cache))+'</cachedir></fontconfig>')
PY
test -x "$EDITOR_SOFFICE"
