import { expect, test } from 'vitest';
import { clone, createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { EditorSession, previewProposedCommands, transaction } from '@editor-platform/editor-core';
import {
  createDesign,
  insertDesignPath,
  presetDesignPath,
  patchDesign,
  insertElement,
  replaceDesignPath,
} from '@editor-platform/design/model';
import { inkLayers, prepareInkProposal } from './design-ink-proposal';
import { createLocalSession, type Content } from '../model';
import type { EditorCommand } from '@editor-platform/editor-core';
function fixture() {
  const insert = insertDesignPath(presetDesignPath('cubic'));
  const content = insert.apply(createDesign()),
    session = new EditorSession(content);
  const context = () => ({
    artifactId: 'ink-test',
    revision: session.revision,
    content: session.content,
    selectedIds: [insert.elementId],
  });
  const path = clone(content.elements.find((e) => e.id === insert.elementId)!.path!);
  path.subpaths[0].anchors[0].y += 10;
  const request = () => ({
    id: 'proposal-1',
    summary: '線を修正',
    artifactId: 'ink-test',
    baseRevision: session.revision,
    operations: [{ type: 'replace', id: insert.elementId, path }],
  });
  return { insert, content, session, context, request };
}
test('preview/apply/Undo/Redo and immutable saves keep the same path and previous version', async () => {
  const f = fixture(),
    artifact = await commitVersion(createArtifact('design', 'ink', f.content), null, 'before');
  const proposal = prepareInkProposal(f.context(), f.request(), () => true),
    preview = previewProposedCommands(f.content, proposal);
  expect(f.session.content).toEqual(f.content);
  f.session.execute(transaction(proposal.summary, proposal.commands));
  expect(f.session.content).toEqual(preview.content);
  const saved = await commitVersion(
    { ...artifact, draft: { ...artifact.draft, content: f.session.content } },
    null,
    'after',
  );
  expect(saved.versions[0]).toEqual(artifact.versions[0]);
  expect(saved.versions[1].content.elements.some((e) => e.id === f.insert.elementId)).toBe(true);
  expect(f.session.undo()).toEqual(f.content);
  expect(f.session.redo()).toEqual(preview.content);
});
test('rejects stale/other scope, malformed operations and invalid geometry without changing the draft', () => {
  const f = fixture(),
    r = f.request();
  for (const bad of [
    { ...r, artifactId: 'other' },
    { ...r, baseRevision: { ...r.baseRevision, sequence: 999 } },
    { ...r, baseRevision: { ...r.baseRevision, sessionId: 'other' } },
    { ...r, baseRevision: null },
    { ...r, operations: [{ type: 'execute', source: 'alert(1)' }] },
    {
      ...r,
      operations: [{ type: 'replace', id: f.insert.elementId, path: { frame: { x: NaN } } }],
    },
  ]) {
    expect(() => prepareInkProposal(f.context(), bad, () => true)).toThrow();
    expect(f.session.content).toEqual(f.content);
  }
});
test('rechecks write permission at apply; a failing later operation cannot partially change the draft', () => {
  const f = fixture();
  let writable = true;
  const p = prepareInkProposal(f.context(), f.request(), () => writable);
  writable = false;
  expect(() => f.session.execute(transaction('apply', p.commands))).toThrow(/read only/);
  expect(f.session.content).toEqual(f.content);
  expect(() =>
    prepareInkProposal(
      f.context(),
      {
        ...f.request(),
        operations: [
          ...f.request().operations,
          { type: 'replace', id: 'deleted', path: presetDesignPath('line') },
        ],
      },
      () => true,
    ),
  ).toThrow();
  expect(f.session.content).toEqual(f.content);
});
test('offers visible editable layers while retaining hidden stages', () => {
  let c = createDesign();
  for (const id of ['ink', 'rough'])
    c = insertElement('group', { id, bounds: { x: 0, y: 0, width: 800, height: 1000 } }).apply(c);
  c = patchDesign(['rough'], { hidden: true }).apply(c);
  expect(inkLayers(c).map((e) => e.id)).toContain('ink');
  expect(inkLayers(c).map((e) => e.id)).not.toContain('rough');
});
test('Playground admits only the validated local ink transaction and keeps arbitrary schema3 proposals blocked', () => {
  const f = fixture(),
    local = createLocalSession(f.content);
  const current = {
    ...f.context(),
    revision: local.revision,
    content: local.content as typeof f.content,
  };
  const proposal = prepareInkProposal(
    current,
    { ...f.request(), baseRevision: local.revision },
    () => true,
  );
  expect(() =>
    local.executeView(
      transaction('unreviewed wrapper', proposal.commands, {
        origin: 'proposal',
        transactionId: 'fake',
      }) as EditorCommand<Content>,
    ),
  ).toThrow(/not supported/);
  expect(local.content).toEqual(f.content);
  local.executeView(proposal.commands[0] as EditorCommand<Content>);
  expect(local.content).not.toEqual(f.content);
  expect(local.undo()).toEqual(f.content);
});
test('AI can add a native line; the ordinary human command edits it in the same Undo history', () => {
  const content = insertElement('group', {
    id: 'ink',
    bounds: { x: 0, y: 0, width: 800, height: 1000 },
  }).apply(createDesign());
  const local = createLocalSession(content),
    context = { artifactId: 'new-ink', revision: local.revision, content, selectedIds: ['ink'] };
  const proposal = prepareInkProposal(
    context,
    {
      id: 'add-line',
      artifactId: 'new-ink',
      summary: '線を追加',
      baseRevision: local.revision,
      operations: [
        {
          type: 'add',
          name: 'AI追加線',
          parentId: 'ink',
          path: presetDesignPath('line'),
          bounds: { x: 100, y: 100, width: 220, height: 160 },
        },
      ],
    },
    () => true,
  );
  local.executeView(proposal.commands[0] as EditorCommand<Content>);
  const added = local.content as typeof content,
    line = added.elements.find((e) => e.name === 'AI追加線')!;
  expect(line.parentId).toBe('ink');
  const path = clone(line.path!);
  path.subpaths[0].anchors[0].y += 5;
  local.executeView(replaceDesignPath(added, line.id, path) as EditorCommand<Content>);
  expect((local.content as typeof content).elements.find((e) => e.id === line.id)!.path).toEqual(
    path,
  );
  expect(local.undo()).toEqual(added);
  expect(local.undo()).toEqual(content);
});

test('an insertion adopts the previewed bounds even if its caller later mutates the request', () => {
  const content = createDesign(),
    local = createLocalSession(content),
    bounds = { x: 100, y: 100, width: 220, height: 160 };
  const expected = { ...bounds };
  const input = {
    id: 'snapshot-bounds',
    artifactId: 'bounds-test',
    summary: 'Add a reviewed line',
    baseRevision: local.revision,
    operations: [
      {
        type: 'add',
        name: 'Reviewed insertion',
        path: presetDesignPath('line'),
        bounds,
      },
    ],
  };
  const proposal = prepareInkProposal(
    { artifactId: 'bounds-test', revision: local.revision, content, selectedIds: [] },
    input,
    () => true,
  );
  const preview = previewProposedCommands(content, proposal);
  expect(preview.content.elements.find((element) => element.name === 'Reviewed insertion')!.bounds)
    .toEqual(expected);
  Object.assign(input.operations[0].bounds, { x: 900, y: 800, width: 90, height: 80 });
  local.executeView(proposal.commands[0] as EditorCommand<Content>);
  expect(local.content).toEqual(preview.content);
  expect((local.content as typeof content).elements.find(
    (element) => element.name === 'Reviewed insertion',
  )!.bounds).toEqual(expected);
});
