import { describe, expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { fixture, owdCheck, owdFixtures, sampleDefinition } from './fixtures';
import {
  applyWorkflowDefinitionIntents as apply,
  mapCheckResults,
  readOwdDefinition,
  structureDiagnostics,
  workflowDefinitionCommand,
  workflowDefinitionDiagnostics,
  workflowDefinitionReferrers,
  type OwdDefinition,
  type OwdSection,
  type WorkflowDefinitionIntent,
} from './index';

const phase = (d: OwdDefinition, id: string) => d.phases.find((p) => p.id === id)!;
const sectionsOf = (d: OwdDefinition) => d.sections as OwdSection[];

describe('the pinned OWD fixtures', () => {
  it.each(Object.keys(owdFixtures))(
    '%s reads, passes the OWD check and has no structure problems',
    (id) => {
      const d = fixture(id);
      expect(readOwdDefinition(d)).toBe(d);
      expect(owdCheck(d)).toEqual([]);
      expect(structureDiagnostics(d)).toEqual([]);
    },
  );
  it('the sample definition passes the OWD check', () => {
    expect(owdCheck(sampleDefinition())).toEqual([]);
  });
  it('keeps the shared ID concept apart as a phase and an item kind', () => {
    const d = fixture('product-design-engineering');
    expect(d.phases.some((p) => p.id === 'concept')).toBe(true);
    expect((d.items as { id: string }[]).some((i) => i.id === 'concept')).toBe(true);
    // Another item kind may take a phase's ID; another phase may not take a deliverable's.
    const next = apply(d, [
      { type: 'add', kind: 'item', id: 'process', fields: { name: 'x', idForm: 'X-{nn}' } },
    ]);
    expect((next.items as { id: string }[]).some((i) => i.id === 'process')).toBe(true);
    expect(() => apply(d, [{ type: 'add', kind: 'phase', id: 'process-map' }])).toThrow(
      /already used/,
    );
  });
});

describe('editing keeps what it does not touch', () => {
  it.each(Object.keys(owdFixtures))('%s: an unrelated edit changes one field only', (id) => {
    const d = fixture(id),
      first = d.phases[0].id;
    const next = apply(d, [
      { type: 'set-fields', kind: 'phase', id: first, fields: { name: '新しい名前' } },
    ]);
    const expected = clone(d);
    expected.phases[0].name = '新しい名前';
    expect(canonicalJson(next)).toBe(canonicalJson(expected));
    // Multi-target rules, gates, placements and views stay exactly as they were.
    for (const key of ['rules', 'gates', 'placements', 'items', 'roles', 'sections'])
      expect(canonicalJson(next[key] ?? null)).toBe(canonicalJson(d[key] ?? null));
    expect(owdCheck(next)).toEqual([]);
  });
  it('keeps fields of a later format and refuses non-JSON input', () => {
    const d = sampleDefinition() as OwdDefinition & { future?: unknown };
    d.future = { kept: true };
    d.phases[0].extra = 'kept';
    const next = apply(d, [{ type: 'set-definition', fields: { title: '別の題' } }]);
    expect(next.future).toEqual({ kept: true });
    expect(next.phases[0].extra).toBe('kept');
    expect(() => readOwdDefinition({ ...d, format: 2 })).toThrow(/format is not 1/);
    expect(() => readOwdDefinition({ ...d, phases: [{ id: 'x', after: 'research' }] })).toThrow(
      /after has the wrong type/,
    );
    const getter = { ...d };
    Object.defineProperty(getter, 'title', { get: () => 'x', enumerable: true });
    expect(() => readOwdDefinition(getter)).toThrow(/not JSON data/);
  });
});

describe('structure checks', () => {
  it('refuses an edit that adds a problem and changes nothing', () => {
    const d = sampleDefinition(),
      before = canonicalJson(d);
    for (const intents of [
      [{ type: 'add', kind: 'phase', id: 'Bad ID' }],
      [{ type: 'add', kind: 'phase', id: 'research' }],
      [{ type: 'set-fields', kind: 'phase', id: 'plan', fields: { after: ['missing'] } }],
      [{ type: 'set-fields', kind: 'phase', id: 'plan', fields: { name: 5 } }],
      [{ type: 'set-fields', kind: 'acceptance', id: 'plan.ok', fields: { checkedBy: 'robot' } }],
      [{ type: 'set-fields', kind: 'phase', id: 'plan', fields: { name: null } }],
      [{ type: 'set-fields', kind: 'phase', id: 'plan', fields: { unknown: 1 } }],
      [{ type: 'set-fields', kind: 'rule', id: 'req-cites-fact', fields: { min: 2 } }],
      [{ type: 'set-definition', fields: { id: 'Not An ID' } }],
      // One bad intent refuses the whole batch.
      [
        { type: 'set-fields', kind: 'phase', id: 'plan', fields: { name: 'ok' } },
        { type: 'delete', kind: 'phase', id: 'missing' },
      ],
    ] as WorkflowDefinitionIntent[][])
      expect(() => apply(d, intents)).toThrow();
    expect(canonicalJson(d)).toBe(before);
  });
  it('keeps an existing broken reference and allows unrelated edits and its repair', () => {
    const d = sampleDefinition();
    d.phases[1].after = ['gone'];
    expect(structureDiagnostics(d).map((x) => x.code)).toEqual(['missing-reference']);
    const renamed = apply(d, [
      { type: 'set-fields', kind: 'phase', id: 'research', fields: { name: '調査' } },
    ]);
    expect(renamed.phases[1].after).toEqual(['gone']);
    const fixed = apply(d, [
      { type: 'set-fields', kind: 'phase', id: 'plan', fields: { after: ['research'] } },
    ]);
    expect(structureDiagnostics(fixed)).toEqual([]);
  });
  it('repairs one of several broken references even when the list shifts', () => {
    const d = sampleDefinition();
    d.phases[1].after = ['missing-a', 'missing-b'];
    const partly = apply(d, [
      { type: 'set-fields', kind: 'phase', id: d.phases[1].id, fields: { after: ['missing-b'] } },
    ]);
    expect(partly.phases[1].after).toEqual(['missing-b']);
    // Adding a second copy of a broken reference is still a new problem.
    expect(() =>
      apply(d, [
        {
          type: 'set-fields',
          kind: 'phase',
          id: d.phases[1].id,
          fields: { after: ['missing-a', 'missing-b', 'missing-b'] },
        },
      ]),
    ).toThrow(/does not exist/);
  });
  it('renames an element that already has a problem', () => {
    const d = sampleDefinition();
    d.phases[1].after = ['missing'];
    const next = apply(d, [
      { type: 'rename-id', kind: 'phase', id: d.phases[1].id, to: 'renamed' },
    ]);
    expect(next.phases[1]).toMatchObject({ id: 'renamed', after: ['missing'] });
  });
  it('reports every phase of overlapping cycles', () => {
    const d = sampleDefinition();
    const [a, b, c] = d.phases;
    a.after = [b.id, c.id];
    b.after = [a.id];
    c.after = [b.id];
    expect(
      workflowDefinitionDiagnostics(d)
        .filter((x) => x.code === 'phase-cycle')
        .map((x) => x.target?.id)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort());
  });
  it('allows a cyclic draft and reports the cycle without blocking', () => {
    const d = apply(sampleDefinition(), [
      { type: 'set-fields', kind: 'phase', id: 'research', fields: { after: ['review'] } },
    ]);
    const all = workflowDefinitionDiagnostics(d, owdCheck);
    expect(
      all
        .filter((x) => x.code === 'phase-cycle')
        .map((x) => x.target?.id)
        .sort(),
    ).toEqual(['plan', 'research', 'review']);
    expect(all.some((x) => x.source === 'check' && /循環/.test(x.message))).toBe(true);
    expect(all.every((x) => x.code !== 'phase-cycle' || !x.blocking)).toBe(true);
  });
  it('says when the Host has no check', () => {
    expect(workflowDefinitionDiagnostics(sampleDefinition()).map((x) => x.code)).toEqual([
      'no-check',
    ]);
  });
});

describe('add, delete, rename and move', () => {
  it('needs cascade to delete a used deliverable and then removes its references and acceptance', () => {
    const d = sampleDefinition();
    expect(workflowDefinitionReferrers(d, { kind: 'deliverable', id: 'notes' })).toEqual([
      { kind: 'phase', id: 'research' },
      { kind: 'deliverable', id: 'plan-doc' },
      { kind: 'acceptance', id: 'notes.ok' },
    ]);
    expect(() => apply(d, [{ type: 'delete', kind: 'deliverable', id: 'notes' }])).toThrow(
      /cascade/,
    );
    const next = apply(d, [{ type: 'delete', kind: 'deliverable', id: 'notes', cascade: true }]);
    expect(phase(next, 'research').deliverables).toEqual([]);
    expect(phase(next, 'research').acceptance).toEqual([]);
    expect(next.acceptance.map((a) => a.id)).toEqual(['plan.ok']);
    expect(next.deliverables[0].uses).toEqual([]);
    expect(structureDiagnostics(next)).toEqual([]);
  });
  it('removes a phase from the order and its section in the same edit', () => {
    const next = apply(sampleDefinition(), [{ type: 'delete', kind: 'phase', id: 'plan' }]);
    expect(phase(next, 'review').after).toEqual([]);
    expect(next.sections).toEqual([
      { id: 'early', name: '前半', phases: ['research'] },
      { id: 'late', name: '後半', phases: ['review'] },
    ]);
  });
  it('deletes a used rule or role with cascade only', () => {
    const d = sampleDefinition();
    expect(() => apply(d, [{ type: 'delete', kind: 'rule', id: 'fact-covered' }])).toThrow(
      /cascade/,
    );
    const rule = apply(d, [{ type: 'delete', kind: 'rule', id: 'fact-covered', cascade: true }]);
    expect(rule.acceptance[1].rules).toEqual(['req-cites-fact']);
    const role = apply(d, [{ type: 'delete', kind: 'role', id: 'lead', cascade: true }]);
    expect(role.acceptance[1].approvers).toEqual({ roles: [] });
    // An item kind takes the rules that start from it, and the outline mark, with it.
    const item = apply(d, [{ type: 'delete', kind: 'item', id: 'fact', cascade: true }]);
    expect((item.rules as { id: string; to?: string[] }[]).map((r) => [r.id, r.to])).toEqual([
      ['req-cites-fact', []],
    ]);
    expect(item.acceptance[1].rules).toEqual(['req-cites-fact']);
    expect(item.deliverables[0].outline[0].item).toBeUndefined();
  });
  it('renames an ID everywhere it is used, as one edit', () => {
    const d = sampleDefinition();
    const next = apply(d, [{ type: 'rename-id', kind: 'phase', id: 'plan', to: 'design' }]);
    expect(phase(next, 'review').after).toEqual(['design']);
    expect(sectionsOf(next)[0].phases).toEqual(['research', 'design']);
    const item = apply(d, [{ type: 'rename-id', kind: 'item', id: 'fact', to: 'source' }]);
    expect(item.rules).toEqual([
      { id: 'req-cites-fact', type: 'cites', from: 'req', to: ['source'], min: 1 },
      { id: 'fact-covered', type: 'covered', of: 'source', by: ['req'] },
    ]);
    expect(item.deliverables[0].outline[0].item).toBe('source');
    expect(owdCheck(item)).toEqual([]);
    expect(() => apply(d, [{ type: 'rename-id', kind: 'phase', id: 'plan', to: 'notes' }])).toThrow(
      /already used/,
    );
  });
  it('renames and deletes through gates and placements too', () => {
    const d = fixture('editor-development');
    expect(owdCheck(d)).toEqual([]);
    const gated = (d.gates as { phases?: string[] }[]).find((g) => g.phases?.length)!.phases![0];
    const path = Object.keys(
      (d.placements as { paths?: Record<string, string> }[]).find((p) => p.paths)!.paths!,
    )[0];
    const renamed = apply(d, [
      { type: 'rename-id', kind: 'phase', id: gated, to: 'renamed-phase' },
      { type: 'rename-id', kind: 'deliverable', id: path, to: 'renamed-deliverable' },
    ]);
    expect(owdCheck(renamed)).toEqual([]);
    expect(JSON.stringify([renamed.gates, renamed.placements])).not.toMatch(
      new RegExp(`"${gated}"`),
    );
    const keys = (x: OwdDefinition) =>
      (x.placements as { paths?: Record<string, string> }[]).map((p) => Object.keys(p.paths ?? {}));
    expect(keys(renamed)).toEqual(
      keys(d).map((k) => k.map((id) => (id === path ? 'renamed-deliverable' : id))),
    );
    const removed = apply(d, [
      { type: 'delete', kind: 'phase', id: gated, cascade: true },
      { type: 'delete', kind: 'deliverable', id: path, cascade: true },
    ]);
    const text = JSON.stringify([removed.gates, removed.placements]);
    expect(text).not.toMatch(new RegExp(`"${gated}"`));
    expect(text).not.toMatch(new RegExp(`"${path}"`));
    // No gate is left with an empty phase list, which would widen it to every phase.
    expect(text).not.toMatch(/"phases":\[\]/);
  });
  it('follows item kinds named by deliverable views through rename and delete', () => {
    const d = fixture('editor-development');
    const renamed = apply(d, [
      { type: 'rename-id', kind: 'item', id: 'capability', to: 'feature' },
    ]);
    expect(owdCheck(renamed)).toEqual([]);
    expect(JSON.stringify(renamed.deliverables)).not.toMatch(/"capability"/);
    // A view that loses its item kind goes with it, so no view is left pointing at nothing.
    const removed = apply(d, [{ type: 'delete', kind: 'item', id: 'capability', cascade: true }]);
    expect(removed.deliverables.find((x) => x.id === 'capability-matrix')?.view).toBeUndefined();
    expect(owdCheck(removed).filter((m) => /view/.test(m))).toEqual([]);
  });
  it('refuses an outline item that is not a string', () => {
    const d = fixture('editor-development');
    const outline = clone(d.deliverables[0].outline) as { item?: unknown }[];
    outline[0].item = 42;
    expect(() =>
      apply(d, [
        {
          type: 'set-fields',
          kind: 'deliverable',
          id: d.deliverables[0].id,
          fields: { outline: outline as never },
        },
      ]),
    ).toThrow(/heading/);
  });
  it('adds at an index and moves within the order', () => {
    const d = sampleDefinition();
    const next = apply(d, [
      {
        type: 'add',
        kind: 'phase',
        id: 'scope',
        fields: { name: '範囲', purpose: '範囲を決める' },
        index: 1,
      },
      { type: 'move', kind: 'phase', id: 'review', index: 0 },
    ]);
    expect(next.phases.map((p) => p.id)).toEqual(['review', 'research', 'scope', 'plan']);
    expect(phase(next, 'scope')).toEqual({
      id: 'scope',
      name: '範囲',
      purpose: '範囲を決める',
      after: [],
      deliverables: [],
      acceptance: [],
    });
  });
});

describe('rules are edited per rule ID', () => {
  it('keeps a multi-target rule as one rule through unrelated edits and set-rule', () => {
    const d = fixture('product-design-engineering');
    const before = (d.rules as { id: string }[]).find((r) => r.id === 'requirement-cites-source');
    expect(before).toEqual({
      id: 'requirement-cites-source',
      type: 'cites',
      from: 'requirement',
      to: ['use-case', 'regulation', 'benchmark'],
      min: 1,
    });
    const next = apply(d, [
      {
        type: 'set-rule',
        id: 'requirement-cites-source',
        rule: { type: 'cites', from: 'requirement', to: ['use-case', 'regulation'], min: 1 },
      },
    ]);
    const rules = next.rules as { id: string }[];
    expect(rules.find((r) => r.id === 'requirement-cites-source')).toEqual({
      id: 'requirement-cites-source',
      type: 'cites',
      from: 'requirement',
      to: ['use-case', 'regulation'],
      min: 1,
    });
    expect(rules.length).toBe((d.rules as unknown[]).length);
    expect(owdCheck(next)).toEqual([]);
  });
  it('refuses a second cites rule for the same pair but allows overlapping covered rules', () => {
    const d = sampleDefinition();
    expect(() =>
      apply(d, [
        {
          type: 'add',
          kind: 'rule',
          id: 'req-cites-fact-2',
          fields: { type: 'cites', from: 'req', to: ['fact'], min: 0 },
        },
      ]),
    ).toThrow(/one rule per pair/);
    const next = apply(d, [
      {
        type: 'add',
        kind: 'rule',
        id: 'fact-covered-2',
        fields: { type: 'covered', of: 'fact', by: ['req'] },
      },
      {
        type: 'set-fields',
        kind: 'acceptance',
        id: 'plan.ok',
        fields: { rules: ['req-cites-fact', 'fact-covered', 'fact-covered-2'] },
      },
    ]);
    expect(owdCheck(next)).toEqual([]);
    const edited = apply(next, [
      {
        type: 'set-rule',
        id: 'fact-covered-2',
        rule: { type: 'covered', of: 'fact', by: ['req'], exempt: true },
      },
    ]);
    expect(owdCheck(edited)).toEqual([]);
  });
});

describe('the command', () => {
  it('refuses a read-only definition and a changed base', () => {
    const d = sampleDefinition();
    expect(() =>
      workflowDefinitionCommand([{ type: 'delete', kind: 'phase', id: 'plan' }], {
        readOnly: true,
      }),
    ).toThrow(/read only/);
    const cmd = workflowDefinitionCommand([{ type: 'delete', kind: 'phase', id: 'plan' }], {
      base: d,
    });
    expect(cmd.apply(d).phases).toHaveLength(2);
    const changed = apply(d, [{ type: 'set-definition', fields: { title: 'x' } }]);
    expect(() => cmd.apply(changed)).toThrow(/changed/);
  });
});

describe('OWD check results', () => {
  it('maps sentences by their leading word and ID, and schema failures by JSON Pointer', () => {
    const d = sampleDefinition();
    d.phases[2].acceptance = [];
    (d.phases[0] as { name: unknown }).name = 5;
    const messages = owdCheck(d);
    expect(messages).toEqual([
      '/phases/0/name: must be string',
      '/phases/2/acceptance: must NOT have fewer than 1 items',
    ]);
    expect(mapCheckResults(d, messages).map((x) => [x.target, x.path])).toEqual([
      [{ kind: 'phase', id: 'research' }, ['name']],
      [{ kind: 'phase', id: 'review' }, ['acceptance']],
    ]);
    const semantic = sampleDefinition();
    semantic.phases[2].acceptance = ['notes.ok'];
    const found = owdCheck(semantic);
    expect(found).toEqual(['工程 review: 達成条件 notes.ok の対象 notes がこの工程の成果物でない']);
    expect(mapCheckResults(semantic, found)[0].target).toEqual({ kind: 'phase', id: 'review' });
  });
  it('keeps sentences it cannot read, or about unknown elements, on the whole definition', () => {
    const d = sampleDefinition();
    const mapped = mapCheckResults(d, [
      '親の無い項目の idForm が重なっている',
      '工程 nowhere: 成果物が無い',
      '/: must be object',
    ]);
    expect(mapped.map((x) => x.target)).toEqual([undefined, undefined, undefined]);
    expect(mapped.map((x) => x.message)).toEqual([
      '親の無い項目の idForm が重なっている',
      '工程 nowhere: 成果物が無い',
      '/: must be object',
    ]);
  });
});
