import { describe, expect, it } from 'vitest';
import { canonicalJson, clone, type CurrentRead } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createDesign, insertElement, updateElement } from './model';
import { insertDesignPage, insertDesignPanel, setDesignPagination } from './pagination';
import { designPageEditCommand } from './pagination';
import { designMangaProposalDiff as designPageProposalDiff } from './manga-proposal-diff';
import {
  checkDesignPageProposal,
  designPageProposalCommand,
  prepareDesignPageProposal,
  readDesignPageProposal,
  type DesignPageProposalContext,
  type DesignPageProposalRequest,
} from './page-proposals';

function setup() {
  let content = createDesign();
  for (let i = 1; i <= 4; i++) {
    const x = (i - 1) * 650;
    content = insertDesignPage({ x, y: 0, width: 600, height: 800 }, `page-${i}`).apply(content);
    for (let j = 1; j <= 2; j++)
      content = insertDesignPanel(
        `page-${i}`,
        { x: x + 20, y: 20 + (j - 1) * 380, width: 560, height: 350 },
        `panel-${i}-${j}`,
      ).apply(content);
  }
  content = insertElement('text', {
    id: 'dialogue',
    parentId: 'panel-1-1',
    bounds: { x: 40, y: 60, width: 300, height: 60 },
  }).apply(content);
  content = updateElement('dialogue', { text: 'Before' }).apply(content);
  content = insertElement('image', {
    id: 'image',
    parentId: 'panel-1-1',
    src: 'data:image/png;base64,AA==',
    bounds: { x: 40, y: 140, width: 60, height: 60 },
  }).apply(content);
  content = setDesignPagination({
    ...content.pagination!,
    images: [{ elementId: 'image', source: 'Owned', license: 'CC0' }],
  }).apply(content);
  const session = new EditorSession(content);
  let source: CurrentRead | undefined = { status: 'available', versionId: 'script-v1' };
  let readOnly = false,
    versionId = 'v1';
  const current = (): DesignPageProposalContext => ({
    artifactId: 'comic',
    versionId,
    revision: session.revision,
    content: session.content,
    readOnly,
    readReference: () => source,
  });
  const request: DesignPageProposalRequest = {
    id: 'alternative',
    artifactId: 'comic',
    summary: 'Reframe the opening',
    baseLocalRevision: session.revision,
    reads: {
      target: { artifactId: 'comic', versionId: 'v1' },
      references: [{ artifactId: 'script', versionId: 'script-v1' }],
    },
    units: [
      {
        id: 'layout',
        label: 'Larger opening',
        requires: [],
        operations: [
          { type: 'bounds', id: 'panel-1-1', value: { x: 25, y: 25, width: 550, height: 400 } },
        ],
      },
      {
        id: 'dialogue',
        label: 'Revise dialogue',
        requires: ['layout'],
        operations: [{ type: 'text', id: 'dialogue', value: 'After' }],
      },
      {
        id: 'order',
        label: 'Reverse panels',
        requires: ['dialogue'],
        operations: [
          {
            type: 'panelOrder',
            pageId: 'page-1',
            before: ['panel-1-1', 'panel-1-2'],
            after: ['panel-1-2', 'panel-1-1'],
          },
        ],
      },
    ],
  };
  return {
    session,
    current,
    request,
    content,
    source: (s: CurrentRead | undefined) => {
      source = s;
    },
    readonly: () => {
      readOnly = true;
    },
    version: () => {
      versionId = 'v2';
    },
  };
}

