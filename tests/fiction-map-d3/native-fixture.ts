import {
  createFictionMap,
  validateFictionMap,
  type FictionMapFeature,
} from '@editor-platform/fiction-map/model';
export function mapFixture(axis: 'up' | 'down' = 'down') {
  const features: FictionMapFeature[] = [];
  for (let i = 0; i < 10; i++)
    features.push({
      id: `place-${i}`,
      layerId: 'places',
      featureKind: 'place',
      name: `Place ${i}`,
      geometry: { type: 'point', coordinates: [50 + i * 40, 70] },
      ...(i === 0 ? { worldEntityRef: { namespace: 'world', entityId: 'city-0' } } : {}),
    });
  for (let i = 0; i < 4; i++) {
    const x = 30 + i * 110;
    features.push({
      id: `region-${i}`,
      layerId: 'terrain',
      featureKind: 'region',
      name: `Region ${i}`,
      style: { color: '#228855' },
      geometry: {
        type: 'polygon',
        outer: [
          [x, 150],
          [x + 70, 150],
          [x + 70, 220],
          [x, 220],
          [x, 150],
        ],
      },
    });
  }
  for (let i = 0; i < 5; i++)
    features.push({
      id: `path-${i}`,
      layerId: 'places',
      featureKind: 'path',
      name: `Path ${i}`,
      geometry: {
        type: 'polyline',
        coordinates: [
          [30 + i * 80, 260],
          [65 + i * 80, 300],
          [90 + i * 80, 270],
        ],
      },
    });
  const result = validateFictionMap({
    ...createFictionMap(),
    coordinateSpace: {
      kind: 'local-plane',
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 350 },
      unit: { name: 'map-unit' },
      yAxis: axis,
    },
    layers: [
      { id: 'terrain', name: 'Terrain', purpose: 'terrain', visibleByDefault: true },
      { id: 'places', name: 'Places', purpose: 'settlement', visibleByDefault: true },
    ],
    features,
    namedViews: [
      {
        id: 'default',
        name: 'Northern view',
        extent: { minX: 0, minY: 0, maxX: 250, maxY: 175 },
        visibleLayerIds: ['terrain', 'places'],
      },
    ],
  });
  if (!result.ok) throw Error(JSON.stringify(result.diagnostic));
  return result.value;
}
