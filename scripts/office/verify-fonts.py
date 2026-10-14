"""Fail on missing/changed font binaries or manifest glyph coverage, before Office rendering."""
import hashlib, json
from pathlib import Path
from fontTools.ttLib import TTFont

root = Path('apps/playground/public/office-fonts')
result = []
for name in ['manifest.json', 'mono-manifest.json']:
    manifest = json.loads((root/name).read_text())
    common = None
    for face in manifest['faces']:
        file = root/face['file']
        if not file.is_file():
            raise SystemExit(f'Missing fixed Office font: {file}. Run npm run fonts:fetch before Office verification/export.')
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if digest != face['sha256']:
            raise SystemExit(f'Font hash mismatch: {file}. Remove the invalid generated file and run npm run fonts:fetch; do not change the expected hash.')
        font = TTFont(file)
        names = font['name']
        family = names.getDebugName(16) or names.getDebugName(1)
        version = names.getDebugName(5)
        assert family == manifest['family']
        assert manifest['version'] in version
        assert font['OS/2'].usWeightClass == (700 if face['weight'] == 'bold' else 400)
        cmap = font.getBestCmap(); glyphs = set(cmap)
        assert all(ord(c) in glyphs for c in '日本語の資料：受付改善、費用と効果。ABC xyz 0123456789')
        if name.startswith('mono'):
            advances = {font['hmtx'][cmap[ord(c)]][0] for c in 'Wi.012ab '}
            assert len(advances) == 1, 'Code font must have equal Latin advances'
        common = glyphs if common is None else common & glyphs
        result.append(dict(file=str(file),sha256=digest,family=family,version=version,glyphs=len(glyphs)))
    declared = {n for start,end in manifest['glyphRanges'] for n in range(start,end+1)}
    assert declared == common, 'Manifest glyph coverage differs from the fixed font binaries'
print(json.dumps(dict(result='passed',faces=result), ensure_ascii=False, indent=2))
