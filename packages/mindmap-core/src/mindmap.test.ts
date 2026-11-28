import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addMindmapNode,
  collapseMindmapNode,
  colorMindmapNode,
  createMindmap,
  deleteMindmapNode,
  editMindmapNodeFields,
  exportMindmapJson,
  exportMindmapMarkdown,
  exportMindmapSvg,
  isMindmap,
  layoutMindmap,
  markMindmapNode,
  mindmapDiff,
  mindmapFingerprint,
  mindmapItemsDeclaration,
  mindmapProposalCommand,
  mindmapProposalDeclaration,
  mindmapProposalProblems,
  moveMindmapNode,
  noteMindmapNode,
  renameMindmapNode,
  reorderMindmapNode,
  setMindmapLayout,
  setMindmapNodeLink,
  validateMindmap,
  type MindmapContent,
} from './index';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const doc = (): MindmapContent => read('valid.json');
const rich = (): MindmapContent => read('valid-rich.json');
const id = (n: number) => 'n-' + n.toString(16).padStart(32, '0');

describe('stored format', () => {
  it('reads files written by the external mindmap-editor 0.1.5 unchanged', () => {
    for (const name of ['valid.json', 'valid-rich.json']) {
      const before = read(name);
      expect(() => validateMindmap(before)).not.toThrow();
      expect(JSON.parse(exportMindmapJson(before))).toEqual(read(name));
    }
  });

  for (const { file, reason } of read('cases.json') as { file: string; reason: string }[])
    it(`rejects ${file} with its reason`, () =>
      expect(() => validateMindmap(read(file))).toThrow(reason));

  it('rejects another kind, unknown fields and bad ids', () => {
    expect(() => validateMindmap({ ...doc(), artifactKind: 'example.cards' })).toThrow('形式');
    expect(() => validateMindmap({ ...doc(), extra: true })).toThrow('フィールド');
    const malformed = doc();
    malformed.nodes[malformed.rootId].id = 'bad';
    expect(() => validateMindmap(malformed)).toThrow('ノードID');
    const sided = rich();
    const leaf = Object.values(sided.nodes).find(
      (n) => !n.children.length && n.id !== sided.rootId,
    );
    if (leaf && !sided.nodes[sided.rootId].children.includes(leaf.id)) {
      leaf.side = 'left';
      expect(() => validateMindmap(sided)).toThrow('左右');
    }
  });

  it('creates a map holding only its centre', () => {
    const map = createMindmap();
    expect(isMindmap(map)).toBe(true);
    expect(Object.keys(map.nodes)).toEqual([map.rootId]);
  });
});

