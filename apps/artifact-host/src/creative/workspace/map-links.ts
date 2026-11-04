import { clone, canonicalJson } from '@editor-platform/artifact-core';
import { validateFictionMap } from '@editor-platform/fiction-map/model';
import { renderFictionMapSvg } from '@editor-platform/fiction-map/render';
import type { FictionMapOutputView } from '@editor-platform/fiction-map/render';
import type { NativeReference } from './model';

/** Host references only. Geometry, LO text, selected artwork and story time keep their existing owners. */
export interface CreativeMapLocation {
  id: string;
  namespace: string;
  itemId: string;
  source: NativeReference & { contentHash: string };
  sceneId?: string;
  map: {
    artifactId: string;
    versionId: string;
    contentHash: string;
    view: FictionMapOutputView;
    featureIds: string[];
  };
}
export interface CreativeMapLinks {
  revision: number;
  locations: CreativeMapLocation[];
}
export class CreativeMapReferenceError extends Error {
  constructor(
    readonly state: 'missing' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v)) &&
  Reflect.ownKeys(v).every((k) => {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    return typeof k === 'string' && keys.includes(k) && d.enumerable && 'value' in d;
  });
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 512;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const denseArray = (v: unknown, max: number): v is unknown[] =>
  Array.isArray(v) &&
  v.length <= max &&
  Reflect.ownKeys(v).length === v.length + 1 &&
  Array.from({ length: v.length }, (_, i) => Object.getOwnPropertyDescriptor(v, String(i))).every(
    (d) => !!d && d.enumerable && 'value' in d,
  );
export function readCreativeMapLinks(raw: unknown): CreativeMapLinks {
  if (
    !object(raw, ['revision', 'locations']) ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !denseArray(raw.locations, 64)
  )
    throw Error('地図対応表は有効なrevisionと64件以内の参照が必要です。変更しません。');
  const ids = new Set<string>(),
    targets = new Set<string>();
  for (const r of raw.locations) {
    if (
      !object(r, ['id', 'namespace', 'itemId', 'source', 'sceneId', 'map']) ||
      !id(r.id) ||
      !id(r.namespace) ||
      !id(r.itemId) ||
      (r.sceneId !== undefined && !id(r.sceneId)) ||
      !object(r.source, ['artifactId', 'versionId', 'contentHash', 'elementId']) ||
      !id(r.source.artifactId) ||
      !id(r.source.versionId) ||
      !hash(r.source.contentHash) ||
      !id(r.source.elementId) ||
      !object(r.map, ['artifactId', 'versionId', 'contentHash', 'view', 'featureIds']) ||
      !id(r.map.artifactId) ||
      !id(r.map.versionId) ||
      !hash(r.map.contentHash) ||
      !denseArray(r.map.featureIds, 200) ||
      !r.map.featureIds.length ||
      !r.map.featureIds.every(id) ||
      new Set(r.map.featureIds).size !== r.map.featureIds.length
    )
      throw Error('地図・場所の固定参照が不正です。未知fieldやdomainの推測補正はしません。');
    const view = r.map.view;
    if (
      !(object(view, ['kind']) && view.kind === 'document') &&
      !(object(view, ['kind', 'id']) && view.kind === 'named' && id(view.id))
    )
      throw Error('未知の地図selectorです。documentか明示したnamed viewを選んでください。');
    const target = canonicalJson([r.namespace, r.itemId, r.sceneId ?? null]);
    if (ids.has(r.id) || targets.has(target))
      throw Error('同じ場所・Sceneの地図参照が重複しています。');
    ids.add(r.id);
    targets.add(target);
  }
  return clone(raw) as unknown as CreativeMapLinks;
}
/** Existing opaque refs are the only semantic identity. Never infer from names or coordinates. */
export function projectCreativeMapLocation(reference: CreativeMapLocation, input: unknown) {
  readCreativeMapLinks({ revision: 0, locations: [reference] });
  const result = validateFictionMap(input);
  if (!result.ok) throw Error('地図nativeが不正です。' + result.diagnostic.code);
  const content = result.value;
  const features = reference.map.featureIds.map((id) => {
    const f = content.features.find((f) => f.id === id);
    if (!f)
      throw new CreativeMapReferenceError(
        'missing',
        '地物が欠落しています。別の地物へ付け替えません。',
      );
    if (
      f.worldEntityRef?.namespace !== reference.namespace ||
      f.worldEntityRef.entityId !== reference.itemId
    )
      throw Error('地物の意味参照と場所が矛盾しています。参照なしは明示付与・保存が必要です。');
    return f;
  });
  const view = reference.map.view;
  const named =
    view.kind === 'named' ? content.namedViews.find((v) => v.id === view.id) : undefined;
  if (view.kind === 'named' && !named)
    throw new CreativeMapReferenceError('missing', '保存ビューが欠落しています。');
  const layers =
    named?.visibleLayerIds ?? content.layers.filter((l) => l.visibleByDefault).map((l) => l.id);
  if (features.some((f) => !layers.includes(f.layerId)))
    throw Error('選択地物は保存ビューの非表示レイヤーです。');
  const { svg } = renderFictionMapSvg(content, {
    width: 1000,
    height: 700,
    view,
    featureIds: reference.map.featureIds,
  });
  const overviewSvg = renderFictionMapSvg(content, { width: 1000, height: 700, view }).svg;
  return { svg, overviewSvg, features: features.map((f) => ({ id: f.id, name: f.name })) };
}
