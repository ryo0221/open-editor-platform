/**
 * Story Timeline T1a: the v2 additions of CreativeWorkspaceLinks (t0-contract.md §2.4, §3).
 * Reader only. Nothing in T1a writes `story` or `occurrenceLinks`; existing Workspace writes
 * carry them through unchanged (§4.2). The writer and migrateLinksToV2 belong to T2.
 */
import { TL1_LIMITS } from '../timeline/tl1-schema';

/** Binds a Story to its owner Artifacts. Owners only: versions are fixed per snapshot. */
export interface StoryBinding {
  id: string;
  namespace: string;
  /** artifactId of the composition structure (occurrence, experience rows). */
  composition: string;
  /** artifactId of the world-notes structure (worldline, clock, transfer rows). */
  worldSettings: string;
  characters?: string;
  ledgers: { world: string; artifactId: string }[];
  sceneCards: string[];
}
export interface OccurrenceLink {
  id: string;
  /** Exact saved version of one composition occurrence row. */
  occurrence: { artifactId: string; versionId: string; contentHash: string; itemId: string };
  /** 1–64 registered manuscript regions, in reading order. */
  regions: {
    sceneId: string;
    address: { artifactId: string; versionId: string; elementId: string };
  }[];
}

const MAX_OWNERS = 64;
const HASH = /^[0-9a-f]{64}$/;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 4096;
const obj = (v: unknown, allowed: string[], required: string[] = allowed) =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => allowed.includes(k)) &&
  required.every((k) => Object.hasOwn(v, k));
const fail = (why: string): never => {
  throw Error(`物語の対応表が不正です（${why}）。保存データは保持しています。`);
};

export function readStoryBinding(raw: unknown): StoryBinding {
  const v = raw as StoryBinding;
  if (
    !obj(
      v,
      ['id', 'namespace', 'composition', 'worldSettings', 'characters', 'ledgers', 'sceneCards'],
      ['id', 'namespace', 'composition', 'worldSettings', 'ledgers', 'sceneCards'],
    ) ||
    ![v.id, v.namespace, v.composition, v.worldSettings].every(text) ||
    (v.characters !== undefined && !text(v.characters))
  )
    fail('Storyのbinding');
  if (
    !Array.isArray(v.ledgers) ||
    !v.ledgers.length ||
    v.ledgers.length > MAX_OWNERS ||
    v.ledgers.some((l) => !obj(l, ['world', 'artifactId']) || !text(l.world) || !text(l.artifactId))
  )
    fail('筋の台帳');
  if (!Array.isArray(v.sceneCards) || v.sceneCards.length > MAX_OWNERS || !v.sceneCards.every(text))
    fail('シーンカード');
  const owners = [
    v.composition,
    v.worldSettings,
    ...(v.characters ? [v.characters] : []),
    ...v.ledgers.map((l) => l.artifactId),
    ...v.sceneCards,
  ];
  // One Artifact is one owner role. A role conflict would let one table be read two ways.
  if (new Set(owners).size !== owners.length) fail('同じArtifactが複数の役割に結ばれています');
  return v;
}

export function readOccurrenceLinks(
  raw: unknown,
  story: StoryBinding,
  scenes: { id: string; origin: { artifactId: string; elementId: string }; members: string[] }[],
): OccurrenceLink[] {
  if (!Array.isArray(raw) || raw.length > TL1_LIMITS.occurrenceLinks) fail('提示位置の対応の件数');
  const links = raw as OccurrenceLink[];
  const ids = new Set<string>(),
    occurrences = new Set<string>();
  for (const l of links) {
    const o = l?.occurrence;
    if (
      !obj(l, ['id', 'occurrence', 'regions']) ||
      !text(l.id) ||
      !obj(o, ['artifactId', 'versionId', 'contentHash', 'itemId']) ||
      !text(o.artifactId) ||
      !text(o.versionId) ||
      !text(o.itemId) ||
      typeof o.contentHash !== 'string' ||
      !HASH.test(o.contentHash)
    )
      fail('提示位置の対応');
    if (ids.has(l.id)) fail(`対応 ${l.id} が重複しています`);
    ids.add(l.id);
    if (o.artifactId !== story.composition) fail(`${l.id} の提示位置が作品の構成ではありません`);
    const key = JSON.stringify([o.artifactId, o.itemId]);
    if (occurrences.has(key)) fail(`提示位置 ${o.itemId} の対応が複数あります`);
    occurrences.add(key);
    // An empty link is not stored: "原稿未接続" is the absence of a link.
    if (
      !Array.isArray(l.regions) ||
      !l.regions.length ||
      l.regions.length > TL1_LIMITS.regionsPerOccurrenceLink
    )
      fail(`${l.id} の原稿領域の件数`);
    const seen = new Set<string>();
    for (const g of l.regions) {
      const a = g?.address;
      if (
        !obj(g, ['sceneId', 'address']) ||
        !text(g.sceneId) ||
        !obj(a, ['artifactId', 'versionId', 'elementId']) ||
        !text(a.artifactId) ||
        !text(a.versionId) ||
        !text(a.elementId)
      )
        fail(`${l.id} の原稿領域`);
      const scene = scenes.find((s) => s.id === g.sceneId);
      if (!scene) fail(`${l.id} の原稿領域 ${g.sceneId} が登録されていません`);
      if (
        a.artifactId !== scene!.origin.artifactId ||
        ![scene!.origin.elementId, ...scene!.members].includes(a.elementId)
      )
        fail(`${l.id} の原稿addressが領域 ${g.sceneId} の要素ではありません`);
      const k = JSON.stringify([g.sceneId, a.elementId]);
      if (seen.has(k)) fail(`${l.id} に同じ原稿領域が重複しています`);
      seen.add(k);
    }
  }
  return links;
}
