/** Structural checks for the current Story; no clock or knowledge inference. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import type { TimelineRowInput } from './commands';
import type { TimelineRole } from './table';
type Row = StructuredData['rows'][number];
const kinds = new Set(['worldline', 'inherits', 'transfer', 'transfer-info', 'experience']);
const signature = (r: Row) =>
  canonicalJson(
    r.values['tl1.row'] === 'worldline'
      ? [
          r.id,
          r.values['tl1.world.parent'] ?? null,
          r.values['tl1.time.kind'] ?? null,
          r.values['tl1.time.start'] ?? null,
        ]
      : [
          r.id,
          Object.fromEntries(
            Object.entries(r.values).filter(([, v]) => v !== null && v !== undefined),
          ),
        ],
  );
export function changedStoryRows(before: StructuredData, after: StructuredData) {
  const previous = new Map(
    before.rows.filter((r) => kinds.has(String(r.values['tl1.row']))).map((r) => [r.id, r]),
  );
  const next = new Map(
    after.rows.filter((r) => kinds.has(String(r.values['tl1.row']))).map((r) => [r.id, r]),
  );
  const changed = new Set(
    [...new Set([...previous.keys(), ...next.keys()])].filter(
      (id) =>
        !previous.has(id) ||
        !next.has(id) ||
        signature(previous.get(id)!) !== signature(next.get(id)!),
    ),
  );
  const inspect = new Set(changed);
  let parentChanged = false;
  for (const id of changed) {
    const r = next.get(id) ?? previous.get(id)!;
    if (r.values['tl1.row'] === 'transfer-info') inspect.add(String(r.values['tl1.subject']));
    if (
      r.values['tl1.row'] === 'worldline' &&
      previous.get(id)?.values['tl1.world.parent'] !== next.get(id)?.values['tl1.world.parent']
    )
      parentChanged = true;
  }
  return {
    changed: changed.size > 0,
    rows: after.rows.filter(
      (r) => inspect.has(r.id) || (parentChanged && r.values['tl1.row'] === 'inherits'),
    ) as TimelineRowInput[],
  };
}

export function assertStoryStructure(
  ownerId: string,
  role: TimelineRole,
  data: StructuredData,
  story: CreativeWorkspaceLinksV2['story'],
  world: StructuredData | undefined,
) {
  if (role !== 'world' && role !== 'composition') return;
  if (ownerId !== (role === 'world' ? story.worldSettings : story.composition))
    throw Error('このStoryの保存先ではありません。');
  const worlds = role === 'world' ? data : world;
  if (!worlds) throw Error('世界設定を確認できません。');
  const parents = new Map(
    worlds.rows
      .filter((r) => r.values['tl1.row'] === 'worldline')
      .map((r) => [r.id, r.values['tl1.world.parent']]),
  );
  const ledgers = new Map(story.ledgers.map((l) => [l.artifactId, l.world]));
  for (const r of data.rows) {
    const v = r.values;
    if (!['inherits', 'transfer', 'experience'].includes(String(v['tl1.row']))) continue;
    for (const prefix of v['tl1.row'] === 'inherits' ? ['tl1.ref'] : ['tl1.ref', 'tl1.ref2'])
      if (!ledgers.has(String(v[prefix + '.artifact'])))
        throw Error('端点はこのStoryの台帳に限定してください。別Storyの関係は結合できません。');
    if (v['tl1.row'] === 'inherits') {
      const ancestors = new Set<string>();
      let at = parents.get(String(v['tl1.subject']));
      while (typeof at === 'string' && !ancestors.has(at)) {
        ancestors.add(at);
        at = parents.get(at);
      }
      if (!ancestors.has(ledgers.get(String(v['tl1.ref.artifact']))!))
        throw Error(
          '継承は親の系列にある台帳の保存版を指定してください。親変更の前に継承を確認してください。',
        );
    } else if (!parents.has(String(v['tl1.ind.origin'])))
      throw Error('人物個体の出身世界を確認してください。');
  }
}
