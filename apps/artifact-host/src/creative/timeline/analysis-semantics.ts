/** Deterministic reference-Host rules. Text, map distances and dates never create facts. */
import { canonicalJson } from '@editor-platform/artifact-core';
import {
  TimelineAnalysisContext,
  exactOf,
  nodeKey,
  siteKey,
  TIMELINE_DIAGNOSTIC_RULES,
  type AnalysisNode,
  type AnalysisTable,
  type Exact,
} from './analysis-context';
import {
  convertTimelineClock,
  deriveTime,
  effectiveClock,
  rowTimeValue,
  unavailableTime,
  type TimelineCalculatedTime,
} from './time';
import { compareTimeConstraint, strictConstraintCycles } from './time-constraints';
import type { TimelineTime } from './projection';
import type { TimelineRow } from './table';
import { TL1_LIMITS } from './tl1-schema';
export type TimelineDiagnosticState =
  | 'satisfied'
  | 'contradiction'
  | 'insufficient'
  | 'undetermined'
  | 'unsupported';
export type TimelineDiagnosticKind =
  | 'single-event'
  | 'multi-event'
  | 'presence'
  | 'transfer'
  | 'disclosure'
  | 'external-event';
export interface TimelineDiagnostic {
  site: string;
  context: string;
  kind: TimelineDiagnosticKind;
  rule: string;
  state: TimelineDiagnosticState;
  reason: string;
  targets: Exact[];
  basis: { exact: Exact; candidate?: string }[];
}
export interface TimelineSemantics {
  snapshotId: string;
  scope: 'complete' | 'partial';
  story: string;
  diagnostics: TimelineDiagnostic[];
  times: { site: string; context: string; calculated: TimelineCalculatedTime }[];
  statements: {
    site: string;
    context: string;
    category: 'fact' | 'claim' | 'knowledge';
    info: string;
    mode: string;
    individual?: string;
  }[];
  disclosure: {
    occurrence: string;
    order: number;
    info: string;
    mode: 'confirmed' | 'partial' | 'misleading';
    sources: string[];
  }[];
  scenes: { site: string; context: string; state: TimelineDiagnosticState; evaluated: boolean }[];
  current(): boolean;
}
export const individual = (r: TimelineRow) =>
  `${r.cells['tl1.ind.ch']}@${r.cells['tl1.ind.origin']}`;
const group = (node: AnalysisNode, kind: string) =>
  node.table.rows.filter((r) => r.kind === kind && r.cells['tl1.subject'] === node.row.id);
