import { canonicalJson } from '@editor-platform/artifact-core';
import {
  readCreativeWorldExecutionRecord,
  type CreativeWorldExecutionRecord,
} from './generation-record';

export interface CreativeWorldUsageImpact {
  state: 'current' | 'review' | 'unavailable';
  reasons: string[];
}
/** Compare what was actually projected. Publication/revision changes alone do not imply repainting. */
export function compareCreativeWorldUsage(
  raw: CreativeWorldExecutionRecord,
  references: CreativeWorldExecutionRecord['context']['references'],
): CreativeWorldUsageImpact {
  const record = readCreativeWorldExecutionRecord(raw);
  const identity = (r: (typeof references)[number]) => canonicalJson([r.contextId, r.reference.id]);
  const effective = (r: (typeof references)[number]) =>
    canonicalJson([
      r.reference.namespace,
      r.reference.artifactId,
      r.reference.selector,
      r.reference.role,
      r.reference.required,
      r.projectionHash,
    ]);
  const current = new Map(references.map((r) => [identity(r), r]));
  if (
    current.size !== references.length ||
    references.some((r) => r.reference.namespace !== record.namespace)
  )
    throw Error('影響比較の作品・参照が不正です。');
  const reasons: string[] = [];
  for (const before of record.context.references) {
    const next = current.get(identity(before));
    if (!next || effective(before) !== effective(next))
      reasons.push(`${before.reference.id}: 利用した資料・投影・条件の変更を確認してください。`);
    current.delete(identity(before));
  }
  for (const added of current.values())
    reasons.push(`${added.reference.id}: 新しい制作前提を確認してください。`);
  return { state: reasons.length ? 'review' : 'current', reasons };
}
