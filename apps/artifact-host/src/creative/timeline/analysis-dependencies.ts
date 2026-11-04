/** tl-deps/1: item/facet differences, followed by conditional propagation across exact edges. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  TimelineAnalysisContext,
  adoptedAnalysisRequest,
  TIMELINE_DEPENDENCY_RULES,
  type AnalysisTable,
  type Exact,
} from './analysis-context';
import { individual, semanticSignature, TimelineSemanticResolver } from './analysis-semantics';
import type { TimelineRow } from './table';
export interface TimelineRecheckSite {
  site: string;
  owner: string;
  row: string;
  ref: 'ref' | 'ref2';
  current: Exact | { type: 'internal'; item: string };
  classification: 'direct' | 'conditional' | 'undetermined';
  via: string[];
  state: 'unevaluated';
  destinations: { occurrence: string; links: string[] }[];
}
export interface TimelineRecheckCandidates {
  snapshotId: string;
  dependencyRules: typeof TIMELINE_DEPENDENCY_RULES;
  scope: 'complete' | 'partial';
  sites: TimelineRecheckSite[];
  current(): boolean;
}
type Change = {
  facets: Set<string>;
  conditional?: Set<string>;
  via: Set<string>;
  classification: 'direct' | 'conditional';
};
const group = (t: AnalysisTable, id: string, kinds: string[]) =>
  t.rows
    .filter((r) => r.cells['tl1.subject'] === id && kinds.includes(r.kind))
    .sort((a, b) => a.id.localeCompare(b.id));
const encode = (x: unknown) => canonicalJson(x ?? null);
export async function changedFacets(
  before: AnalysisTable,
  after: AnalysisTable,
  id: string,
  oldResolver: TimelineSemanticResolver,
  nextResolver: TimelineSemanticResolver,
): Promise<Set<string>> {
  const old = before.rows.find((r) => r.id === id),
    next = after.rows.find((r) => r.id === id),
    facets = new Set<string>();
  if (!old || !next || old.kind !== next.kind) facets.add('existence');
  if (old && next && old.kind === 'event' && next.kind === 'event') {
    const a = { table: before, row: old },
      b = { table: after, row: next };
    const timing = (r: TimelineRow) =>
      Object.fromEntries(
        Object.entries(r.cells).filter(([k]) => k.startsWith('tl1.time.') || k === 'tl1.clock'),
      );
    if (
      encode(timing(old)) !== encode(timing(next)) ||
      encode(group(before, id, ['derive-time', 'after', 'travel-min'])) !==
        encode(group(after, id, ['derive-time', 'after', 'travel-min'])) ||
      encode(await oldResolver.time(a)) !== encode(await nextResolver.time(b))
    )
      facets.add('time');
    const partsA = group(before, id, ['participant']),
      partsB = group(after, id, ['participant']);
    if (encode(partsA) !== encode(partsB)) {
      facets.add('participants');
      for (const ind of new Set([...partsA, ...partsB].map(individual)))
        if (
          encode(partsA.filter((r) => individual(r) === ind)) !==
          encode(partsB.filter((r) => individual(r) === ind))
        )
          facets.add('participants:' + ind);
    }
    const kinds = ['knows', 'claim', 'fact', 'presence', 'info-use'];
    if (
      old.cells['tl1.label'] !== next.cells['tl1.label'] ||
      encode(group(before, id, kinds)) !== encode(group(after, id, kinds))
    )
      facets.add('content');
    const infoA = group(before, id, ['knows', 'claim', 'fact', 'info-use']),
      infoB = group(after, id, ['knows', 'claim', 'fact', 'info-use']);
    for (const info of new Set([...infoA, ...infoB].map((r) => String(r.cells['tl1.info']))))
      if (
        encode(infoA.filter((r) => r.cells['tl1.info'] === info)) !==
        encode(infoB.filter((r) => r.cells['tl1.info'] === info))
      )
        facets.add('info:' + info);
    for (const ind of new Set(
      [...infoA, ...infoB].filter((r) => r.kind === 'knows').map(individual),
    ))
      if (
        encode(infoA.filter((r) => r.kind === 'knows' && individual(r) === ind)) !==
        encode(infoB.filter((r) => r.kind === 'knows' && individual(r) === ind))
      )
        facets.add('knows:' + ind);
    const oldUses = group(before, id, ['info-use', 'after', 'travel-min']),
      nextUses = group(after, id, ['info-use', 'after', 'travel-min']);
    const oldEval = await Promise.all(
      oldUses.map(async (r) => [
        r.id,
        r.kind === 'info-use'
          ? semanticSignature(await oldResolver.informationUse(before, r))
          : await oldResolver.constraintState(before, r),
      ]),
    );
    const newEval = await Promise.all(
      nextUses.map(async (r) => [
        r.id,
        r.kind === 'info-use'
          ? semanticSignature(await nextResolver.informationUse(after, r))
          : await nextResolver.constraintState(after, r),
      ]),
    );
    if (encode(oldEval) !== encode(newEval)) facets.add('evaluation');
  } else if (
    (old && next && encode(group(before, id, ['cite'])) !== encode(group(after, id, ['cite']))) ||
    old?.cells['tl1.label'] !== next?.cells['tl1.label']
  )
    facets.add('content');
  return facets;
}
function usedFacets(
  table: AnalysisTable,
  row: TimelineRow,
  which: 'ref' | 'ref2',
): string[] | undefined {
  const info = String(row.cells['tl1.info']),
    ind = individual(row),
    facet = row[which]?.facet ?? 'whole';
  const selector: Record<string, string[]> = {
    whole: ['participants', 'time', 'content', 'evaluation'],
    existence: [],
    participants: ['participants'],
    time: ['time'],
    content: ['content'],
    info: ['info:' + info, 'evaluation'],
    evaluation: ['evaluation'],
  };
  switch (row.kind) {
    case 'cite':
      return selector[facet] ? ['existence', ...selector[facet]] : undefined;
    case 'derive-time':
    case 'after':
      return ['existence', 'time'];
    case 'travel-min':
      return ['existence', 'participants:' + ind, 'time'];
    case 'cause':
      return ['existence', 'content'];
    case 'info-use':
      return ['existence', 'time', 'info:' + info];
    case 'inherits':
      return ['existence', 'participants', 'time', 'content'];
    case 'transfer':
      return which === 'ref2'
        ? ['existence', 'time']
        : [
            'existence',
            'participants:' + ind,
            'time',
            ...table.rows
              .filter((r) => r.kind === 'transfer-info' && r.cells['tl1.subject'] === row.id)
              .map((r) => 'info:' + r.cells['tl1.info']),
          ];
    case 'experience':
      return ['existence', 'participants:' + ind, 'knows:' + ind];
    case 'occurrence':
      return ['existence', 'content'];
    case 'exception-target':
      return ['existence', 'participants', 'time', 'content', 'evaluation'];
    case 'exception-basis':
      return selector[facet] ? ['existence', ...selector[facet]] : undefined;
  }
}
/** info:X is a subset of content; keep X precise rather than widening propagation. */
function consumes(used: string[], changed: ReadonlySet<string>) {
  return used.some(
    (f) =>
      changed.has(f) ||
      (f === 'content' && [...changed].some((changed) => changed.startsWith('info:'))),
  );
}
export function recheckDestinations(c: TimelineAnalysisContext, sceneOwner: string, scene: string) {
  const comp = c.fixed(c.links.story.composition);
  if (!comp) return [];
  return comp.rows
    .filter(
      (r) =>
        r.kind === 'occurrence' &&
        r.ref?.type === 'exact' &&
        r.ref.artifact === sceneOwner &&
        r.ref.item === scene,
    )
    .map((r) => ({
      occurrence: `${comp.owner}#${r.id}`,
      links: c.links.occurrenceLinks
        .filter(
          (l) =>
            l.occurrence.artifactId === comp.owner &&
            l.occurrence.itemId === r.id &&
            l.occurrence.versionId === comp.version &&
            l.occurrence.contentHash === comp.hash &&
            l.regions.every((region) => {
              const scene = c.links.scenes.find((s) => s.id === region.sceneId);
              return scene && c.workbench.readable(scene.origin.artifactId);
            }),
        )
        .map((l) => l.id),
    }));
}
export async function resolveRecheckCandidates(
  c: TimelineAnalysisContext,
): Promise<TimelineRecheckCandidates> {
  const resolver = new TimelineSemanticResolver(c),
    oldContext = await TimelineAnalysisContext.create(
      c.workbench,
      adoptedAnalysisRequest(c.request),
    ),
    oldResolver = new TimelineSemanticResolver(oldContext);
  const changes = new Map<string, Change>(),
    sites = new Map<string, TimelineRecheckSite>();
  const candidateByOwner = new Map<string, AnalysisTable>();
  for (const t of c.candidates.values()) {
    if (candidateByOwner.has(t.owner))
      throw Error('再確認候補の差分元は一資料につき一案を選んでください。');
    candidateByOwner.set(t.owner, t);
    const base = await c.exact({
      type: 'exact',
      artifact: t.owner,
      version: t.version,
      hash: t.hash,
      item: '',
    });
    if (!base) continue;
    for (const id of new Set(
      [...base.rows, ...t.rows]
        .filter((r) => r.kind === 'event' || r.kind === 'scene')
        .map((r) => r.id),
    )) {
      const facets = await changedFacets(base, t, id, oldResolver, resolver);
      if (facets.size)
        changes.set(`${t.owner}#${id}`, {
          facets,
          via: new Set([...facets].map((f) => `${t.owner}#${id}.${f}`)),
          classification: 'direct',
        });
    }
  }
  const roots = [...c.adopted.keys()].flatMap((id) => c.fixed(id) ?? []);
  const relations = roots.flatMap((table) =>
    table.rows.flatMap((row) =>
      (['ref', 'ref2'] as const).flatMap((which) => {
        const ref = row[which];
        if (!ref) return [];
        if (ref.type === 'exact' && !c.workbench.readable(ref.artifact)) {
          c.partial = true;
          c.unreadable = true;
          return [];
        }
        return [
          {
            table,
            row,
            which,
            ref,
            target: `${ref.type === 'exact' ? ref.artifact : table.owner}#${ref.item}`,
          },
        ];
      }),
    ),
  );
  // Compare each referenced immutable version, not just the currently adopted source version.
  const exactDiff = new Map<string, Set<string> | undefined>();
  for (const rel of relations) {
    if (rel.ref.type !== 'exact') continue;
    const candidate = candidateByOwner.get(rel.ref.artifact);
    if (!candidate) continue;
    const key = encode(rel.ref);
    if (exactDiff.has(key)) continue;
    const old = await c.exact(rel.ref);
    exactDiff.set(
      key,
      old ? await changedFacets(old, candidate, rel.ref.item, oldResolver, resolver) : undefined,
    );
  }
  let changed = true;
  const propagate = (key: string, facets: string[], via: Set<string>) => {
    const prior = changes.get(key),
      next: Change = prior ?? {
        facets: new Set<string>(),
        via: new Set<string>(),
        classification: 'conditional' as const,
      };
    next.conditional ??= new Set<string>();
    for (const f of facets)
      if (!next.conditional.has(f)) {
        next.conditional.add(f);
        changed = true;
      }
    for (const f of facets)
      if (!next.facets.has(f)) {
        next.facets.add(f);
        changed = true;
      }
    for (const v of via) next.via.add(v);
    changes.set(key, next);
  };
  for (let pass = 0; changed && pass <= relations.length + 1; pass++) {
    changed = false;
    for (const rel of relations) {
      const { table, row, which, ref, target } = rel,
        used = usedFacets(table, row, which);
      const direct =
        ref.type === 'exact' && candidateByOwner.has(ref.artifact) && exactDiff.has(encode(ref))
          ? exactDiff.get(encode(ref))
          : undefined;
      const source = changes.get(target),
        diff =
          ref.type === 'internal'
            ? new Set(source?.conditional ?? [])
            : new Set([...(direct ?? source?.facets ?? []), ...(source?.conditional ?? [])]);
      const unknown =
        ref.type === 'exact' &&
        candidateByOwner.has(ref.artifact) &&
        exactDiff.has(encode(ref)) &&
        exactDiff.get(encode(ref)) === undefined;
      if (!unknown && (!diff?.size || (used && !consumes(used, diff)))) continue;
      // Same-owner evaluated propagation is already calculated; expose external sites and conditional internals.
      if (ref.type === 'internal' && !source?.conditional?.size) continue;
      const classification =
        unknown || !used
          ? 'undetermined'
          : direct?.size && (!used || consumes(used, direct))
            ? 'direct'
            : source?.conditional && (!used || consumes(used, source.conditional))
              ? 'conditional'
              : (source?.classification ?? 'conditional');
      const key = `${table.owner}#${row.id}${row.kind === 'transfer' ? '/' + which : ''}`;
      const via = new Set(source?.via ?? [target]);
      const previous = sites.get(key);
      if (
        !previous ||
        previous.classification === 'conditional' ||
        classification === 'undetermined'
      )
        sites.set(key, {
          site: key,
          owner: table.owner,
          row: row.id,
          ref: which,
          current: ref,
          classification,
          via: [...via].sort(),
          state: 'unevaluated',
          destinations:
            row.kind === 'cite'
              ? recheckDestinations(c, table.owner, String(row.cells['tl1.subject']))
              : [],
        });
      if (classification === 'undetermined') continue;
      const subject = `${table.owner}#${row.cells['tl1.subject']}`;
      if (row.kind === 'derive-time') propagate(subject, ['time'], via);
      if (['after', 'travel-min', 'info-use'].includes(row.kind))
        propagate(subject, ['evaluation'], via);
      if (row.kind === 'transfer' && which === 'ref' && row.ref2?.type === 'exact')
        propagate(
          `${row.ref2.artifact}#${row.ref2.item}`,
          table.rows
            .filter((r) => r.kind === 'transfer-info' && r.cells['tl1.subject'] === row.id)
            .map((r) => 'info:' + r.cells['tl1.info']),
          via,
        );
    }
  }
  c.assertBudget([...sites.values()]);
  c.assertCurrent();
  oldContext.assertCurrent();
  return {
    snapshotId: c.snapshotId,
    dependencyRules: TIMELINE_DEPENDENCY_RULES,
    scope: c.partial ? 'partial' : 'complete',
    sites: c.unreadable ? [] : [...sites.values()].sort((a, b) => a.site.localeCompare(b.site)),
    current: () => c.current() && oldContext.current(),
  };
}
