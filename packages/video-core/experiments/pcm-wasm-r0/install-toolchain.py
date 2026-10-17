"""Explicit manual setup from pinned official release archives; never run by builds/CI.
Usage: python3 install-toolchain.py /tmp/fresh-prefix /tmp/download-cache [--offline]
No rustup, curl-to-shell, mirrors, dependency resolution or floating toolchain.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

root = pathlib.Path(__file__).resolve().parent
prefix, cache = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:3])
offline = sys.argv[3:] == ['--offline']
if sys.argv[3:] not in ([], ['--offline']):
    raise SystemExit('Unsupported arguments')
repo = root.parents[3]
if prefix == repo or repo in prefix.parents or prefix.exists():
    raise SystemExit('Use a fresh external toolchain prefix')
cache.mkdir(parents=True, exist_ok=True)
pins = json.loads((root / 'toolchain-inputs.json').read_text())
base = 'https://static.rust-lang.org/dist/'

def fetch(url, expected):
    if not url.startswith(base):
        raise SystemExit('Only the official pinned Rust distribution is allowed')
    dest = cache / url.rsplit('/', 1)[1]
    if not dest.exists():
        if offline:
            raise SystemExit('Missing cached official component: ' + dest.name)
        with urllib.request.urlopen(url, timeout=60) as response:
            # Stream to a file. A failed/partial file is retained and fails checksum on retry.
            with dest.open('xb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
    with dest.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise SystemExit('Checksum mismatch: ' + str(dest))
    return dest

fetch(base + 'channel-rust-1.90.0.toml', pins['manifest_sha256'])
for item in pins['components']:
    archive = fetch(item['url'], item['sha256'])
    extracted = cache / archive.name.removesuffix('.tar.xz')
    if not extracted.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(cache, filter='data')
    # Always install from a newly extracted verified archive, not arbitrary existing extracted files.
    else:
        raise SystemExit('Extraction path already exists; use a fresh cache with verified archives only')
    subprocess.run(['sh', str(extracted / 'install.sh'), '--prefix=' + str(prefix), '--disable-ldconfig'], check=True)

inventory = {}
for file in sorted(prefix.rglob('*')):
    if file.is_file():
        with file.open('rb') as stream:
            inventory[str(file.relative_to(prefix))] = hashlib.file_digest(stream, 'sha256').hexdigest()
(prefix / 'r0-install-proof.json').write_text(json.dumps({'pins': pins, 'installedSha256': inventory}, indent=2) + '\n')