it('moves and replaces an image in a reviewed unit with updated attribution', () => {
  const f = setup();
  const edits = [
    { type: 'bounds' as const, id: 'image', value: { x: 25, y: 25, width: 550, height: 400 } },
    {
      type: 'image' as const,
      id: 'image',
      value: { src: 'data:image/png;base64,AQ==', source: 'Updated source', license: 'CC0' },
    },
  ];
  const after = designPageEditCommand(edits).apply(f.content);
  expect(designPageProposalDiff.diff(f.content, after).fallback).toEqual([]);
  const rotated = clone(after);
  rotated.elements.find((e) => e.id === 'image')!.rotation = 15;
  expect(
    designPageProposalDiff
      .diff(f.content, rotated)
      .fallback.some((d) => d.path.endsWith('/rotation')),
  ).toBe(true);
  f.request.units = [{ id: 'image-edit', label: 'Image', requires: [], operations: edits }];
  const plan = prepareDesignPageProposal(f.current(), f.request, ['image-edit'], 'chosen');
  expect(plan.after.pagination!.images).toEqual([
    { elementId: 'image', source: 'Updated source', license: 'CC0' },
  ]);
});
it('previews a dependency-closed subset without mutation and adopts it as one native Undo', () => {
  const f = setup(),
    original = canonicalJson(f.content);
  const plan = prepareDesignPageProposal(f.current(), f.request, ['dialogue', 'layout'], 'chosen');
  expect(plan.proposal.id).not.toBe(f.request.id);
  expect(f.session.content).toEqual(f.content);
  expect(f.session.canUndo).toBe(false);
  expect(plan.diff.fallback).toEqual([]);
  expect(plan.after.pagination).toEqual(f.content.pagination);
  expect(plan.after.elements.find((e) => e.id === 'dialogue')!.text).toBe('After');
  expect(plan.after.elements.map((e) => e.id)).toEqual(f.content.elements.map((e) => e.id));
  expect(plan.after.elements.filter((e) => e.parentId === 'page-4')).toEqual(
    f.content.elements.filter((e) => e.parentId === 'page-4'),
  );
  expect(plan.after.pagination!.images).toEqual(f.content.pagination!.images);
  f.session.execute(designPageProposalCommand(plan, f.current));
  expect(f.session.content).toEqual(plan.after);
  f.session.undo();
  expect(f.session.content).toEqual(f.content);
  expect(f.session.canUndo).toBe(false);
  f.session.redo();
  expect(f.session.content).toEqual(plan.after);
  expect(canonicalJson(f.content)).toBe(original);
});
it('never adds missing dependencies or accepts an empty/unknown/duplicate selection', () => {
  const f = setup();
  for (const ids of [[], ['dialogue'], ['order', 'dialogue'], ['missing'], ['layout', 'layout']])
    expect(() => prepareDesignPageProposal(f.current(), f.request, ids, 'chosen')).toThrow();
  expect(f.session.canUndo).toBe(false);
  expect(f.session.content).toEqual(f.content);
});
it('rejects cyclic, missing and undeclared overlapping dependencies', () => {
  const f = setup();
  for (const requires of [[], ['missing'], ['order']]) {
    const raw = clone(f.request);
    raw.units[1].requires = requires;
    expect(() => readDesignPageProposal(raw)).toThrow(/dependency/);
  }
  const self = clone(f.request);
  self.units[0].requires = ['layout'];
  expect(() => readDesignPageProposal(self)).toThrow(/cyclic/);
});
it('treats M0 reads as all content even across pages, but allows independent reading orders', () => {
  const f = setup();
  f.request.units = [1, 2].map((n) => ({
    id: `order${n}`,
    label: `Page ${n}`,
    requires: [],
    operations: [
      {
        type: 'panelOrder',
        pageId: `page-${n}`,
        before: [`panel-${n}-1`, `panel-${n}-2`],
        after: [`panel-${n}-2`, `panel-${n}-1`],
      },
    ],
  }));
  const plan = prepareDesignPageProposal(f.current(), f.request, ['order2'], 'chosen');
  expect(plan.after.pagination!.pages[0]).toEqual(f.content.pagination!.pages[0]);
  expect(plan.diff.changes.map((c) => c.property)).toEqual(['pagination.panelOrder']);
  f.request.units[0].operations = [{ type: 'text', id: 'dialogue', value: 'New' }];
  expect(() => readDesignPageProposal(f.request)).toThrow(/dependency/);
});
it('changes page order without changing membership, element IDs, paint order or image provenance', () => {
  const f = setup(),
    before = f.content.pagination!.pages.map((p) => p.frameId);
  f.request.units = [
    {
      id: 'pages',
      label: 'Reverse pages',
      requires: [],
      operations: [{ type: 'pageOrder', before, after: [...before].reverse() }],
    },
  ];
  const plan = prepareDesignPageProposal(f.current(), f.request, ['pages'], 'chosen');
  expect(plan.after.elements).toEqual(f.content.elements);
  expect(plan.after.pagination!.images).toEqual(f.content.pagination!.images);
  expect(plan.after.pagination!.pages).toEqual([...f.content.pagination!.pages].reverse());
  expect(plan.diff.changes[0].property).toBe('pagination.pageOrder');
  for (const after of [
    ['page-2'],
    ['page-1', 'page-1', 'page-3', 'page-4'],
    ['page-1', 'page-2', 'page-3', 'missing'],
  ]) {
    f.request.units[0].operations = [{ type: 'pageOrder', before, after }];
    expect(() => readDesignPageProposal(f.request)).toThrow();
  }
});
for (const state of [
  undefined,
  { status: 'missing' },
  { status: 'forbidden' },
  { status: 'changed' },
  { status: 'available', versionId: 'v2' },
] as (CurrentRead | undefined)[])
  it(`rechecks reference freshness/access at actual execution: ${state?.status ?? 'unverified'}`, () => {
    const f = setup(),
      plan = prepareDesignPageProposal(f.current(), f.request, ['layout'], 'chosen');
    const cmd = designPageProposalCommand(plan, f.current);
    f.source(state);
    expect(() => f.session.execute(cmd)).toThrow(/source/);
    expect(f.session.content).toEqual(f.content);
    expect(f.session.canUndo).toBe(false);
  });