describe('commands', () => {
  it('adds, reorders and moves a subtree, keeping side rules', () => {
    let d = doc();
    const root = d.rootId;
    d = addMindmapNode(root, 0, id(2), 'a', 'left').apply(d);
    d = addMindmapNode(root, 1, id(3), 'b', 'right').apply(d);
    d = addMindmapNode(id(2), 0, id(4), 'child').apply(d);
    const reordered = reorderMindmapNode(id(3), 0).apply(d);
    expect(reordered.nodes[root].children.slice(0, 2)).toEqual([id(3), id(2)]);
    const moved = moveMindmapNode(id(2), id(3), 0).apply(reordered);
    expect(moved.nodes[id(3)].children).toEqual([id(2)]);
    expect(moved.nodes[id(2)].children).toEqual([id(4)]);
    expect(moved.nodes[id(2)].side).toBeUndefined();
    expect(() => moveMindmapNode(id(3), id(4), 0).apply(moved)).toThrow('子孫');
    expect(() => moveMindmapNode(id(4), root, 0).apply(moved)).toThrow('左右');
  });

  it('refuses root deletion and over-long text without changing the input', () => {
    const d = rich(),
      original = structuredClone(d);
    expect(() => deleteMindmapNode(d.rootId).apply(d)).toThrow();
    expect(() => renameMindmapNode(d.rootId, 'あ'.repeat(201)).apply(d)).toThrow();
    expect(() => setMindmapLayout(d.layout).apply(d)).toThrow('変更がありません');
    expect(d).toEqual(original);
  });

  it('deletes a subtree', () => {
    let d = doc();
    d = addMindmapNode(d.rootId, 0, id(2), 'a').apply(d);
    d = addMindmapNode(id(2), 0, id(3), 'b').apply(d);
    const after = deleteMindmapNode(id(2)).apply(d);
    expect(after.nodes[id(2)]).toBeUndefined();
    expect(after.nodes[id(3)]).toBeUndefined();
  });

  it('checks folding, colour, marks and notes', () => {
    let d = doc();
    const root = d.rootId;
    d = addMindmapNode(root, 0, id(2), 'a').apply(d);
    expect(collapseMindmapNode(root, true).apply(d).nodes[root].collapsed).toBe(true);
    expect(() => collapseMindmapNode(id(2), true).apply(d)).toThrow();
    expect(colorMindmapNode(root, '#abc').apply(d).nodes[root].color).toBe('#abc');
    expect(() => colorMindmapNode(root, 'red').apply(d)).toThrow('色');
    expect(
      markMindmapNode(root, ['idea', 'risk', 'todo', 'done']).apply(d).nodes[root].marks,
    ).toHaveLength(4);
    expect(() => markMindmapNode(root, ['idea', 'risk', 'todo', 'done', 'star']).apply(d)).toThrow(
      '印',
    );
    expect(() => markMindmapNode(root, ['idea', 'idea']).apply(d)).toThrow('印');
    expect(noteMindmapNode(root, '😀'.repeat(4000)).apply(d).nodes[root].note).toHaveLength(8000);
    expect(() => noteMindmapNode(root, '😀'.repeat(4001)).apply(d)).toThrow('メモ');
  });

  it('edits the fields of one node as one step, refused when the node changed meanwhile', () => {
    const d = doc(),
      root = d.rootId,
      before = d.nodes[root];
    const cmd = editMindmapNodeFields(root, before, {
      text: '新しい名前',
      marks: ['idea'],
      note: 'メモ',
    });
    const after = cmd.apply(d);
    expect(after.nodes[root]).toMatchObject({ text: '新しい名前', marks: ['idea'], note: 'メモ' });
    const other = renameMindmapNode(root, '別の編集').apply(d);
    expect(() => cmd.apply(other)).toThrow('変更されました');
    expect(() => editMindmapNodeFields(root, before, { text: before.text }).apply(d)).toThrow(
      '変更がありません',
    );
  });
});

describe('combined field edits', () => {
  it('validates the combined result, not each field on its own, near the size limit', () => {
    const d = doc();
    const root = d.rootId;
    const size = (c: MindmapContent) => Buffer.byteLength(JSON.stringify(c));
    let i = 2;
    const add = (note: string) => {
      d.nodes[id(i)] = { id: id(i), text: 'x', children: [], note };
      d.nodes[root].children.push(id(i++));
    };
    while (524288 - 50 - size(d) > 7900) add('a'.repeat(4000));
    // Fill to 50 bytes under the limit with two more notes.
    const [p, q] = [i, i + 1];
    add('');
    add('');
    const gap = 524288 - 50 - size(d);
    d.nodes[id(p)].note = 'b'.repeat(Math.floor(gap / 2));
    d.nodes[id(q)].note = 'b'.repeat(gap - Math.floor(gap / 2));
    expect(size(d)).toBe(524288 - 50);
    validateMindmap(d);
    const target = d.nodes[id(2)];
    const after = editMindmapNodeFields(id(2), target, {
      text: target.text + 'y'.repeat(100),
      note: target.note!.slice(200),
    }).apply(d);
    expect(size(after)).toBe(524288 - 150);
    expect(() =>
      editMindmapNodeFields(id(2), target, { text: target.text + 'y'.repeat(100) }).apply(d),
    ).toThrow('上限');
  });
});

