/** Read-only T3 Host coordination. Proposals are ephemeral, never native versions or commands. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  TimelineAnalysisContext,
  adoptedAnalysisRequest,
  captureTimelineCandidate,
  type TimelineCandidate,
  type TimelineAnalysisScope,
  type TimelineAnalysisRequest,
  type TimelineSubstitution,
  type AnalysisTable,
} from './analysis-context';
import { TimelineSemanticResolver, type TimelineSemantics } from './analysis-semantics';
import { resolveRecheckCandidates, type TimelineRecheckCandidates } from './analysis-dependencies';
import type { TimelineWorkbench } from './workbench';
import type { TimelineRow } from './table';
export interface TimelineAnalysisCapabilities {
  t3a: boolean;
  t3b: boolean;
  readingPremise: false;
  shared: false;
}
export interface TimelineAnalysisResult {
  snapshotId: string;
  adopted: TimelineSemantics;
  candidate: TimelineSemantics;
  recheck: TimelineRecheckCandidates;
  current(): boolean;
}
export interface TimelineSubstitutionProposal {
  snapshotId: string;
  scope: TimelineAnalysisScope;
  candidates: TimelineCandidate[];
  rows: TimelineSubstitution[];
  state: 'unevaluated';
  current(): boolean;
}
export interface TimelineConfirmedHypothesis {
  snapshotId: string;
  scope: TimelineAnalysisScope;
  rows: TimelineSubstitution[];
  current(): boolean;
}
export interface TimelineHypothesisResult {
  adopted: TimelineSemantics;
  candidate: TimelineSemantics;
  hypothesis: TimelineSemantics;
  scope: TimelineAnalysisScope;
  rows: TimelineSubstitution[];
  current(): boolean;
}
export class TimelineAnalysisHost {
  private analyses = new WeakMap<TimelineAnalysisResult, TimelineAnalysisContext>();
  private proposals = new WeakMap<
    TimelineSubstitutionProposal,
    {
      analysis: TimelineAnalysisResult;
      context: TimelineAnalysisContext;
      input: TimelineAnalysisRequest;
      scope: TimelineAnalysisScope;
      generation: number;
    }
  >();
  private confirmed = new WeakMap<
    TimelineConfirmedHypothesis,
    {
      context: TimelineAnalysisContext;
      analysis: TimelineAnalysisResult;
      display: string;
      generation: number;
    }
  >();
  private generation = 0;
  readonly capabilities: TimelineAnalysisCapabilities;
  constructor(
    readonly workbench: TimelineWorkbench,
    capabilities: TimelineAnalysisCapabilities = {
      t3a: true,
      t3b: true,
      readingPremise: false,
      shared: false,
    },
  ) {
    this.capabilities = Object.freeze({ ...capabilities });
  }
  private require(feature: 't3a' | 't3b') {
    if (!this.capabilities[feature])
      throw Error(feature + 'は未対応です。固定参照診断へ置き換えません。');
  }
  async analyze(input: TimelineAnalysisRequest = {}): Promise<TimelineAnalysisResult> {
    this.require('t3a');
    if (input.substitutions?.length) throw Error('差替表は作者確認後の仮定診断へ渡してください。');
    const adopted = await TimelineAnalysisContext.create(
        this.workbench,
        adoptedAnalysisRequest(input),
      ),
      c = await TimelineAnalysisContext.create(this.workbench, input);
    const a = await new TimelineSemanticResolver(adopted).evaluate(),
      b = await new TimelineSemanticResolver(c).evaluate(),
      recheck = await resolveRecheckCandidates(c);
    adopted.assertCurrent();
    c.assertCurrent();
    const result = {
      snapshotId: c.snapshotId,
      adopted: a,
      candidate: b,
      recheck,
      current: () => a.current() && b.current() && recheck.current(),
    };
    this.analyses.set(result, c);
    return result;
  }
  async proposeSubstitutions(
    analysis: TimelineAnalysisResult,
    selected: TimelineAnalysisScope,
  ): Promise<TimelineSubstitutionProposal> {
    this.require('t3b');
    const context = this.analyses.get(analysis);
    if (!context || !analysis.current()) throw Error('候補を再診断してください。');
    if (
      selected.kind !== 'information-use' ||
      !selected.targets.length ||
      new Set(selected.targets).size !== selected.targets.length
    )
      throw Error('情報利用を試算する場面を選んでください。');
    if (context.unreadable) throw Error('読めない資料を含む差替案は作れません。');
    const generation = ++this.generation,
      scope = structuredClone(selected),
      candidates = structuredClone(context.request.candidates ?? []),
      byOwner = new Map(candidates.map((c) => [c.owner, c]));
    const rows: TimelineSubstitution[] = [],
      seen = new Set<string>(),
      visited = new Set<string>();
    const ensure = async (owner: string) => {
      let c = byOwner.get(owner);
      if (!c) {
        c = await captureTimelineCandidate(this.workbench, owner, 'candidate:' + owner, true);
        candidates.push(c);
        byOwner.set(owner, c);
      }
      return c;
    };
    const add = async (table: AnalysisTable, row: TimelineRow, ref: 'ref' | 'ref2') => {
      const old = row[ref];
      if (old?.type !== 'exact') return;
      const to = byOwner.get(old.artifact);
      if (!to) return;
      const source = await ensure(table.owner),
        key = canonicalJson([source.id, row.id, ref]);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        source: source.id,
        owner: source.owner,
        base: source.base,
        selector: { row: row.id, ref },
        expectOld: structuredClone(old),
        to: { candidate: to.id, item: old.item },
      });
    };
    const event = async (owner: string, item: string) => {
      const key = owner + '#' + item;
      if (visited.has(key)) return;
      visited.add(key);
      const table = context.fixed(owner);
      if (!table) throw Error('試算対象の保存版を確認できません。');
      await ensure(owner);
      for (const row of table.rows.filter(
        (r) => r.cells['tl1.subject'] === item && ['derive-time', 'info-use'].includes(r.kind),
      )) {
        if (!row.ref) continue;
        if (row.ref.type === 'internal') await event(owner, row.ref.item);
        else if (byOwner.has(row.ref.artifact)) {
          await event(row.ref.artifact, row.ref.item);
          await add(table, row, 'ref');
        }
      }
      const world = context.fixed(context.links.story.worldSettings);
      if (world)
        for (const tr of world.rows.filter(
          (r) =>
            r.kind === 'transfer' &&
            r.ref2?.type === 'exact' &&
            r.ref2.artifact === owner &&
            r.ref2.item === item,
        )) {
          if (!tr.ref || tr.ref.type !== 'exact' || !byOwner.has(tr.ref.artifact)) continue;
          if (
            !this.workbench.readable(tr.ref.artifact) ||
            !this.workbench.readable(tr.ref2?.type === 'exact' ? tr.ref2.artifact : '')
          )
            throw Error('移送の端点を読めません。');
          await ensure(world.owner);
          await event(tr.ref.artifact, tr.ref.item);
          await add(world, tr, 'ref');
          await add(world, tr, 'ref2');
        }
    };
    for (const target of scope.targets) {
      const split = target.lastIndexOf('#'),
        owner = target.slice(0, split),
        item = target.slice(split + 1),
        table = context.fixed(owner);
      if (
        !table ||
        table.role !== 'scene-cards' ||
        !table.rows.some((r) => r.id === item && r.kind === 'scene')
      )
        throw Error('選択した場面を確認できません。');
      const sites = analysis.recheck.sites.filter(
        (s) =>
          s.owner === owner &&
          table.rows.find((r) => r.id === s.row)?.cells['tl1.subject'] === item,
      );
      if (!sites.length) throw Error('未評価の再確認候補から場面を選んでください。');
      for (const row of table.rows.filter(
        (r) => r.kind === 'cite' && r.cells['tl1.subject'] === item,
      )) {
        if (row.ref?.type !== 'exact') continue;
        const targetTable = await context.exact(row.ref);
        if (
          !targetTable ||
          !targetTable.rows.some(
            (r) => r.kind === 'info-use' && r.cells['tl1.subject'] === row.ref!.item,
          )
        )
          continue;
        await event(row.ref.artifact, row.ref.item);
        await add(table, row, 'ref');
      }
    }
    context.assertCurrent();
    if (generation !== this.generation) throw Error('差替案の要求が新しくなりました。');
    const input = { ...context.request, candidates, scope };
    const prepared = await TimelineAnalysisContext.create(this.workbench, input);
    const proposal: TimelineSubstitutionProposal = {
      snapshotId: prepared.snapshotId,
      scope: structuredClone(scope),
      candidates: structuredClone(candidates),
      rows: structuredClone(rows),
      state: 'unevaluated',
      current: () => prepared.current() && analysis.current() && generation === this.generation,
    };
    this.proposals.set(proposal, { analysis, context: prepared, input, scope, generation });
    return proposal;
  }
  cancelProposal(proposal: TimelineSubstitutionProposal) {
    if (this.proposals.has(proposal)) {
      this.proposals.delete(proposal);
      this.generation++;
    }
  }
  async confirmSubstitutions(
    proposal: TimelineSubstitutionProposal,
    selectedRows: TimelineSubstitution[],
    scope: TimelineAnalysisScope = proposal.scope,
  ): Promise<TimelineConfirmedHypothesis> {
    this.require('t3b');
    const p = this.proposals.get(proposal);
    if (!p || !proposal.current() || canonicalJson(scope) !== canonicalJson(p.scope))
      throw Error('差替案の入力・範囲が変わりました。再生成してください。');
    const rows = structuredClone(selectedRows),
      roots = { ...p.input.roots };
    for (const r of rows) roots[r.owner] = r.source;
    const c = await TimelineAnalysisContext.create(this.workbench, {
      ...p.input,
      substitutions: rows,
      roots,
    });
    if (!proposal.current()) throw Error('差替案が失効しました。');
    const result: TimelineConfirmedHypothesis = {
      snapshotId: c.snapshotId,
      scope: structuredClone(p.scope),
      rows,
      current: () => c.current() && p.generation === this.generation,
    };
    this.confirmed.set(result, {
      context: c,
      analysis: p.analysis,
      display: canonicalJson([result.snapshotId, result.scope, result.rows]),
      generation: p.generation,
    });
    return result;
  }
  async evaluateHypothesis(
    confirmed: TimelineConfirmedHypothesis,
  ): Promise<TimelineHypothesisResult> {
    this.require('t3b');
    const p = this.confirmed.get(confirmed);
    if (
      !p ||
      !confirmed.current() ||
      !p.analysis.current() ||
      p.display !== canonicalJson([confirmed.snapshotId, confirmed.scope, confirmed.rows])
    )
      throw Error('確認済みの表が変わりました。再確認してください。');
    const hypothesis = await new TimelineSemanticResolver(p.context).evaluate();
    if (!confirmed.current()) throw Error('試算中に入力が変わりました。');
    return {
      adopted: p.analysis.adopted,
      candidate: p.analysis.candidate,
      hypothesis,
      scope: structuredClone(confirmed.scope),
      rows: structuredClone(confirmed.rows),
      current: () => confirmed.current() && p.analysis.current(),
    };
  }
}
