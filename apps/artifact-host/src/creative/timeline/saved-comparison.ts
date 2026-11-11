/** Explicit immutable Timeline comparisons; never disguises a saved version as a candidate. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  TimelineAnalysisContext,
  TIMELINE_DEPENDENCY_RULES,
  type Exact,
  type TimelineSavedComparisonSource,
} from './analysis-context';
import { changedFacets } from './analysis-dependencies';
import { TimelineSemanticResolver } from './analysis-semantics';
import { TL1_LIMITS } from './tl1-schema';

export interface TimelineSavedComparisonRequest {
  before: Exact;
  after: Exact;
  /** Explicit world/clock and other root premises for each side. No current-base defaults. */
  beforeRoots: Exact[];
  afterRoots: Exact[];
  facets: string[];
}
export interface TimelineSavedFacet {
  facet: string;
  state: 'changed' | 'unchanged' | 'unsupported' | 'undetermined';
  reason?: string;
}
const supported = (facet: string) =>
  ['existence', 'time', 'participants', 'content', 'evaluation'].includes(facet) ||
  /^(info|participants|knows):.+$/.test(facet);

/** Host authorizes owners through the workbench and must check current() before use. */
export async function compareTimelineSavedFacets(
  w: TimelineSavedComparisonSource,
  request: TimelineSavedComparisonRequest,
) {
  const input = structuredClone(request);
  if (
    new TextEncoder().encode(canonicalJson(input)).byteLength > TL1_LIMITS.projectionBytes ||
    input.before.type !== 'exact' ||
    input.after.type !== 'exact' ||
    !input.before.item ||
    input.before.artifact !== input.after.artifact ||
    input.before.item !== input.after.item ||
    !input.facets.length ||
    input.facets.some((f) => typeof f !== 'string') ||
    input.beforeRoots.some((r) => r.type !== 'exact') ||
    input.afterRoots.some((r) => r.type !== 'exact')
  )
    throw Error('保存版比較の対象が不正です。');
  const withTarget = (roots: Exact[], target: Exact) => {
    const root = roots.find((r) => r.artifact === target.artifact);
    if (root && (root.version !== target.version || root.hash !== target.hash))
      throw Error('保存版比較の対象と前提が一致しません。');
    return root ? roots : [...roots, target];
  };
  const before = await TimelineAnalysisContext.createSaved(
    w,
    withTarget(input.beforeRoots, input.before),
  );
  const after = await TimelineAnalysisContext.createSaved(
    w,
    withTarget(input.afterRoots, input.after),
  );
  const current = () => before.current() && after.current();
  const assertCurrent = () => {
    if (!current() || before.unreadable || after.unreadable)
      throw Error('保存版比較の入力・権限を確認できません。');
  };
  assertCurrent();
  const a = before.fixed(input.before.artifact),
    b = after.fixed(input.after.artifact);
  const old = a?.rows.find((r) => r.id === input.before.item);
  const next = b?.rows.find((r) => r.id === input.after.item);
  // Missing items on both sides cannot establish that a reference is unaffected.
  const present = !!a && !!b && (!!old || !!next);
  const oldResolver = new TimelineSemanticResolver(before),
    nextResolver = new TimelineSemanticResolver(after);
  const changes = present
    ? await changedFacets(a, b, input.before.item, oldResolver, nextResolver)
    : new Set<string>();
  let timeResolved = false,
    evaluationResolved = false;
  if (a && b && old?.kind === 'event' && next?.kind === 'event') {
    const oldTime = await oldResolver.time({ table: a, row: old });
    const nextTime = await nextResolver.time({ table: b, row: next });
    timeResolved =
      oldTime.state === 'resolved' &&
      nextTime.state === 'resolved' &&
      !!oldTime.time.clock &&
      !!nextTime.time.clock;
    const states = [];
    for (const [table, resolver] of [
      [a, oldResolver],
      [b, nextResolver],
    ] as const)
      for (const row of table.rows.filter((r) => r.cells['tl1.subject'] === input.before.item)) {
        if (row.kind === 'info-use') states.push((await resolver.informationUse(table, row)).state);
        if (row.kind === 'after' || row.kind === 'travel-min')
          states.push(await resolver.constraintState(table, row));
      }
    evaluationResolved = states.every((s) => s === 'satisfied' || s === 'contradiction');
  }
  assertCurrent();
  const facets: TimelineSavedFacet[] = [...new Set(input.facets)].map((facet) => {
    if (!supported(facet)) return { facet, state: 'unsupported', reason: 'unsupported-facet' };
    if (!present) return { facet, state: 'undetermined', reason: 'unresolved-exact-or-item' };
    if (facet === 'existence')
      return { facet, state: changes.has(facet) ? 'changed' : 'unchanged' };
    if (!old || !next || old.kind !== next.kind)
      return { facet, state: 'undetermined', reason: 'target-added-removed-or-kind-changed' };
    if (old.kind !== 'event') return { facet, state: 'unsupported', reason: 'event-facet-only' };
    if (
      (facet === 'time' || facet === 'evaluation') &&
      (before.partial || after.partial || (facet === 'time' ? !timeResolved : !evaluationResolved))
    )
      return { facet, state: 'undetermined', reason: 'incomplete-semantic-premises' };
    return { facet, state: changes.has(facet) ? 'changed' : 'unchanged' };
  });
  before.assertBudget({ input, facets });
  assertCurrent();
  return {
    before: input.before,
    after: input.after,
    beforeRoots: input.beforeRoots,
    afterRoots: input.afterRoots,
    dependencyRules: TIMELINE_DEPENDENCY_RULES,
    scope: facets.every((f) => f.state === 'changed' || f.state === 'unchanged')
      ? ('complete' as const)
      : ('partial' as const),
    facets,
    current,
    /** Stable request identity for Host generation checks; not a native version. */
    requestKey: canonicalJson(input),
  };
}