describe('proposals', () => {
  it('applies a sequence as one command and refuses a changed base', () => {
    const before = doc(),
      root = before.rootId,
      newId = id(2);
    const input = {
      before: mindmapFingerprint(before),
      steps: [
        { kind: 'add', id: newId, parentId: root, index: 0, text: '子' },
        { kind: 'rename', id: newId, text: '変更' },
      ],
    };
    expect(mindmapProposalProblems(input, before)).toEqual([]);
    const result = mindmapProposalCommand(input, before).apply(before);
    expect(result.nodes[newId].text).toBe('変更');
    expect(before.nodes[newId]).toBeUndefined();
    expect(() => mindmapProposalCommand(input, before).apply(result)).toThrow('基準');
    expect(mindmapProposalDeclaration.inputSchema.properties.steps.maxItems).toBe(100);
  });

  it('gives fresh ids to added nodes with omitted or temporary ids', () => {
    const before = doc(),
      root = before.rootId;
    const input = {
      steps: [
        { kind: 'add', parentId: root, text: '市場の変化' },
        { kind: 'add', id: 'new-1', parentId: root, text: '社会の課題' },
        { kind: 'add', id: 'new-2', parentId: 'new-1', text: 'OP-01 電池の行き先' },
        { kind: 'marks', id: 'new-2', marks: ['idea'] },
      ],
    };
    const result = mindmapProposalCommand(input, before).apply(before);
    const kids = result.nodes[root].children.slice(-2).map((k) => result.nodes[k]);
    expect(kids.map((n) => n.text)).toEqual(['市場の変化', '社会の課題']);
    const child = result.nodes[kids[1].children[0]];
    expect(child.id).toMatch(/^n-[0-9a-f]{32}$/);
    expect(child).toMatchObject({ text: 'OP-01 電池の行き先', marks: ['idea'] });
  });

  it('names the broken step and refuses the whole proposal', () => {
    const before = doc();
    expect(
      mindmapProposalProblems(
        {
          steps: [
            { kind: 'add', parentId: before.rootId, text: 'a' },
            { kind: 'add', text: 'b' },
          ],
        },
        before,
      ),
    ).toEqual(['2 番目の操作（add）の項目が不正です。要る項目：parentId・text']);
    expect(
      mindmapProposalProblems({ steps: [{ kind: 'delete', id: before.rootId }] }, before),
    ).not.toEqual([]);
    expect(before).toEqual(doc());
  });
});

describe('links (#99 WD4)', () => {
  const link = { namespace: 'owd:sample-plan', id: 'phase:concept' };
  it('sets, replaces and removes a link as one command each, the root too', () => {
    const a = doc(),
      root = a.rootId;
    const b = setMindmapNodeLink(root, link).apply(a);
    expect(b.nodes[root].link).toEqual(link);
    expect(a.nodes[root].link).toBeUndefined();
    const c = setMindmapNodeLink(root, { ...link, id: 'phase:design' }).apply(b);
    expect(c.nodes[root].link?.id).toBe('phase:design');
    expect(setMindmapNodeLink(root, null).apply(c).nodes[root].link).toBeUndefined();
    // No change, a missing link, a missing node or a part over the limit changes nothing.
    expect(() => setMindmapNodeLink(root, link).apply(b)).toThrow('変更がありません');
    expect(() => setMindmapNodeLink(root, null).apply(a)).toThrow('つながりはありません');
    expect(() => setMindmapNodeLink('n-missing', link).apply(a)).toThrow();
    expect(() => setMindmapNodeLink(root, { ...link, id: 'x'.repeat(129) }).apply(a)).toThrow();
    expect(() => setMindmapNodeLink(root, { ...link, id: '' }).apply(a)).toThrow();
    expect(() => setMindmapNodeLink(root, { ...link, extra: 1 } as unknown as typeof link)).toThrow(
      'つながりが不正',
    );
    expect(mindmapDiff(a, b).changes.map((x) => [x.kind, x.after])).toEqual([
      ['changed', 'つながり: owd:sample-plan/phase:concept'],
    ]);
  });
  it('applies link steps in proposals, refusing stale or malformed ones', () => {
    const a = doc(),
      root = a.rootId;
    const input = {
      before: mindmapFingerprint(a),
      steps: [
        { kind: 'add', id: 'new-1', parentId: root, text: '構想' },
        { kind: 'link', id: 'new-1', link },
      ],
    };
    const b = mindmapProposalCommand(input, a).apply(a);
    const added = b.nodes[root].children.at(-1)!;
    expect(b.nodes[added].link).toEqual(link);
    expect(() => mindmapProposalCommand(input, a).apply(b)).toThrow('基準');
    const removed = mindmapProposalCommand(
      { steps: [{ kind: 'link', id: added, link: null }] },
      b,
    ).apply(b);
    expect(removed.nodes[added].link).toBeUndefined();
    for (const bad of [
      { kind: 'link', id: root },
      { kind: 'link', id: root, link: { namespace: 'x' } },
      { kind: 'link', id: root, link: 'phase:concept' },
      { kind: 'link', id: root, link: { ...link, extra: 'y' } },
    ])
      expect(mindmapProposalProblems({ steps: [bad] }, a)).not.toEqual([]);
    expect(
      mindmapProposalDeclaration.inputSchema.properties.steps.items.properties.kind.enum,
    ).toContain('link');
  });
});

