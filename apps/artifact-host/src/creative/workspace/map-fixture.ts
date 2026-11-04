import { clone, createArtifact, commitVersion, updateDraft } from '@editor-platform/artifact-core';
import {
  createFictionMap,
  validateFictionMap,
  type FictionMapContent,
} from '@editor-platform/fiction-map/model';
import type { CreativeWorkspace } from './model';

/** Opt-in harbor demo only; opening an existing workspace never provisions or migrates it. */
export async function createHarborMapFixture(workspace: CreativeWorkspace) {
  if (workspace.mapping.world?.namespace !== 'harbor')
    throw Error('港町の制作例だけで使うfixtureです。');
  if (!workspace.canPrepareWorldInput) throw Error('地図例の作成には編集権限が必要です。');
  const id = 'cw3:harbor:map';
  let map = await workspace.io.artifacts.get(id);
  if (!workspace.canReadWorld(id)) throw Error('地図例の閲覧権限がありません。');
  if (!map) {
    const base = createFictionMap();
    const content: FictionMapContent = {
      ...base,
      coordinateSpace: {
        ...base.coordinateSpace,
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 80 },
      },
      layers: [{ id: 'places', name: '港町の場所', purpose: 'settlement', visibleByDefault: true }],
      namedViews: [
        {
          id: 'port',
          name: '港の周辺',
          extent: { minX: 0, minY: 0, maxX: 100, maxY: 80 },
          visibleLayerIds: ['places'],
        },
      ],
      features: [
        {
          id: 'unassigned',
          layerId: 'places',
          name: '倉庫（参照なし）',
          featureKind: 'place',
          geometry: { type: 'point', coordinates: [60, 35] },
        },
        {
          id: 'town',
          layerId: 'places',
          name: '潮見の街',
          featureKind: 'place',
          geometry: { type: 'point', coordinates: [30, 35] },
          worldEntityRef: { namespace: 'harbor', entityId: 'LO-02' },
        },
        {
          id: 'port-area',
          layerId: 'places',
          name: '潮見の港域',
          featureKind: 'region',
          geometry: {
            type: 'polygon',
            outer: [
              [10, 10],
              [60, 10],
              [60, 55],
              [10, 55],
              [10, 10],
            ],
          },
          worldEntityRef: { namespace: 'harbor', entityId: 'LO-02' },
        },
        {
          id: 'house',
          layerId: 'places',
          name: '風見の家',
          featureKind: 'place',
          geometry: { type: 'point', coordinates: [75, 60] },
          worldEntityRef: { namespace: 'harbor', entityId: 'LO-01' },
        },
        {
          id: 'bridge',
          layerId: 'places',
          name: '港へ渡る橋',
          featureKind: 'path',
          geometry: {
            type: 'polyline',
            coordinates: [
              [45, 25],
              [65, 25],
            ],
          },
        },
      ],
    };
    const valid = validateFictionMap(content);
    if (!valid.ok) throw Error(valid.diagnostic.code);
    const before = await commitVersion(
      { ...createArtifact('fiction-map', '港町の固定地図', valid.value), id },
      null,
      '橋がある地図',
    );
    const after = await commitVersion(
      updateDraft(before, {
        ...valid.value,
        features: valid.value.features.filter((f) => f.id !== 'bridge'),
      }),
      null,
      '橋がない地図',
    );
    if (!workspace.canPrepareWorldInput || !workspace.canReadWorld(id))
      throw Error('地図例の作成権限が変わりました。');
    map = workspace.io.artifacts.putIfAbsent
      ? await workspace.io.artifacts.putIfAbsent(after)
      : (await workspace.io.artifacts.put(after), after);
  }
  await workspace.maps.readMapVersion(id, map.versions[0].versionId);
  for (const { itemId, sceneId, version, featureIds } of [
    { itemId: 'LO-01', sceneId: undefined, version: map.versions[0], featureIds: ['house'] },
    {
      itemId: 'LO-02',
      sceneId: undefined,
      version: map.versions[0],
      featureIds: ['town', 'port-area'],
    },
    {
      itemId: 'LO-02',
      sceneId: 'SC-01',
      version: map.versions[0],
      featureIds: ['town', 'port-area'],
    },
    {
      itemId: 'LO-02',
      sceneId: 'SC-02',
      version: map.versions[1],
      featureIds: ['town', 'port-area'],
    },
  ]) {
    const key = 'harbor-map:' + (sceneId ?? 'work') + ':' + itemId;
    if (workspace.maps.mapping.locations.some((r) => r.id === key)) continue;
    const location = await workspace.maps.location(itemId, sceneId);
    await workspace.maps.save(
      {
        id: key,
        ...location,
        map: {
          artifactId: id,
          versionId: version.versionId,
          contentHash: version.contentHash,
          view: { kind: 'named', id: 'port' },
          featureIds: clone(featureIds),
        },
      },
      workspace.maps.mapping.revision,
    );
  }
  return map.id;
}