for (const mode of [
  'revision',
  'permission',
  'saved-version',
  'same-content-new-revision',
] as const)
  it(`blocks ${mode} changes after preview`, () => {
    const f = setup(),
      plan = prepareDesignPageProposal(f.current(), f.request, ['layout'], 'chosen');
    const cmd = designPageProposalCommand(plan, f.current);
    if (mode === 'permission') f.readonly();
    else if (mode === 'saved-version') f.version();
    else {
      f.session.execute(updateElement('dialogue', { text: 'Concurrent' }));
      if (mode === 'same-content-new-revision') f.session.undo();
    }
    const before = canonicalJson(f.session.content);
    expect(() => f.session.execute(cmd)).toThrow();
    expect(canonicalJson(f.session.content)).toBe(before);
  });
it('owns caller data, rejects unrecognized plans and rechecks exact content even if a Host misreports revision', () => {
  const f = setup(),
    plan = prepareDesignPageProposal(f.current(), f.request, ['layout'], 'chosen');
  f.request.units[0].operations = [];
  expect(plan.request.units[0].operations).toHaveLength(1);
  expect(() => checkDesignPageProposal({ ...plan }, f.current())).toThrow(/Unknown/);
  const current = f.current();
  current.content.elements[0].name = 'Changed';
  expect(() => checkDesignPageProposal(plan, current)).toThrow(/stale/);
  expect(() => plan.proposal.commands[0].apply(current.content)).toThrow(/changed/);
});
describe('bounded data-only admission', () => {
  for (const mutate of [
    (r: DesignPageProposalRequest) => {
      (r as unknown as Record<string, unknown>).script = 'alert(1)';
    },
    (r: DesignPageProposalRequest) => {
      r.units[0].operations = [{ type: 'path', id: 'x', value: {} }] as never;
    },
    (r: DesignPageProposalRequest) => {
      r.units = Array.from({ length: 33 }, (_, i) => ({ ...r.units[0], id: String(i) }));
    },
    (r: DesignPageProposalRequest) => {
      r.units[0].operations = Array(101).fill(r.units[0].operations[0]);
    },
    (r: DesignPageProposalRequest) => {
      r.baseLocalRevision.sequence = NaN;
    },
    (r: DesignPageProposalRequest) => {
      r.reads.references = [{ artifactId: 'comic', versionId: 'v1' }];
    },
  ])
    it('rejects unsupported or over-limit requests before draft/history mutation', () => {
      const f = setup();
      mutate(f.request);
      expect(() => readDesignPageProposal(f.request)).toThrow();
      expect(f.session.canUndo).toBe(false);
    });
  it('does not execute getters, including in selections', () => {
    const f = setup();
    let accessed = false;
    const raw = {
      ...f.request,
      get summary() {
        accessed = true;
        return 'Bad';
      },
    };
    expect(() => readDesignPageProposal(raw)).toThrow();
    const selected = ['layout'];
    Object.defineProperty(selected, '0', {
      get() {
        accessed = true;
        return 'layout';
      },
    });
    expect(() => prepareDesignPageProposal(f.current(), f.request, selected, 'chosen')).toThrow();
    expect(accessed).toBe(false);
  });
});
it('blocks locked/hidden targets, inherited locks, cross-page bounds, rich text and unsupported changed fields', () => {
  for (const mode of ['locked', 'hidden', 'inherited', 'cross-page', 'formatted'] as const) {
    const f = setup(),
      c = f.current();
    if (mode === 'locked' || mode === 'hidden')
      c.content.elements.find((e) => e.id === 'page-1')![mode] = true;
    if (mode === 'inherited') {
      c.content.elements.find((e) => e.id === 'panel-1-1')!.styleId = 'locked';
      c.content.styles = [{ id: 'locked', name: 'Locked', appearance: { locked: true } }];
    }
    if (mode === 'cross-page')
      f.request.units[0].operations = [
        { type: 'bounds', id: 'panel-1-1', value: { x: 10, y: 10, width: 1200, height: 600 } },
      ];
    if (mode === 'formatted')
      c.content.elements.find((e) => e.id === 'dialogue')!.runs = [
        { text: 'Before', style: { bold: true } },
      ];
    expect(() =>
      prepareDesignPageProposal(c, f.request, ['layout', 'dialogue'], 'chosen'),
    ).toThrow();
    expect(f.session.content).toEqual(f.content);
  }
});