describe('compare, items, layout and export', () => {
  it('lists added, removed, renamed and moved nodes by id', () => {
    let a = doc();
    const root = a.rootId;
    a = addMindmapNode(root, 0, id(2), '残す').apply(a);
    a = addMindmapNode(root, 1, id(3), '消す').apply(a);
    a = addMindmapNode(root, 2, id(4), '移す先').apply(a);
    let b = deleteMindmapNode(id(3)).apply(a);
    b = renameMindmapNode(id(2), '名前を変えた').apply(b);
    b = moveMindmapNode(id(2), id(4), 0).apply(b);
    b = addMindmapNode(root, 0, id(5), '足した').apply(b);
    const changes = mindmapDiff(a, b).changes;
    expect(changes.map((c) => [c.elementId, c.kind])).toEqual(
      expect.arrayContaining([
        [id(5), 'added'],
        [id(3), 'removed'],
        [id(2), 'changed'],
        [id(2), 'moved'],
      ]),
    );
    expect(mindmapDiff(a, a).changes).toEqual([]);
    expect(
      mindmapDiff(a, collapseMindmapNode(root, true).apply(a)).changes.map((c) => c.kind),
    ).toEqual(['changed']);
    // A sibling reorder alone is a change; an added sibling does not reorder the others.
    const reordered = reorderMindmapNode(id(4), 0).apply(a);
    expect(
      mindmapDiff(a, reordered).changes.filter((c) => c.path.endsWith('.order')).length,
    ).toBeGreaterThan(0);
    expect(
      mindmapDiff(a, addMindmapNode(root, 0, id(6), '先頭').apply(a)).changes.map((c) => c.kind),
    ).toEqual(['added']);
  });

  it('declares leading-token items with link refs', () => {
    expect(mindmapItemsDeclaration.collections[0]).toMatchObject({
      at: 'nodes',
      id: { field: 'text', from: 'leading-token' },
      refs: ['link.id'],
    });
  });

  it('lays out every visible node without overlap in each layout', () => {
    let d = rich();
    for (const layout of ['radial', 'right', 'tree'] as const) {
      if (d.layout !== layout) d = setMindmapLayout(layout).apply(d);
      const { boxes, width, height } = layoutMindmap(d);
      expect(boxes.length).toBeGreaterThan(1);
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      for (const [i, p] of boxes.entries())
        for (const q of boxes.slice(i + 1))
          expect(
            p.x + p.width <= q.x ||
              q.x + q.width <= p.x ||
              p.y + p.height <= q.y ||
              q.y + q.height <= p.y,
            `${layout}: ${p.id} overlaps ${q.id}`,
          ).toBe(true);
    }
  });

  it('reserves the height of a parent taller than its children', () => {
    for (const layout of ['right', 'radial', 'tree'] as const) {
      let d = doc();
      const root = d.rootId;
      for (const [i, parent, leaf] of [
        [0, id(2), id(3)],
        [1, id(4), id(5)],
        [2, id(6), id(7)],
      ] as const) {
        d = addMindmapNode(root, i, parent, '長'.repeat(200), 'right').apply(d);
        d = addMindmapNode(parent, 0, leaf, '短').apply(d);
      }
      if (d.layout !== layout) d = setMindmapLayout(layout).apply(d);
      const { boxes } = layoutMindmap(d);
      for (const [i, p] of boxes.entries())
        for (const q of boxes.slice(i + 1))
          expect(
            p.x + p.width <= q.x ||
              q.x + q.width <= p.x ||
              p.y + p.height <= q.y ||
              q.y + q.height <= p.y,
            `${layout}: ${p.id} overlaps ${q.id}`,
          ).toBe(true);
    }
  });

  it('writes SVG and a Markdown outline with escaped text', () => {
    let d = doc();
    d = addMindmapNode(d.rootId, 0, id(2), '<b> & "x"').apply(d);
    d = noteMindmapNode(id(2), '一行目\n二行目').apply(d);
    d = markMindmapNode(id(2), ['risk']).apply(d);
    d = addMindmapNode(id(2), 0, id(3), '- 箇条書きに見える').apply(d);
    const svg = exportMindmapSvg(d);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('&lt;b&gt; &amp; &quot;x&quot;');
    expect(svg).not.toContain('<b>');
    const md = exportMindmapMarkdown(d);
    expect(md).toContain('- \\<b\\> & "x" [リスク]');
    expect(md).toContain('  > 一行目\n  > 二行目');
    expect(md).toContain('  - \\- 箇条書きに見える');
    expect(exportMindmapSvg(d, { nodeId: id(2) })).not.toContain(d.nodes[d.rootId].text);
    expect(() => exportMindmapSvg(d, { nodeId: id(9) })).toThrow();
  });
});
