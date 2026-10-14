"""Reproduce all four pinned faces from the official Release, without pip/system changes."""
import hashlib
import io
import json
from pathlib import Path
import sys
from zipfile import ZipFile

if len(sys.argv) != 5:
    raise SystemExit('Usage: extract-office-fonts.py ARCHIVE WHEEL MANIFEST_DIRECTORY OUTPUT_DIRECTORY')
archive, wheel, manifests, output = map(Path, sys.argv[1:])
pins = json.loads(Path(__file__).with_name('fonts-source.json').read_text())
for path, pin in [(archive, pins['archive']), (wheel, pins['fonttools'])]:
    raw = path.read_bytes()
    if len(raw) != pin['bytes'] or hashlib.sha256(raw).hexdigest() != pin['sha256']:
        raise SystemExit(f'Pinned download SHA-256/size mismatch: {path}')
sys.path.insert(0, str(wheel.resolve()))
import fontTools  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402

if fontTools.__version__ != pins['fonttools']['version']:
    raise SystemExit('Unexpected FontTools version')
output.mkdir(parents=True, exist_ok=True)
with ZipFile(archive) as collection:
    for name, index in [('manifest.json', 0), ('mono-manifest.json', 5)]:
        manifest = json.loads((manifests / name).read_text())
        for face in manifest['faces']:
            if Path(face['file']).name != face['file']:
                raise SystemExit('Invalid font filename')
            raw = collection.read('NotoSansCJK-' + face['weight'].title() + '.ttc')
            if hashlib.sha256(raw).hexdigest() != face['sourceSha256']:
                raise SystemExit('Official TTC differs from the retained source hash')
            font = TTFont(io.BytesIO(raw), fontNumber=index, recalcTimestamp=False)
            # Only the original mono extraction materialized/normalized cmap before save.
            if index == 5:
                font.getBestCmap()
            buffer = io.BytesIO()
            font.save(buffer)
            result = buffer.getvalue()
            if hashlib.sha256(result).hexdigest() != face['sha256']:
                raise SystemExit(f'Extracted font differs from the retained hash: {face["file"]}')
            (output / face['file']).write_bytes(result)
            print('Verified extraction:', face['file'], flush=True)
