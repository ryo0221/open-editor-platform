# Bundled geographic boundary display data

Only the data files under `packages/geo-core/data/` have the data terms below.
No new license is granted over private platform source. Existing dependency,
source and public snapshot license policies remain separate.

## Natural Earth

`world-countries.json` and `world-regions.*.json` derive from Natural Earth **5.1.2**:

- [110m admin-0 countries](https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_110m_admin_0_countries.geojson)
- [10m admin-1 states/provinces](https://github.com/nvkelso/natural-earth-vector/blob/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson)
- [Terms of use: public domain](https://www.naturalearthdata.com/about/terms-of-use/)

Natural Earth data is public domain. Attribution is retained voluntarily in the UI,
images and receipts. Geometry was simplified, rounded and delta encoded for display.
These data are generalized explanatory boundaries, not a legal border determination.

## Japan municipalities / wards

`japan-municipalities.json` derives from **geoBoundaries gbOpen JPN ADM2**,
`JPN-ADM2-22064153`, year represented **2017**, release commit **9469f09**.

- [Pinned simplified upstream GeoJSON](https://github.com/wmgeolab/geoBoundaries/blob/9469f09/releaseData/gbOpen/JPN/ADM2/geoBoundaries-JPN-ADM2_simplified.geojson)
- [Dataset metadata](https://www.geoboundaries.org/api/current/gbOpen/JPN/ADM2/)
- Source credited by dataset: **OpenStreetMap, Wambacher**.
- License declared by this specific dataset: **Creative Commons Attribution-ShareAlike 2.0**.
- [License / deed](https://creativecommons.org/licenses/by-sa/2.0/),
  [legal code](https://creativecommons.org/licenses/by-sa/2.0/legalcode.en),
  [OpenStreetMap copyright information](https://www.openstreetmap.org/copyright).

This derived Japanese dataset is made available under **CC BY-SA 2.0**, with the
original source attribution retained. Changes: additional ring simplification at
0.004 degrees, coordinate rounding to six decimals, property removal and lossless
delta encoding of the resulting coordinates. It is not a current administrative
register or surveyed boundary and is not endorsed by the original authors.

The generic geoBoundaries CC BY 4.0 label is **not** substituted for this dataset's
specific CC BY-SA 2.0 metadata. Its derived data remain separately identifiable and
retain their attribution and license link in rendered maps and output receipts.

`data/manifest.json` records original and derived SHA-256 pins. The committed
`scripts/geo-backgrounds/generate.py` reproduces the transformation from those
exact upstream bytes without additional Python packages. Upstream files remain
outside the source tree. No source data is fetched by the editor runtime.
