import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { Authority, initial, type Identity } from '@editor-platform/collaboration-core';
import { prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import {
  isWhiteboard,
  connectorGeometry,
  whiteboardDrawing,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import { exportBoardSvg } from '@editor-platform/whiteboard';
import { definitionRef, lockClosure, sealReusableDefinition } from '@editor-platform/reuse-core';
import { authorReusableComponent } from './reuse-definition';
import {
  prepareComponentInsertion,
  prepareComponentDetach,
  retainedComponent,
} from './reuse-apply';
import { localTemplateSnapshot, templateCodec } from './apply';
import { createReusableVersion } from './reuse-catalog';
import { previewComponentUpdate } from './reuse-update';
import { remapNative } from './native';
import { nativePropertyPatch, patchReusablePart, publicPropertySuggestions } from './reuse-native';

const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const board = (): WhiteboardContent => ({
  schemaVersion: 3,
  sections: [
    {
      id: 'section',
      title: '業務の流れ',
      bounds: { x: -2000, y: -1200, width: 1000, height: 500 },
      background: '#eef0e8',
    },
  ],
  nodes: [
    {
      id: 'start',
      sectionId: 'section',
      kind: 'rectangle',
      text: '受付',
      color: '#ddeeff',
      bounds: { x: -1950, y: -1150, width: 170, height: 100 },
      ports: [{ key: 'result', label: '結果', side: 'right', offset: 0.25 }],
    },
    {
      id: 'end',
      sectionId: 'section',
      kind: 'rectangle',
      text: '処理',
      color: '#ddeeff',
      bounds: { x: -1600, y: -1150, width: 170, height: 100 },
    },
  ],
  connectors: [
    {
      id: 'connection',
      from: 'start',
      to: 'end',
      fromPort: 'result',
      toPort: 'left',
      label: '正常',
      routing: 'elbow',
    },
  ],
});
const empty: WhiteboardContent = { schemaVersion: 3, nodes: [], connectors: [], sections: [] };
const basis = (content: WhiteboardContent) => ({
  identity,
  state: localTemplateSnapshot('board', 'whiteboard', content),
});
const author = (content = board(), ids: string[] = []) =>
  authorReusableComponent({ domain: 'whiteboard', name: '処理部品', content, ids });

it('retains infinite-world Section/node/connector topology and scoped ports through insertion, native reload, remap and unlink', async () => {
  const value = await author();
  const prepared = await prepareComponentInsertion({
    ...basis(empty),
    ...value,
    reuse: 'linked',
    requestId: 'section',
    target: { position: { x: 250, y: -70 } },
  });
  const next = prepared.preview as WhiteboardContent;
  expect(next.nodes[0].bounds).toMatchObject({ x: -1700, y: -1220 });
  expect(next.sections![0].bounds).toMatchObject({ x: -1750, y: -1270 });
  expect(next.nodes[0].sectionId).toBe(next.sections![0].id);
  expect(next.connectors[0]).toMatchObject({
    from: next.nodes[0].id,
    to: next.nodes[1].id,
    fromPort: 'result',
    toPort: 'left',
  });
  expect(connectorGeometry(next, next.connectors[0])).toMatchObject({
    x1: -1530,
    y1: -1195,
  });
  expect(exportBoardSvg(next)).toContain('受付');
  expect(isWhiteboard(JSON.parse(JSON.stringify(next)))).toBe(true);
  const copy = remapNative(next).content;
  expect(copy.connectors[0].fromPort).toBe('result');
  expect(copy.connectors[0].from).toBe(copy.nodes[0].id);
  expect(copy.nodes[0].id).not.toBe(next.nodes[0].id);
  const detached = prepareComponentDetach(basis(next).state, identity, 'reuse_section')
    .preview as WhiteboardContent;
  expect(detached.reuse).toBeUndefined();
  expect(detached.nodes).toEqual(next.nodes);
  expect(detached.connectors).toEqual(next.connectors);
});

it('deleted used ports require explicit migration, including external connectors, with retry-safe native selective Undo', async () => {
  const value = await author(board(), ['start']);
  const current = (
    await prepareComponentInsertion({
      ...basis(empty),
      ...value,
      reuse: 'linked',
      requestId: 'node',
    })
  ).preview as WhiteboardContent;
  current.nodes.push({ ...board().nodes[1], id: 'outside', sectionId: undefined });
  current.connectors.push({
    id: 'external',
    from: current.nodes[0].id,
    to: 'outside',
    fromPort: 'result',
    toPort: 'left',
    label: '外部接続',
  });
  current.nodes[0].text = '案件の受付';
  const payload = clone(value.definition.payload),
    prototype = payload.template.content as WhiteboardContent;
  prototype.nodes[0].color = '#336699';
  prototype.nodes[0].ports = [{ key: 'approved', label: '承認済み', side: 'bottom', offset: 0.75 }];
  const update = await createReusableVersion(value.definition, { payload });
  const codec = templateCodec('whiteboard'),
    authority = new Authority(codec, initial('board', codec, current));
  const args = { identity, state: authority.snapshot(), ...update };
  const first = await previewComponentUpdate({
    ...args,
    selections: [{ instanceId: 'reuse_node', choice: 'adopt' }],
  });
  expect(first.prepared).toBeUndefined();
  expect(first.conflicts).toEqual(
    expect.arrayContaining([expect.objectContaining({ field: 'port:result' })]),
  );
  expect(authority.snapshot().content).toEqual(current);
  const part = value.definition.payload.contract.parts[0];
  const second = await previewComponentUpdate({
    ...args,
    selections: [
      {
        instanceId: 'reuse_node',
        choice: 'adopt',
        portMapping: { [part.id + ':result']: 'approved' },
      },
    ],
  });
  expect(second.conflicts).toEqual([]);
  expect(authority.commit(principal, second.prepared!.operation).status).toBe('accepted');
  const adopted = authority.snapshot().content as WhiteboardContent;
  expect(adopted.connectors[0]).toMatchObject({
    from: current.nodes[0].id,
    to: 'outside',
    fromPort: 'approved',
    label: '外部接続',
  });
  expect(adopted.nodes[0]).toMatchObject({ text: '案件の受付', color: '#336699' });
  expect(connectorGeometry(adopted, adopted.connectors[0])).toMatchObject({
    x1: -1822.5,
    y1: -1050,
  });
  expect(authority.undo(principal, second.prepared!.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(current);
});

it('a connection attached after a port-migration preview is stale, and denied submission changes nothing', async () => {
  const value = await author(board(), ['start']);
  const content = (
    await prepareComponentInsertion({
      ...basis(empty),
      ...value,
      reuse: 'linked',
      requestId: 'node',
    })
  ).preview as WhiteboardContent;
  content.nodes.push({ ...board().nodes[1], id: 'outside', sectionId: undefined });
  const payload = clone(value.definition.payload);
  (payload.template.content as WhiteboardContent).nodes[0].ports = [];
  const update = await createReusableVersion(value.definition, { payload });
  const codec = templateCodec('whiteboard'),
    authority = new Authority(codec, initial('board', codec, content));
  const prepared = (
    await previewComponentUpdate({
      state: authority.snapshot(),
      identity,
      ...update,
      selections: [{ instanceId: 'reuse_node', choice: 'adopt' }],
    })
  ).prepared!;
  expect(authority.commit({ ...principal, writable: false }, prepared.operation).status).not.toBe(
    'accepted',
  );
  expect(authority.snapshot().content).toEqual(content);
  const remote = { ...principal, actorId: 'B', clientId: 'b', sessionId: 'two' };
  const op = prepareEditorCommand(
    codec,
    authority.snapshot(),
    remote,
    command('connect', 'Connect', (before) => {
      const next = clone(before) as WhiteboardContent;
      next.connectors.push({
        id: 'late',
        from: next.nodes[0].id,
        to: 'outside',
        fromPort: 'result',
        label: '後から接続',
      });
      return next;
    }),
  )!;
  expect(authority.commit(remote, op).status).toBe('accepted');
  expect(authority.commit(principal, prepared.operation).status).not.toBe('accepted');
  expect((authority.snapshot().content as WhiteboardContent).connectors[0].fromPort).toBe('result');
});

it('Section/group slots nest native nodes in world coordinates and retain all child links in one Undo', async () => {
  const source: WhiteboardContent = {
    ...empty,
    sections: [
      {
        id: 's',
        title: '無限canvasの区画',
        background: '#ffffff',
        bounds: { x: -5000, y: 8000, width: 600, height: 400 },
      },
    ],
  };
  const parent = await author(source);
  const payload = clone(parent.definition.payload);
  payload.contract.slots[0].min = 1;
  const definition = await sealReusableDefinition({ ...parent.definition, payload }),
    closure = await lockClosure([definitionRef(definition)], [definition]);
  const group: WhiteboardContent = {
    ...empty,
    nodes: [
      {
        id: 'g',
        kind: 'group',
        bounds: { x: 10, y: 20, width: 200, height: 150 },
        text: '',
        color: '#ffffff',
      },
    ],
  };
  const middle = await author(group),
    child = await author(board(), ['start']);
  const prepared = await prepareComponentInsertion({
    ...basis(empty),
    definition,
    closure,
    reuse: 'linked',
    requestId: 'nested',
    slots: {
      [payload.contract.slots[0].id]: [
        {
          kind: 'component',
          ...middle,
          slots: {
            [middle.definition.payload.contract.slots[0].id]: [{ kind: 'component', ...child }],
          },
        },
      ],
    },
  });
  const next = prepared.preview as WhiteboardContent;
  expect(next.reuse!.instances).toHaveLength(3);
  expect(next.nodes[0].sectionId).toBe(next.sections![0].id);
  expect(next.nodes[1].groupId).toBe(next.nodes[0].id);
  expect(next.nodes[0].bounds).toMatchObject({ x: -4980, y: 8020 });
  expect(next.nodes[1].bounds).toMatchObject({ x: -4960, y: 8040 });
  expect(isWhiteboard(JSON.parse(JSON.stringify(next)))).toBe(true);
  const authority = new Authority(templateCodec('whiteboard'), basis(empty).state);
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(empty);
  expect(
    retainedComponent(next, 'reuse_nested').instance.slots[payload.contract.slots[0].id],
  ).toEqual([next.nodes[0].id]);
});

it('invalid ports and dangling custom attachments fail native/authority validation', () => {
  const malformed = board();
  malformed.nodes[0].ports![0].offset = 1.1;
  expect(isWhiteboard(malformed)).toBe(false);
  const dangling = board();
  dangling.nodes[0].ports = [];
  expect(isWhiteboard(dangling)).toBe(false);
  const duplicate = board();
  duplicate.nodes[0].ports!.push(clone(duplicate.nodes[0].ports![0]));
  expect(isWhiteboard(duplicate)).toBe(false);
});
it('named ports and automatic endpoints follow native node rotation/reflection exactly once', () => {
  const content = board();
  Object.assign(content.nodes[0], {
    bounds: { x: 100, y: 200, width: 200, height: 100 },
    rotation: 90,
  });
  let point = connectorGeometry(content, content.connectors[0])!;
  expect(point.x1).toBeCloseTo(225);
  expect(point.y1).toBeCloseTo(350);
  content.nodes[0].flipX = true;
  point = connectorGeometry(content, content.connectors[0])!;
  expect(point.x1).toBeCloseTo(225);
  expect(point.y1).toBeCloseTo(150);
  content.nodes[1].bounds = { x: 500, y: 200, width: 100, height: 100 };
  content.connectors[0].fromPort = 'auto';
  point = connectorGeometry(content, content.connectors[0])!;
  expect(point.x1).toBeCloseTo(250);
  expect(point.y1).toBeCloseTo(250);
});
it('changing only reusable text color preserves the native typography defaults and existing explicit fields', () => {
  const content = board();
  content.nodes[0].kind = 'text';
  const before = whiteboardDrawing(content.nodes[0]);
  patchReusablePart(
    content,
    'start',
    nativePropertyPatch(content, 'start', 'color', 'text', '#336699'),
  );
  const after = whiteboardDrawing(content.nodes[0]);
  expect(after.typography).toEqual({ ...before.typography, color: '#336699' });
  expect(
    publicPropertySuggestions(content, { id: 'part', nativeId: 'start' }).find(
      (p) => p.targets[0].field === 'typography.fontSize',
    )!.default,
  ).toBe(18);
  content.nodes[0].typography = { fontSize: 42, italic: true };
  patchReusablePart(
    content,
    'start',
    nativePropertyPatch(content, 'start', 'color', 'text', '#225588'),
  );
  expect(whiteboardDrawing(content.nodes[0]).typography).toMatchObject({
    fontSize: 42,
    italic: true,
    color: '#225588',
  });
});
