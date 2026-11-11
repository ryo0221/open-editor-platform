import { clone } from '@editor-platform/artifact-core';
import type { ElementAddress } from '@editor-platform/editor-core';
import { readWorldContexts, type WorldContexts } from './world-links';
import {
  readStoryBinding,
  readOccurrenceLinks,
  type StoryBinding,
  type OccurrenceLink,
} from './story-links';
import { readCreativeMapLinks, type CreativeMapLinks } from './map-links';

export interface NativeReference {
  artifactId: string;
  versionId: string;
  elementId: string;
}
export interface SceneItemReference {
  mode: 'character' | 'setting';
  itemId: string;
  source: NativeReference;
  artwork: NativeReference;
}
/** Flat Host associations, not a Story Graph or another source record. */
export interface CreativeScene {
  id: string;
  kind: 'document' | 'design';
  origin: NativeReference;
  members: string[];
  items: SceneItemReference[];
}
export interface SceneReturn {
  sceneId: string;
  address: ElementAddress;
  versionId: string;
  /** v2 only: the occurrence the author came from, so a shared region is not confused. */
  occurrenceLinkId?: string;
}
export interface CreativeWorkspaceLinksV1 {
  schemaVersion: 1;
  scenes: CreativeScene[];
  world?: WorldContexts;
  mapLocations?: CreativeMapLinks;
  returnTo?: SceneReturn;
}
/** Story Timeline v2 (t0-contract.md §3, §4.2). `scenes` keeps the v1 meaning. */
export interface CreativeWorkspaceLinksV2 {
  schemaVersion: 2;
  scenes: CreativeScene[];
  world?: WorldContexts;
  mapLocations?: CreativeMapLinks;
  returnTo?: SceneReturn;
  story: StoryBinding;
  occurrenceLinks: OccurrenceLink[];
}
export type CreativeWorkspaceLinks = CreativeWorkspaceLinksV1 | CreativeWorkspaceLinksV2;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
const obj = (v: unknown, allowed: string[]) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k));
const native = (v: NativeReference) =>
  obj(v, ['artifactId', 'versionId', 'elementId']) &&
  text(v.artifactId) &&
  text(v.versionId) &&
  text(v.elementId);
/**
 * Reads links schema 1 and 2. Schema 2 adds the Story binding and occurrence links; the v1
 * reader shape is unchanged and still refuses every v2 key. Unknown keys or versions are
 * refused, never dropped.
 */
export function readWorkspaceLinks(raw: unknown): CreativeWorkspaceLinks {
  const v = raw as CreativeWorkspaceLinks;
  // A later schema is named and refused as is: never read as an older one (TL23).
  const version = (v as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version) && version > 2)
    throw Error(
      `Scene参照表の版 ${version} にはこの画面は対応していません。保存データは変えずに保持しています。`,
    );
  const v2 = !!v && typeof v === 'object' && (v as { schemaVersion?: unknown }).schemaVersion === 2;
  if (
    !obj(
      v,
      v2
        ? [
            'schemaVersion',
            'scenes',
            'returnTo',
            'world',
            'story',
            'occurrenceLinks',
            'mapLocations',
          ]
        : ['schemaVersion', 'scenes', 'returnTo', 'world', 'mapLocations'],
    ) ||
    (v.schemaVersion !== 1 && !v2) ||
    !Array.isArray(v.scenes) ||
    v.scenes.length > 256 ||
    v.scenes.some(
      (s) =>
        !obj(s, ['id', 'kind', 'origin', 'members', 'items']) ||
        !text(s.id) ||
        !['document', 'design'].includes(s.kind) ||
        !native(s.origin) ||
        !Array.isArray(s.members) ||
        s.members.length > 1024 ||
        !s.members.every(text) ||
        new Set(s.members).size !== s.members.length ||
        !Array.isArray(s.items) ||
        s.items.length > 256 ||
        s.items.some(
          (i) =>
            !obj(i, ['mode', 'itemId', 'source', 'artwork']) ||
            !['character', 'setting'].includes(i.mode) ||
            !text(i.itemId) ||
            !native(i.source) ||
            !native(i.artwork),
        ) ||
        new Set(s.items.map((i) => JSON.stringify([i.mode, i.itemId]))).size !== s.items.length,
    ) ||
    new Set(v.scenes.map((s) => s.id)).size !== v.scenes.length
  )
    throw Error('Scene参照表が不正です。保存データは保持しています。');
  if (v.returnTo !== undefined) {
    const r = v.returnTo,
      a = r?.address,
      region = a?.region;
    if (
      !obj(
        r,
        v2
          ? ['sceneId', 'address', 'versionId', 'occurrenceLinkId']
          : ['sceneId', 'address', 'versionId'],
      ) ||
      !v.scenes.some((s) => s.id === r.sceneId) ||
      !text(r.versionId) ||
      !obj(a, ['artifactId', 'elementId', 'region']) ||
      !text(a.artifactId) ||
      !text(a.elementId) ||
      (region !== undefined &&
        (!obj(region, ['type', 'start', 'end']) ||
          region.type !== 'text' ||
          !Number.isSafeInteger(region.start) ||
          !Number.isSafeInteger(region.end) ||
          region.start < 0 ||
          region.end < region.start))
    )
      throw Error('Scene戻り先が不正です。');
  }
  if (v.world !== undefined) readWorldContexts(v.world);
  if (v.mapLocations !== undefined) {
    const maps = readCreativeMapLinks(v.mapLocations);
    if (
      maps.locations.some(
        (r) =>
          r.namespace !== v.world?.namespace ||
          (r.sceneId !== undefined && !v.scenes.some((s) => s.id === r.sceneId)),
      )
    )
      throw Error('地図参照の作品またはSceneが一致しません。');
  }
  if (v.schemaVersion === 2) {
    if (!Object.hasOwn(v, 'story') || !Object.hasOwn(v, 'occurrenceLinks'))
      throw Error('物語の対応表が不正です（v2にはStoryのbindingと提示位置の対応が必要です）。');
    const story = readStoryBinding(v.story);
    const links = readOccurrenceLinks(v.occurrenceLinks, story, v.scenes);
    const id = v.returnTo?.occurrenceLinkId;
    if (
      id !== undefined &&
      !links.some((l) => l.id === id && l.regions.some((g) => g.sceneId === v.returnTo!.sceneId))
    )
      throw Error('Scene戻り先の提示位置が対応表にありません。');
  }
  return clone(v);
}
