"""Reproduce the checked-in Japanese monospace faces from verified Noto CJK TTCs.

Run with FontTools 4.61.1, passing the directory containing the two original TTCs.
The source and resulting hashes must match the manifests; this never updates pins.
"""
import hashlib, json, sys
from pathlib import Path
import fontTools
from fontTools.ttLib import TTFont

assert fontTools.__version__ == '4.61.1'
root = Path('apps/playground/public/office-fonts')
source = Path(sys.argv[1])
manifest = json.loads((root/'mono-manifest.json').read_text())
for face in manifest['faces']:
    file = source/('NotoSansCJK-' + face['weight'].title() + '.ttc')
    assert hashlib.sha256(file.read_bytes()).hexdigest() == face['sourceSha256']
    font = TTFont(file, fontNumber=face['sourceFaceIndex'], recalcTimestamp=False)
    # Materialize cmap as during manifest generation (FontTools normalizes its encoding).
    assert all(ord(c) in font.getBestCmap() for c in '日本語 ABC 012')
    output = root/face['file']
    # Verify bytes in memory before replacing a retained binary.
    from io import BytesIO
    buffer = BytesIO(); font.save(buffer)
    assert hashlib.sha256(buffer.getvalue()).hexdigest() == face['sha256']
    output.write_bytes(buffer.getvalue())
    print(output)