const infoModes = new Set(['observe', 'told']);
export class TimelineSemanticResolver {
  private times = new Map<string, TimelineCalculatedTime>();
  /** Inputs actually resolved while calculating a time, retained in this Context only. */
  private timeInputs = new Map<string, AnalysisNode[]>();
  constructor(readonly context: TimelineAnalysisContext) {}
  get world() {
    return this.context.roots.get(this.context.links.story.worldSettings);
  }
  get composition() {
    return this.context.roots.get(this.context.links.story.composition);
  }
  worldFor(table: AnalysisTable) {
    return table.candidate
      ? this.world
      : this.context.fixed(this.context.links.story.worldSettings);
  }
  worldOf(owner: string) {
    return this.context.links.story.ledgers.find((l) => l.artifactId === owner)?.world;
  }
  clockOf(owner: string) {
    return this.world?.rows.find((r) => r.kind === 'worldline' && r.id === this.worldOf(owner))
      ?.cells['tl1.clock'] as string | undefined;
  }
  convert(time: TimelineTime, clock: string | undefined): TimelineTime | undefined {
    return convertTimelineClock(time, clock, this.world?.rows ?? []);
  }
  async time(node: AnalysisNode, path = new Set<string>()): Promise<TimelineCalculatedTime> {
    const key = nodeKey(node),
      cached = this.times.get(key);
    if (cached) return cached;
    if (path.has(key)) return unavailableTime('cycle');
    const inputs = [node];
    this.timeInputs.set(key, inputs);
    const written = rowTimeValue(node.row.cells),
      clock = effectiveClock(written.clock, this.clockOf(node.table.owner));
    let result: TimelineCalculatedTime =
      written.kind === 'unset'
        ? unavailableTime('unset')
        : { state: 'resolved', time: { ...written, ...(clock ? { clock } : {}) } };
    if (written.kind === 'derived') {
      const relation = group(node, 'derive-time')[0],
        base = relation ? await this.context.resolve(node.table, relation) : undefined;
      if (relation) inputs.push({ table: node.table, row: relation });
      if (!base) return unavailableTime('reference');
      const value = await this.time(base, new Set([...path, key]));
      inputs.push(...(this.timeInputs.get(nodeKey(base)) ?? [base]));
      if (value.state === 'unavailable') return value;
      const converted = this.convert(value.time, clock);
      result = converted ? deriveTime(converted, relation) : unavailableTime('clock');
    }
    this.times.set(key, result);
    return result;
  }
  async compare(
    subject: AnalysisNode,
    base: AnalysisNode,
    kind: 'after' | 'travel-min' = 'after',
    min = 0,
    anchor: 'start' | 'end' = 'start',
    max?: number,
  ): Promise<TimelineDiagnosticState> {
    const a = await this.time(subject),
      b = await this.time(base);
    if (a.state === 'unavailable' || b.state === 'unavailable') return 'undetermined';
    const converted = this.convert(b.time, a.time.clock);
    if (!converted) return 'undetermined';
    const r = compareTimeConstraint(a.time, converted, kind, min, anchor, max);
    return r.state === 'violated' ? 'contradiction' : r.state;
  }
  diagnostic(
    node: AnalysisNode,
    kind: TimelineDiagnosticKind,
    state: TimelineDiagnosticState,
    reason: string,
    basis: AnalysisNode[] = [node],
    targets: AnalysisNode[] = [node],
  ): TimelineDiagnostic {
    const inputs = [node, ...basis];
    // Presence consumes event clocks, not their calculated event times.
    if (kind !== 'presence')
      for (const n of [node, ...basis]) inputs.push(...(this.timeInputs.get(nodeKey(n)) ?? []));
    return {
      site: siteKey(node),
      context: node.table.candidate ?? 'adopted',
      kind,
      rule: TIMELINE_DIAGNOSTIC_RULES,
      state,
      reason,
      targets: targets.map(exactOf),
      basis: [
        ...new Map([...inputs, ...this.clockEvidence(inputs)].map((n) => [nodeKey(n), n])).values(),
      ].map((n) => ({
        exact: exactOf(n),
        ...(n.table.candidate ? { candidate: n.table.candidate } : {}),
      })),
    };
  }
  private clockEvidence(nodes: AnalysisNode[]): AnalysisNode[] {
    const world = this.world;
    if (!world) return [];
    const worlds = new Set(
      nodes.filter((n) => n.table.role === 'ledger').map((n) => this.worldOf(n.table.owner)),
    );
    const clocks = new Set(
      nodes
        .filter((n) => n.table.role === 'ledger')
        .map((n) =>
          effectiveClock(
            n.row.cells['tl1.clock'] as string | undefined,
            this.clockOf(n.table.owner),
          ),
        ),
    );
    return world.rows
      .filter(
        (row) =>
          (row.kind === 'clock' && clocks.has(row.id)) ||
          (row.kind === 'clock-offset' &&
            clocks.has(row.cells['tl1.clock'] as string) &&
            clocks.has(row.cells['tl1.clock2'] as string)) ||
          (row.kind === 'worldline' && worlds.has(row.id)),
      )
      .map((row) => ({ table: world, row }));
  }
  visible(row: TimelineRow) {
    const allowed = [row.ref, row.ref2].every(
      (r) => r?.type !== 'exact' || this.context.workbench.readable(r.artifact),
    );
    if (!allowed) this.context.unreadable = true;
    return allowed;
  }
  async transfer(
    table: AnalysisTable,
    row: TimelineRow,
    info?: string,
  ): Promise<TimelineDiagnosticState> {
    if (!this.visible(row)) {
      this.context.partial = true;
      return 'insufficient';
    }
    const from = await this.context.resolve(table, row),
      to = await this.context.resolve(table, row, 'ref2');
    if (!from || !to) return 'insufficient';
    if (!group(from, 'participant').some((r) => individual(r) === individual(row)))
      return 'contradiction';
    const carried = table.rows
      .filter((r) => r.kind === 'transfer-info' && r.cells['tl1.subject'] === row.id)
      .map((r) => String(r.cells['tl1.info']));
    if (info && !carried.includes(info)) return 'insufficient';
    if (
      (info ? [info] : carried).some(
        (i) =>
          !group(from, 'knows').some(
            (r) =>
              individual(r) === individual(row) &&
              r.cells['tl1.info'] === i &&
              infoModes.has(String(r.cells['tl1.mode'])),
          ),
      )
    )
      return 'insufficient';
    const order = await this.compare(to, from);
    return order === 'contradiction' ? 'unsupported' : order;
  }
  async informationUse(table: AnalysisTable, row: TimelineRow): Promise<TimelineDiagnostic> {
    const node = { table, row },
      subject = table.rows.find((r) => r.id === row.cells['tl1.subject']),
      base = await this.context.resolve(table, row);
    if (!subject || !base)
      return this.diagnostic(node, 'single-event', 'insufficient', '入手の根拠を確認できません。');
    const target = { table, row: subject },
      info = String(row.cells['tl1.info']);
    const acquired = group(base, 'knows').filter(
      (r) => individual(r) === individual(row) && r.cells['tl1.info'] === info,
    );
    const positive = acquired.some((r) => infoModes.has(String(r.cells['tl1.mode'])));
    if (
      !positive ||
      acquired.some((r) => ['forget', 'doubt', 'deny'].includes(String(r.cells['tl1.mode'])))
    ) {
      const old = base.table.candidate
        ? await this.context.exact({ ...exactOf(base), item: '' })
        : undefined;
      const removed = old?.rows.some(
        (r) =>
          r.kind === 'knows' &&
          r.cells['tl1.subject'] === base.row.id &&
          r.cells['tl1.info'] === info &&
          individual(r) === individual(row) &&
          infoModes.has(String(r.cells['tl1.mode'])),
      );
      return this.diagnostic(
        node,
        'single-event',
        'insufficient',
        removed
          ? '保存済み履歴にあった入手根拠がこの案から除かれています。再確認してください。'
          : '入手・認識を確定できません。記録の欠落を「知らない」と断定しません。',
        [base, target],
        [target],
      );
    }
    const world = this.worldFor(table);
    if (!world)
      return this.diagnostic(
        node,
        'single-event',
        'insufficient',
        '許可された範囲では知識の根拠を確定できません。',
        [target],
        [target],
      );
    // A transfer validates a particular arrival context, not any candidate sharing its base.
    const transfers = world.rows.filter(
      (r) =>
        r.kind === 'transfer' &&
        r.ref2?.type === 'exact' &&
        r.ref2.artifact === base.table.owner &&
        r.ref2.item === base.row.id &&
        world.rows.some(
          (x) =>
            x.kind === 'transfer-info' &&
            x.cells['tl1.subject'] === r.id &&
            x.cells['tl1.info'] === info,
        ),
    );
    const personal = transfers.filter((r) => individual(r) === individual(row));
    // F2 explicitly carries information to a different recipient. A carrier is a
    // possible provider for a told acquisition, not another individual's acquisition.
    const providers = transfers.filter(
      (r) =>
        individual(r) !== individual(row) &&
        acquired.some((a) => a.cells['tl1.mode'] === 'told') &&
        !group(base, 'knows').some(
          (a) => a.cells['tl1.info'] === info && individual(a) === individual(r),
        ),
    );
    const prerequisites = personal.length ? personal : providers;
    const checked = await Promise.all(
      prerequisites.map(async (transfer) => {
        const arrival = await this.context.resolve(world, transfer, 'ref2'),
          departure = await this.context.resolve(world, transfer);
        return {
          valid:
            !!arrival &&
            (await this.sameAcquisitionInputs(arrival, base, info)) &&
            (await this.transfer(world, transfer, info)) === 'satisfied',
          inputs: [
            { table: world, row: transfer },
            ...(departure ? [departure] : []),
            // base already represents the verified arrival; do not duplicate its old/new save context.
          ],
        };
      }),
    );
    const valid = checked.map((c) => c.valid),
      transferBasis = [base, target, ...checked.flatMap((c) => c.inputs)];
    if (valid.length && !(personal.length ? valid.every(Boolean) : valid.some(Boolean)))
      return this.diagnostic(
        node,
        'single-event',
        'insufficient',
        'この候補の到着に対応する移送根拠を確認できません。',
        transferBasis,
        [target],
      );
    // World time does not stand in for an individual's cross-world experience sequence.
    if (this.worldOf(base.table.owner) !== this.worldOf(table.owner)) {
      const xp = this.composition?.rows.find(
        (r) =>
          r.kind === 'experience' &&
          individual(r) === individual(row) &&
          r.ref?.type === 'exact' &&
          r.ref.artifact === base.table.owner &&
          r.ref.item === base.row.id &&
          r.ref2?.type === 'exact' &&
          r.ref2.artifact === table.owner &&
          r.ref2.item === subject.id,
      );
      if (!xp)
        return this.diagnostic(
          node,
          'single-event',
          'insufficient',
          '人物の経験順が未設定です。世界の日付から補いません。',
          transferBasis,
          [target],
        );
      const experience = { table: this.composition!, row: xp };
      const from = await this.context.resolve(this.composition!, xp),
        to = await this.context.resolve(this.composition!, xp, 'ref2');
      const compatible = (saved: AnalysisNode, actual: AnalysisNode) =>
        saved.table.owner === actual.table.owner &&
        saved.row.id === actual.row.id &&
        ['participant', 'knows'].every(
          (kind) =>
            canonicalJson(group(saved, kind).filter((r) => individual(r) === individual(row))) ===
            canonicalJson(group(actual, kind).filter((r) => individual(r) === individual(row))),
        );
      // Experience uses identity/individual/knowledge, not calendar time. Preserve U1's
      // time-only independence while rejecting unavailable or incompatible contexts.
      if (!from || !to || !compatible(from, base) || !compatible(to, target))
        return this.diagnostic(
          node,
          'single-event',
          'insufficient',
          '明示経験順の両保存版または人物・知識の根拠を確認できません。',
          [...transferBasis, experience],
          [target],
        );
      const order = await this.compare(target, base);
      return this.diagnostic(
        node,
        'single-event',
        order === 'contradiction' ? 'unsupported' : order,
        '世界をまたぐ明示経験順。時間旅行の知識計算は未対応です。',
        [...transferBasis, experience],
        [target],
      );
    }
    let state = await this.compare(target, base);
    if (state === 'contradiction' && row.cells['tl1.complete'] !== true) state = 'insufficient';
    return this.diagnostic(
      node,
      'single-event',
      state,
      state === 'contradiction'
        ? '明示された完全な入手履歴より前に情報を使っています。'
        : state === 'satisfied'
          ? '明示された入手時点より後です。'
          : '時点・時計・精度が足りません。',
      transferBasis,
      [target],
    );
  }
  private async sameAcquisitionInputs(a: AnalysisNode, b: AnalysisNode, info: string) {
    if (nodeKey(a) === nodeKey(b)) return true;
    if (a.table.owner !== b.table.owner || a.row.id !== b.row.id) return false;
    const ta = await this.time(a),
      tb = await this.time(b);
    // Changing only a derivation to the same explicit time keeps acquisition valid.
    // Different derived times or individual/knowledge inputs never borrow the old endpoint.
    return (
      ta.state === 'resolved' &&
      tb.state === 'resolved' &&
      canonicalJson(ta) === canonicalJson(tb) &&
      canonicalJson(group(a, 'knows').filter((r) => r.cells['tl1.info'] === info)) ===
        canonicalJson(group(b, 'knows').filter((r) => r.cells['tl1.info'] === info))
    );
  }
  async movement(from: AnalysisNode, to: AnalysisNode, person: string) {
    for (const row of group(to, 'travel-min').filter((r) => individual(r) === person)) {
      const base = await this.context.resolve(to.table, row);
      if (base && base.table.owner === from.table.owner && base.row.id === from.row.id)
        return this.diagnostic(
          { table: to.table, row },
          'multi-event',
          await this.compare(to, base, 'travel-min', Number(row.cells['tl1.offset.min'])),
          '作者が明示した最低日数だけを検査します。',
          [base, to],
          [base, to],
        );
    }
    return this.diagnostic(
      to,
      'multi-event',
      'insufficient',
      '最低移動日数の根拠が未登録です。地名・距離から推測しません。',
      [from, to],
      [from, to],
    );
  }
  private constraintCycles = new Map<string, Set<string>>();
  async constraintState(table: AnalysisTable, row: TimelineRow): Promise<TimelineDiagnosticState> {
    let cycles = this.constraintCycles.get(table.key);
    if (!cycles) {
      cycles = strictConstraintCycles(table.rows, this.clockOf(table.owner));
      this.constraintCycles.set(table.key, cycles);
    }
    if (cycles.has(row.id)) return 'contradiction';
    const base = await this.context.resolve(table, row),
      subject = table.rows.find((r) => r.id === row.cells['tl1.subject']);
    return base && subject
      ? this.compare(
          { table, row: subject },
          base,
          row.kind as 'after' | 'travel-min',
          Number(row.cells['tl1.offset.min'] ?? 0),
          row.cells['tl1.anchor'] === 'end' ? 'end' : 'start',
          row.cells['tl1.offset.max'] as number | undefined,
        )
      : 'insufficient';
  }
  async evaluate(): Promise<TimelineSemantics> {
    const c = this.context,
      diagnostics: TimelineDiagnostic[] = [],
      times: TimelineSemantics['times'] = [],
      statements: TimelineSemantics['statements'] = [],
      scenes: TimelineSemantics['scenes'] = [];
    const inspect = async (table: AnalysisTable) => {
      for (const row of table.rows) {
        const node = { table, row };
        if (!this.visible(row)) {
          c.partial = true;
          continue;
        }
        if (row.kind === 'event')
          times.push({
            site: siteKey(node),
            context: table.candidate ?? 'adopted',
            calculated: await this.time(node),
          });
        if (row.kind === 'info-use') diagnostics.push(await this.informationUse(table, row));
        if (['fact', 'claim', 'knows'].includes(row.kind))
          statements.push({
            site: siteKey(node),
            context: table.candidate ?? 'adopted',
            category: row.kind === 'knows' ? 'knowledge' : (row.kind as 'fact' | 'claim'),
            info: String(row.cells['tl1.info']),
            mode: String(row.cells['tl1.mode']),
            ...(row.kind === 'fact' ? {} : { individual: individual(row) }),
          });
        if (row.kind === 'after' || row.kind === 'travel-min') {
          const state = await this.constraintState(table, row);
          const base = await c.resolve(table, row),
            subject = table.rows.find((r) => r.id === row.cells['tl1.subject']);
          const target = subject ? { table, row: subject } : undefined;
          diagnostics.push(
            this.diagnostic(
              node,
              'multi-event',
              state,
              '作者が記録した時間制約。時点は自動修正しません。',
              base && target ? [base, target] : [node],
            ),
          );
        }
      }
    };
    for (const table of c.roots.values()) if (table.role === 'ledger') await inspect(table);
    if (this.world)
      for (const row of this.world.rows.filter((r) => r.kind === 'transfer')) {
        if (!this.visible(row)) {
          c.partial = true;
          continue;
        }
        const from = await c.resolve(this.world, row),
          to = await c.resolve(this.world, row, 'ref2');
        diagnostics.push(
          this.diagnostic(
            { table: this.world, row },
            'transfer',
            await this.transfer(this.world, row),
            '明示された個体・運ぶ情報・両端点を検査します。',
            [from, to].filter((n): n is AnalysisNode => !!n),
          ),
        );
      }
    if (this.composition)
      for (const row of this.composition.rows.filter((r) => r.kind === 'experience')) {
        if (!this.visible(row)) {
          c.partial = true;
          continue;
        }
        const from = await c.resolve(this.composition, row),
          to = await c.resolve(this.composition, row, 'ref2');
        if (from && to && (await this.compare(to, from)) === 'contradiction')
          diagnostics.push(
            this.diagnostic(
              { table: this.composition, row },
              'multi-event',
              'unsupported',
              '時間旅行の経験順を保持しています。未来の記憶だけで矛盾とはしません。',
              [from, to],
            ),
          );
      }
    const presence = [...c.roots.values()]
      .filter((t) => t.role === 'ledger')
      .flatMap((table) =>
        table.rows.filter((r) => r.kind === 'presence').map((row) => ({ table, row })),
      );
    let presenceBytes = 0;
    for (let i = 0; i < presence.length; i++)
      for (let j = i + 1; j < presence.length; j++) {
        const a = presence[i],
          b = presence[j],
          av = a.row.cells,
          bv = b.row.cells;
        if (
          individual(a.row) !== individual(b.row) ||
          this.worldOf(a.table.owner) !== this.worldOf(b.table.owner)
        )
          continue;
        const loc = String(av['tl1.loc']),
          loc2 = String(bv['tl1.loc']);
        const pair = (r: TimelineRow) =>
          [loc, loc2].includes(String(r.cells['tl1.loc'])) &&
          [loc, loc2].includes(String(r.cells['tl1.loc2']));
        // Capture the entire matching rule set, including an empty set. Additions/removals
        // must change exception evidence even when the presence rows stay unchanged.
        const places =
          this.world?.rows.filter(
            (r) => ['location-exclusive', 'location-contains'].includes(r.kind) && pair(r),
          ) ?? [];
        const exclusive =
          places.some((r) => r.kind === 'location-exclusive') &&
          !places.some((r) => r.kind === 'location-contains');
        const eventA = a.table.rows.find((r) => r.id === av['tl1.subject']),
          eventB = b.table.rows.find((r) => r.id === bv['tl1.subject']);
        const events = [
          ...(eventA ? [{ table: a.table, row: eventA }] : []),
          ...(eventB ? [{ table: b.table, row: eventB }] : []),
        ];
        const clockA = effectiveClock(
            eventA?.cells['tl1.clock'] as string | undefined,
            this.clockOf(a.table.owner),
          ),
          clockB = effectiveClock(
            eventB?.cells['tl1.clock'] as string | undefined,
            this.clockOf(b.table.owner),
          );
        const converted = this.convert(
          {
            kind: 'interval',
            start: Number(bv['tl1.time.start']),
            end: Number(bv['tl1.time.end']),
            clock: clockB,
          },
          clockA,
        );
        const certain =
          !!converted &&
          !!eventA &&
          !!eventB &&
          exclusive &&
          av['tl1.certainty'] === 'confirmed' &&
          bv['tl1.certainty'] === 'confirmed' &&
          av['tl1.time.kind'] === 'interval' &&
          bv['tl1.time.kind'] === 'interval';
        const overlap =
          certain &&
          Number(av['tl1.time.start']) < converted!.end! &&
          converted!.start! < Number(av['tl1.time.end']);
        diagnostics.push(
          this.diagnostic(
            a,
            'presence',
            certain ? (overlap ? 'contradiction' : 'satisfied') : 'insufficient',
            certain
              ? '同じ世界・個体の排他的な確定在場区間を比較します。'
              : '排他・確度・区間の前提が足りません。',
            [a, b, ...events, ...places.map((row) => ({ table: this.world!, row }))],
            events,
          ),
        );
        presenceBytes += new TextEncoder().encode(canonicalJson(diagnostics.at(-1))).byteLength;
        if (presenceBytes > TL1_LIMITS.projectionBytes)
          throw Error('在場の診断結果が容量上限を超えます。範囲を分けてください。');
      }
    for (const table of c.roots.values())
      if (table.role === 'scene-cards')
        for (const scene of table.rows.filter((r) => r.kind === 'scene')) {
          const cites = table.rows.filter(
              (r) => r.kind === 'cite' && r.cells['tl1.subject'] === scene.id,
            ),
            states: TimelineDiagnosticState[] = [];
          let evaluated = false;
          for (const cite of cites) {
            if (!this.visible(cite)) {
              c.partial = true;
              continue;
            }
            const event = await c.resolve(table, cite);
            if (!event) continue;
            for (const use of group(event, 'info-use'))
              states.push((await this.informationUse(event.table, use)).state);
            if (event.table.candidate) evaluated = true;
          }
          scenes.push({
            site: `${table.owner}#${scene.id}`,
            context: table.candidate ?? 'adopted',
            state: states.includes('contradiction')
              ? 'contradiction'
              : states.includes('insufficient')
                ? 'insufficient'
                : states.includes('undetermined')
                  ? 'undetermined'
                  : states.includes('unsupported')
                    ? 'unsupported'
                    : states.length
                      ? 'satisfied'
                      : 'insufficient',
            evaluated,
          });
        }
    const disclosure: TimelineSemantics['disclosure'] = [],
      known = new Map<
        string,
        { mode: 'confirmed' | 'partial' | 'misleading'; sources: string[] }
      >();
    const evidence = c.request.disclosureEvidence,
      usedEvidence = new Set<number>();
    if (evidence?.some((e) => !c.workbench.readable(e.source.artifact))) {
      c.unreadable = true;
      c.partial = true;
    }
    if (this.composition)
      for (const occurrence of this.composition.rows
        .filter((r) => r.kind === 'occurrence')
        .sort((a, b) => Number(a.cells['tl1.order']) - Number(b.cells['tl1.order']))) {
        const sc = await c.resolve(this.composition, occurrence);
        if (!sc) continue;
        for (const cite of sc.table.rows.filter(
          (r) => r.kind === 'cite' && r.cells['tl1.subject'] === sc.row.id,
        )) {
          const ev = await c.resolve(sc.table, cite);
          if (!ev) continue;
          for (const row of ev.table.rows.filter(
            (r) =>
              r.cells['tl1.subject'] === ev.row.id && ['claim', 'fact', 'knows'].includes(r.kind),
          )) {
            const info = String(row.cells['tl1.info']);
            if (cite.ref?.facet === 'info' && cite.cells['tl1.info'] !== info) continue;
            if (cite.ref?.facet && !['whole', 'content', 'info'].includes(cite.ref.facet)) continue;
            const selections = evidence?.flatMap((e, i) =>
              e.occurrence === occurrence.id &&
              !ev.table.candidate &&
              e.source.artifact === ev.table.owner &&
              e.source.version === ev.table.version &&
              e.source.hash === ev.table.hash &&
              e.source.item === row.id
                ? [{ e, i }]
                : [],
            );
            if (selections && selections.length === 0) continue;
            if (selections && selections.length > 1)
              throw Error('同じ開示の根拠を二重に指定できません。');
            if (selections?.[0]) usedEvidence.add(selections[0].i);
            const mode = selections?.[0]?.e.mode ?? (row.kind === 'fact' ? 'confirmed' : 'partial');
            const prior = known.get(info);
            known.set(info, {
              mode: prior?.mode === 'confirmed' ? 'confirmed' : mode,
              sources: [...new Set([...(prior?.sources ?? []), `${ev.table.owner}#${row.id}`])],
            });
          }
        }
        for (const [info, value] of known)
          disclosure.push({
            occurrence: occurrence.id,
            order: Number(occurrence.cells['tl1.order']),
            info,
            ...value,
          });
      }
    if (evidence && usedEvidence.size !== evidence.length && !c.unreadable)
      throw Error(
        '開示の根拠は、その提示位置が引用する固定版の発言・事実・認識に限定してください。',
      );
    c.assertBudget({ diagnostics, times, statements, scenes, disclosure });
    c.assertCurrent();
    if (c.unreadable)
      return {
        snapshotId: c.snapshotId,
        scope: 'partial',
        story: c.links.story.id,
        diagnostics: [],
        times: [],
        statements: [],
        disclosure: [],
        scenes: [],
        current: () => c.current(),
      };
    return {
      snapshotId: c.snapshotId,
      scope: c.partial ? 'partial' : 'complete',
      story: c.links.story.id,
      diagnostics,
      times,
      statements,
      disclosure,
      scenes,
      current: () => c.current(),
    };
  }
}
export const semanticSignature = (r: TimelineDiagnostic) => canonicalJson([r.state, r.reason]);
