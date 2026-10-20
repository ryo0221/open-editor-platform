"""Reproduce the offline boundary display data, with pinned upstream SHA-256.
No external packages; inputs stay outside Git. Output is deliberately delta encoded.
Simplification is for explanatory display, not a topology/administrative authority claim.
"""
import argparse
import hashlib
import json
import math
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = [
    ('world-countries', '5.1.2-display.1', 'World countries', 'Natural Earth 5.1.2 · public domain',
     'https://www.naturalearthdata.com/about/terms-of-use/',
     'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson',
     '6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f', 0.04),
    ('world-regions', '5.1.2-display.1', 'World states and provinces', 'Natural Earth 5.1.2 · public domain',
     'https://www.naturalearthdata.com/about/terms-of-use/',
     'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson',
     '22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5', 0.04),
    ('japan-municipalities', '2017-9469f09-display.1', 'Japan municipalities and wards',
     'geoBoundaries JPN ADM2 (2017) · OpenStreetMap / Wambacher · CC BY-SA 2.0 · simplified',
     'https://creativecommons.org/licenses/by-sa/2.0/',
     'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/JPN/ADM2/geoBoundaries-JPN-ADM2_simplified.geojson',
     'c1c3f4d70bf7d02ef3fd2f98410597ac714c521280520fc7e85073fdee75af46', 0.004),
]

def distance(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    t = max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy))) if dx or dy else 0
    return (p[0]-a[0]-t*dx)**2 + (p[1]-a[1]-t*dy)**2

def simplify(points, tolerance):
    keep = {0, len(points)-1}
    stack = [(0, len(points)-1)]
    while stack:
        first, last = stack.pop()
        if last-first < 2:
            continue
        index = max(range(first+1, last), key=lambda i: distance(points[i], points[first], points[last]))
        if distance(points[index], points[first], points[last]) > tolerance*tolerance:
            keep.add(index)
            stack.extend([(first, index), (index, last)])
    return [points[i] for i in sorted(keep)]

def ring(points, tolerance):
    original = [(round(x*1000000), round(y*1000000)) for x, y, *_ in points]
    original = list(dict.fromkeys(original))
    if len(original) < 3:
        raise ValueError('Degenerate upstream ring')
    # Two arcs avoid the identical endpoints of a closed-ring RDP call.
    split = max(range(1, len(original)), key=lambda i: math.dist(original[0], original[i]))
    simple = simplify(original[:split+1], tolerance*1000000)[:-1] + simplify(original[split:]+[original[0]], tolerance*1000000)[:-1]
    if len(simple) < 3:
        # Keep a non-collinear triangle for very small islands/holes.
        a, b = original[0], original[split]
        c = max(original, key=lambda p: distance(p, a, b))
        selected = {a, b, c}
        simple = [p for p in original if p in selected]
    if len(simple) < 3:
        raise ValueError('Degenerate simplified ring')
    simple.append(simple[0])
    last = (0, 0)
    encoded = []
    for p in simple:
        encoded.extend([p[0]-last[0], p[1]-last[1]])
        last = p
    return encoded

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=pathlib.Path, default=pathlib.Path('/tmp/editor-geo-boundaries'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, version, label, attribution, license_url, url, expected, tolerance in SOURCES:
        source = args.cache / (name+'.json')
        if not source.exists():
            source.write_bytes(urllib.request.urlopen(url, timeout=60).read())
        raw = source.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('Upstream hash mismatch: '+name)
        features = []
        vertices = 0
        for feature in json.loads(raw)['features']:
            g = feature['geometry']
            polygons = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            if g['type'] not in ['Polygon', 'MultiPolygon']:
                raise ValueError('Unexpected upstream geometry')
            encoded = [[ring(r, tolerance) for r in p] for p in polygons]
            vertices += sum(len(r)//2 for p in encoded for r in p)
            features.append(encoded)
        data = {'schemaVersion': 1, 'id': name, 'version': version, 'scale': 1000000, 'features': features}
        text = json.dumps(data, ensure_ascii=False, separators=(',', ':'), sort_keys=True)+'\n'
        out = ROOT / 'packages/geo-core/data' / (name+'.json')
        outputs = [(out, text)]
        if len(text.encode()) > 900000:
            outputs = [(out.with_name(name+'.'+str(i//500)+'.json'), json.dumps(features[i:i+500], separators=(',', ':'))+'\n') for i in range(0, len(features), 500)]
        for target, generated in outputs:
            if args.check:
                if not target.exists() or target.read_text() != generated:
                    raise ValueError('Generated data differs: '+str(target))
            else:
                target.write_text(generated)
        info = {'id': name, 'version': version, 'label': label, 'attribution': attribution, 'licenseUrl': license_url,
                'sourceUrl': url, 'sourceSha256': expected, 'toleranceDegrees': tolerance,
                'features': len(features), 'vertices': vertices, 'hash': 'sha256:'+hashlib.sha256(text.rstrip('\n').encode()).hexdigest()}
        manifest.append(info)
        print(name, len(text.encode()), len(features), vertices)
    text = json.dumps(manifest, ensure_ascii=False, indent=2)+'\n'
    out = ROOT / 'packages/geo-core/data/manifest.json'
    if args.check:
        if out.read_text() != text:
            raise ValueError('Generated manifest differs')
    else:
        out.write_text(text)

if __name__ == '__main__':
    main()
