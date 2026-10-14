#!/usr/bin/env bash
# Debian 13 amd64: signed, pinned packages extracted into a private directory (no dpkg install).
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
office_deps=${EDITOR_OFFICE_DEPS:-/workspace/.tools/office-deps}
test "$(dpkg --print-architecture)" = amd64
mkdir -p "$office_deps/lists/partial" "$office_deps/archives/partial" "$office_deps/root"
cp "$repo_root/scripts/office/snapshot.list" "$office_deps/sources.list"
apt_options=(-o "Dir::State::lists=$office_deps/lists" -o "Dir::Cache::archives=$office_deps/archives" -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= -o "Dir::Log=$office_deps" -o "Dir::Etc::sourcelist=$office_deps/sources.list" -o Dir::Etc::sourceparts=-)
/usr/bin/apt-get "${apt_options[@]}" update
mapfile -t office_packages < "$repo_root/scripts/office/apt-packages.txt"
/usr/bin/apt-get "${apt_options[@]}" -o Debug::NoLocking=1 --download-only --reinstall --assume-yes --no-install-recommends install "${office_packages[@]}"
python3 - "$office_deps/archives" "$repo_root/scripts/office/apt-archives.json" <<'PY'
from pathlib import Path
import sys,json,hashlib
archives=Path(sys.argv[1])
for record in json.loads(Path(sys.argv[2]).read_text()):
    file=archives/record['file']
    assert file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest()==record['sha256'], f'Pinned package mismatch: {file}'
PY
for archive in "$office_deps"/archives/*.deb; do dpkg-deb -x "$archive" "$office_deps/root"; done
python3 - "$office_deps/root" <<'PY'
from pathlib import Path
import os,sys
root=Path(sys.argv[1]).resolve()
for path in root.rglob('*'):
    if path.is_symlink():
        target=os.readlink(path)
        if target.startswith('/') and (root/target.lstrip('/')).exists():
            path.unlink();path.symlink_to(root/target.lstrip('/'))
program=root/'usr/lib/libreoffice/program'
# Debian's postinst normally creates the main registry conffile. Download-only extraction
# retains the shipped source in .registry; link it explicitly without running maintainer scripts.
main=program.parent/'share/registry/main.xcd'
if not main.exists():
    main.unlink(missing_ok=True)
    main.symlink_to('../.registry/main.xcd')
rc=program/'fundamentalrc'
lines=rc.read_text().splitlines()
rc.write_text('\n'.join('BRAND_BASE_DIR='+program.parent.as_uri() if line.startswith('BRAND_BASE_DIR=') else line for line in lines)+'\n')
uno=root/'usr/lib/python3/dist-packages/uno.py'
source=uno.read_text().replace('/usr/lib/libreoffice/program',str(program))
uno.write_text('import os, sys\nsys.path.append('+repr(str(program))+')\nos.putenv("URE_BOOTSTRAP", '+repr('vnd.sun.star.pathname:'+str(program/'fundamentalrc'))+')\n'+source)
PY
export EDITOR_OFFICE_DEPS="$office_deps"
source "$repo_root/scripts/office/environment.sh"
"$EDITOR_SOFFICE" --version
