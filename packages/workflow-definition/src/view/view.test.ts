import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { GraphBinding } from '@editor-platform/structured-graph/model';
import { createOwdGraphAdapter, type OwdDefinition } from '../model';
import { owdCheck, sampleDefinition } from '../model/fixtures';
import {
  WorkflowDefinitionSurface,
  type WorkflowDefinitionProposal,
  type WorkflowDefinitionTab,
  type WorkflowMindmapConnection,
} from './index';

function render(
  tab: WorkflowDefinitionTab,
  options: {
    definition?: OwdDefinition;
    readOnly?: boolean;
    checked?: boolean;
    baseline?: OwdDefinition;
    mindmap?: WorkflowMindmapConnection;
    proposal?: WorkflowDefinitionProposal;
  } = {},
) {
  const source = options.definition ?? sampleDefinition();
  const binding = new GraphBinding<OwdDefinition>({
    adapter: createOwdGraphAdapter({ check: options.checked === false ? undefined : owdCheck }),
    sourceId: 'definition',
    read: () => ({ content: source, revision: '1', readOnly: !!options.readOnly }),
    execute: () => undefined,
  });
  return renderToStaticMarkup(
    createElement(WorkflowDefinitionSurface, {
      binding,
      revision: '1',
      check: options.checked === false ? undefined : owdCheck,
      baseline: options.baseline,
      initialTab: tab,
      mindmap: options.mindmap,
      proposal: options.proposal,
    }),
  );
}

describe('the workflow definition Surface', () => {
  it('lists every phase, deliverable, acceptance and role', () => {
    const html = render('lists');
    const d = sampleDefinition();
    for (const p of d.phases) expect(html).toContain(p.name);
    for (const x of d.deliverables) expect(html).toContain(x.name);
    for (const a of d.acceptance) expect(html).toContain(a.id);
    expect(html).toContain('リーダー');
  });
  it('draws the matrices with their pairs', () => {
    const html = render('matrix');
    expect(html).toContain('req-cites-fact');
    expect(html).toContain('fact-covered');
    for (const p of sampleDefinition().phases) expect(html).toContain(`>${p.id}</th>`);
  });
  it('shows the definition fields and the read-only gates', () => {
    const html = render('info');
    expect(html).toContain('sample-plan');
    expect(html).toContain('npm run lint');
  });
  it('shows changes from the baseline', () => {
    const baseline = sampleDefinition();
    const d = clone(baseline);
    d.phases[0].name = '新しい名前';
    const html = render('changes', { definition: d, baseline });
    expect(html).toMatch(new RegExp(`変更</span><button[^>]*>工程 ${d.phases[0].id}<`));
    expect(render('changes', { baseline })).toContain('版から変わっていません');
    // Without a baseline there is no changes tab.
    expect(render('changes')).not.toContain('差分');
  });
  it('says when the Host gives no check, and shows structure problems', () => {
    // Without a check, the one diagnostic says the definition is not checked.
    expect(render('lists', { checked: false })).toContain('診断 1 件');
    expect(render('lists')).toContain('診断 0 件');
    const d = sampleDefinition();
    d.phases[1].after = ['gone'];
    expect(render('lists', { definition: d })).toMatch(/構造の問題 1/);
  });
  it('has no edit controls when read only', () => {
    const html = render('lists', { readOnly: true });
    expect(html).toContain('読み取り専用');
    expect(html).not.toMatch(/<button[^>]*>削除/);
    expect(html).not.toMatch(/aria-label="New element ID"(?![^>]*disabled)/);
  });
  it('shows Mind Map branches with their link state only when the Host connects one', () => {
    const mindmap: WorkflowMindmapConnection = {
      branches: [
        {
          nodeId: 'a',
          title: '調べる',
          link: { namespace: 'owd:sample-plan', id: 'phase:research' },
        },
        { nodeId: 'b', title: '消えた', link: { namespace: 'owd:sample-plan', id: 'phase:gone' } },
        { nodeId: 'c', title: '未対応' },
      ],
      requestLinks: () => undefined,
    };
    const html = render('mindmap', { mindmap });
    expect(html).toContain('対応あり 1・対応先が無い 1・対応が付いていない 1');
    expect(html).toContain('Add branch 未対応');
    expect(render('mindmap', { mindmap, readOnly: true })).not.toContain('Add branch');
    expect(render('mindmap')).not.toContain('マインドマップ');
  });
  it('previews a proposal and refuses one that does not apply', () => {
    const proposal: WorkflowDefinitionProposal = {
      label: '役割を足す',
      intents: [{ type: 'add', kind: 'role', id: 'owner', fields: { name: '責任者' } }],
    };
    expect(render('lists', { proposal })).toContain('追加 役割 owner');
    const stale = {
      ...proposal,
      intents: [{ type: 'delete' as const, kind: 'role' as const, id: 'nobody' }],
    };
    expect(render('lists', { proposal: stale })).toContain('適用できません');
  });
});
