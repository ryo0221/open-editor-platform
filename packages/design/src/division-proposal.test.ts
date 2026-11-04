import { expect, it } from 'vitest';
import { canonicalJson, clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createDesign, insertElement, isDesignWithPaths } from './model';
import { insertDesignPage } from './pagination';
import { designDivisionCommand } from './division';
import {
  checkDesignPageProposal,
  designPageProposalCommand,
  prepareDesignPageProposal,
  type DesignPageProposalContext,
  type DesignPageProposalRequest,
} from './page-proposals';

it('proposes schema migration, split and dependent dialogue as one reviewed transaction; stale after Undo', () => {
  const content = insertDesignPage({ x: 100, y: 200, width: 600, height: 800 }, 'page').apply(
    createDesign(),
  );
  const session = new EditorSession(content);
  let readOnly = false;
  const current = (): DesignPageProposalContext => ({
    artifactId: 'comic',
    versionId: 'v1',
    revision: session.revision,
    content: session.content,
    readOnly,
  });
  const request: DesignPageProposalRequest = {
    id: 'source',
    artifactId: 'comic',
    summary: 'Make room for the leap',
    baseLocalRevision: session.revision,
    reads: { target: { artifactId: 'comic', versionId: 'v1' }, references: [] },
    units: [
      {
        id: 'start',
        label: 'Use linked panels',
        requires: [],
        operations: [
          {
            type: 'startDivision',
            pageId: 'page',
            region: { x: 30, y: 30, width: 540, height: 740 },
            root: { panelId: 'panel' },
          },
        ],
      },
      {
        id: 'split',
        label: 'Wide action panel',
        requires: ['start'],
        operations: [
          {
            type: 'splitPanel',
            pageId: 'page',
            panelId: 'panel',
            newPanelId: 'new',
            dividerId: 'cut',
            line: { nx: 0, ny: 1, offset: 300 },
            gap: 16,
            retain: 'b',
            insert: 'before',
          },
        ],
      },
    ],
  };
  expect(() => prepareDesignPageProposal(current(), request, ['split'], 'missing')).toThrow(
    /required changes/,
  );
  const plan = prepareDesignPageProposal(current(), request, ['start', 'split'], 'chosen');
  expect(plan.diff.fallback).toEqual([]);
  expect(plan.diff.changes.some((c) => c.property === 'panel.added')).toBe(true);
  expect(plan.diff.changes.some((c) => c.property === 'pagination.division')).toBe(true);
  expect(session.content).toEqual(content);
  const cmd = designPageProposalCommand(plan, current);
  readOnly = true;
  expect(() => session.execute(cmd)).toThrow(/writable/);
  readOnly = false;
  session.execute(cmd);
  expect(isDesignWithPaths(session.content)).toBe(true);
  const after = canonicalJson(session.content);
  session.undo();
  expect(session.content).toEqual(content);
  expect(() => checkDesignPageProposal(plan, current())).toThrow(/changed/);
  session.redo();
  expect(canonicalJson(session.content)).toBe(after);
});

it('refuses half-boundary edits and allows dependency-closed boundary plus native dialogue adoption', () => {
  let d = insertDesignPage({ x: 0, y: 0, width: 600, height: 800 }, 'page').apply(createDesign());
  d = designDivisionCommand({
    type: 'startDivision',
    pageId: 'page',
    region: { x: 30, y: 30, width: 540, height: 740 },
    root: {
      dividerId: 'cut',
      line: { nx: 0, ny: 1, offset: 300 },
      gap: 16,
      a: { panelId: 'one' },
      b: { panelId: 'two' },
    },
  }).apply(d);
  d = insertElement('text', {
    id: 'text',
    parentId: 'two',
    bounds: { x: 50, y: 400, width: 100, height: 50 },
  }).apply(d);
  const session = new EditorSession(d);
  const current = (): DesignPageProposalContext => ({
    artifactId: 'comic',
    versionId: 'v1',
    revision: session.revision,
    content: session.content,
    readOnly: false,
  });
  const request: DesignPageProposalRequest = {
    id: 'source',
    artifactId: 'comic',
    summary: 'Adjust boundary and dialogue',
    baseLocalRevision: session.revision,
    reads: { target: { artifactId: 'comic', versionId: 'v1' }, references: [] },
    units: [
      {
        id: 'boundary',
        label: 'Boundary',
        requires: [],
        operations: [
          {
            type: 'setDivider',
            pageId: 'page',
            dividerId: 'cut',
            line: { nx: 0, ny: 1, offset: 350 },
            gap: 20,
          },
        ],
      },
      {
        id: 'dialogue',
        label: 'Dialogue',
        requires: ['boundary'],
        operations: [{ type: 'text', id: 'text', value: '飛べ！' }],
      },
    ],
  };
  const plan = prepareDesignPageProposal(current(), request, ['boundary', 'dialogue'], 'chosen');
  session.execute(designPageProposalCommand(plan, current));
  expect(session.content.elements.find((e) => e.id === 'text')!.bounds).toEqual(
    d.elements.find((e) => e.id === 'text')!.bounds,
  );
  expect(session.content.elements.find((e) => e.id === 'text')!.text).toBe('飛べ！');
  const bad = clone(request);
  bad.baseLocalRevision = session.revision;
  bad.units[0].operations = [
    { type: 'bounds', id: 'one', value: { x: 30, y: 30, width: 540, height: 400 } },
  ];
  expect(() => prepareDesignPageProposal(current(), bad, ['boundary'], 'half')).toThrow();
});
