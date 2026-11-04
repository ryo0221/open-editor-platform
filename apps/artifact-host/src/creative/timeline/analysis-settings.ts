/** Setting diagnostics read existing native Document sections and SceneItemReferences.
 * Temporal meaning is explicit Host input; prose never becomes a bridge-destruction rule. */
import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { isDocument } from '@editor-platform/document/model';
import { settingSourceCards } from '../setting-source';
import type { TimelineWorkbench } from './workbench';
import type { Exact } from './analysis-context';
import type { TimelineTime } from './projection';
import { TL1_LIMITS } from './tl1-schema';
export interface TimelineSettingComparison {
  before: Exact;
  after: Exact;
  world: string;
  /** An event changes the setting from this time; a correction uses its declared interval. */
  kind: 'event' | 'correction';
  period: { clock: string; start: number; end?: number };
  /** Read selectors/time from the consuming Host's native scene interpretation. */
  uses: { scene: string; fields: string[]; world: string; time: TimelineTime }[];
}
export async function compareTimelineSetting(
  w: TimelineWorkbench,
  request: TimelineSettingComparison,
) {
  const input = structuredClone(request),
    links = canonicalJson(w.links);
  if (
    new TextEncoder().encode(canonicalJson(input)).byteLength > TL1_LIMITS.projectionBytes ||
    input.uses.length > TL1_LIMITS.scenes
  )
    throw Error('設定比較の入力が上限を超えます。');
  if (
    input.before.artifact !== input.after.artifact ||
    input.before.item !== input.after.item ||
    !['event', 'correction'].includes(input.kind) ||
    !input.period.clock ||
    !Number.isSafeInteger(input.period.start) ||
    (input.period.end !== undefined &&
      (!Number.isSafeInteger(input.period.end) ||
        input.period.end < input.period.start ||
        input.kind === 'event'))
  )
    throw Error('設定の比較元・比較先・対象期間が不正です。');
  const access = w.captureAccess(input.before.artifact);
  const current = () => access() && canonicalJson(w.links) === links;
  const empty = () => ({ scope: 'partial' as const, sites: [], current });
  if (!w.readable(input.before.artifact)) return empty();
  const a = await w.source.get(input.before.artifact);
  if (!current()) throw Error('設定比較の前提が変わりました。');
  const read = async (r: Exact) => {
    const versions = a?.versions.filter((v) => v.versionId === r.version);
    if (!versions?.length) return undefined;
    if (
      versions.length !== 1 ||
      a?.id !== r.artifact ||
      versions[0].contentHash !== r.hash ||
      (await contentHash(versions[0].content)) !== r.hash ||
      !isDocument(versions[0].content)
    )
      throw Error('設定の保存版を確認できません。');
    return settingSourceCards(versions[0].content).find((c) => c.id === r.item);
  };
  const before = await read(input.before),
    after = await read(input.after);
  const changed =
    before && after
      ? new Set(
          [...before.fields, ...after.fields]
            .filter(
              (field) =>
                before.fields.find((f) => f.id === field.id)?.value !==
                after.fields.find((f) => f.id === field.id)?.value,
            )
            .map((field) => field.id),
        )
      : undefined;
  const sites = [] as {
    scene: string;
    state: 'unevaluated';
    classification: 'direct' | 'undetermined';
    current: Exact;
    selectors: string[];
    period: TimelineSettingComparison['period'];
    destinations: {
      occurrence: string;
      address: { artifactId: string; versionId: string; elementId: string };
    }[];
  }[];
  for (const use of input.uses) {
    if (use.world !== input.world) continue;
    const scene = w.links.scenes.find((s) => s.id === use.scene);
    if (!scene) throw Error('設定を使う原稿Sceneがありません。');
    if (
      !w.readable(scene.origin.artifactId) ||
      scene.items.some((i) => !w.readable(i.source.artifactId))
    )
      return empty();
    const references = scene.items.filter(
      (i) =>
        i.mode === 'setting' &&
        i.itemId === input.before.item &&
        i.source.artifactId === input.before.artifact &&
        i.source.versionId === input.before.version,
    );
    if (!references.length) continue;
    if (before && references.some((r) => r.source.elementId !== before.elementId))
      throw Error('設定のnative selectorが一致しません。');
    if (use.fields.some((f) => !['description', 'history', 'life', 'atmosphere'].includes(f)))
      throw Error('未知の設定selectorです。');
    const fields = changed ? use.fields.filter((f) => changed.has(f)) : use.fields;
    if (!fields.length) continue;
    const time = use.time;
    // Missing range bounds stay unbounded; they must not become a point or zero.
    const range = time.kind === 'range';
    const start = range ? (time.start ?? -Infinity) : time.start!;
    const end = time.end ?? (range ? Infinity : time.kind === 'day' ? start + 1 : start);
    const comparable =
      time.clock === input.period.clock &&
      ['point', 'day', 'interval', 'range'].includes(time.kind) &&
      (range
        ? (time.start !== undefined || time.end !== undefined) &&
          (time.start === undefined || Number.isFinite(time.start)) &&
          (time.end === undefined || Number.isFinite(time.end)) &&
          start <= end
        : Number.isFinite(start) && Number.isFinite(end));
    if (
      comparable &&
      (end < input.period.start || (input.period.end !== undefined && start > input.period.end))
    )
      continue;
    const destinations = w.links.occurrenceLinks.flatMap((l) =>
      l.regions
        .filter((r) => r.sceneId === scene.id)
        .map((r) => ({ occurrence: l.occurrence.itemId, address: r.address })),
    );
    if (destinations.some((d) => !w.readable(d.address.artifactId))) return empty();
    sites.push({
      scene: scene.id,
      state: 'unevaluated',
      classification: changed && comparable ? 'direct' : 'undetermined',
      current: input.before,
      selectors: fields,
      period: input.period,
      destinations,
    });
  }
  if (!current()) throw Error('設定比較の前提が変わりました。');
  const snapshotId = await contentHash({
    input,
    links,
    epoch: w.accessEpoch,
    rule: 'tl-setting-selectors/1',
  });
  if (!current()) throw Error('設定比較の前提が変わりました。');
  return {
    scope: before && after ? ('complete' as const) : ('partial' as const),
    sites,
    snapshotId,
    current,
  };
}
