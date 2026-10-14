import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { command } from '@editor-platform/editor-core';
import { Authority, initial, type Identity } from '@editor-platform/collaboration-core';
import { prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import { exportSlideSvg, isDeck, type SlideContent } from '@editor-platform/slide/model';
import {
  definitionRef,
  lockClosure,
  sealReusableDefinition,
  resolveStyle,
} from '@editor-platform/reuse-core';
import { authorReusableComponent, type ComponentDefinition } from './reuse-definition';
import {
  prepareComponentInsertion,
  prepareComponentProperties,
  retainedComponent,
} from './reuse-apply';
import {
  applyLocalTemplate,
  localTemplateSnapshot,
  prepareInsertion,
  templateCodec,
} from './apply';
import { applicationSnapshot } from './reuse-preparation';
import { createReusableVersion } from './reuse-catalog';
import { previewComponentUpdate } from './reuse-update';
import { prepareComponentSlot } from './reuse-slots';
import { materializePartStyle } from './reuse-native';
import { remapNative } from './native';
import { brandStyles, brandTokens } from '../../../tests/fixtures/reuse/brand';

const identity: Identity = { actorId: 'A', clientId: 'a', sessionId: 'one' };
const principal = { ...identity, writable: true, scopes: ['*'] };
const deck = (): SlideContent => ({
  schemaVersion: 2,
  width: 960,
  height: 540,
  slides: [
    {
      id: 'page',
      title: '元のページ',
      background: '#ffffff',
      notes: '発表者だけのノート\n次の段落',
      objects: [
        {
          id: 'title',
          type: 'text',
          bounds: { x: 40, y: 30, width: 800, height: 100 },
          text: 'ブランド見出し',
          fill: '#112233',
          typography: { fontSize: 24, align: 'left' },
        },
        {
          id: 'body',
          type: 'text',
          bounds: { x: 40, y: 180, width: 800, height: 200 },
          text: '案件本文',
          fill: '#202020',
        },
      ],
    },
  ],
});
const basis = (content: SlideContent) => ({
  identity,
  state: localTemplateSnapshot('deck', 'slide', content),
});
const author = (slide: 'objects' | 'pages' = 'objects', content = deck()) =>
  authorReusableComponent({
    domain: 'slide',
    name: 'ブランド',
    content,
    ids: slide === 'objects' ? ['title'] : [],
    slide,
  });
async function revised(definition: ComponentDefinition, change: (content: SlideContent) => void) {
  const payload = clone(definition.payload);
  change(payload.template.content as SlideContent);
  return createReusableVersion(definition, { payload });
}

it('owns Slide insertion inputs across awaits and isolates public previews from immutable staging', async () => {
  const value = await author();
  for (const frozen of [false, true]) {
    const state = localTemplateSnapshot('deck', 'slide', deck());
    if (frozen) deepFreeze(state.content);
    else Object.freeze(state.content);
    const before = clone(state.content) as SlideContent;
    const target = { slidePageId: 'page' };
    const caller = clone(identity);
    const pending = prepareInsertion(
      value.definition.payload.template,
      {},
      state,
      caller,
      target,
      'owned_' + frozen,
    );
    target.slidePageId = 'absent';
    caller.actorId = 'changed';
    if (!frozen) (state.content as SlideContent).slides[0].objects[0].text = 'late edit';
    const prepared = await pending;
    const preview = prepared.preview as SlideContent;
    expect(prepared.operation.actorId).toBe(identity.actorId);
    expect(preview.slides[0].objects.slice(0, 2)).toEqual(before.slides[0].objects);
    expect(preview.slides[0].notes).toBe(before.slides[0].notes);
    const result = prepared.command.apply(deepFreeze(before)) as SlideContent;
    expect(result.slides[0].objects[0]).toBe(before.slides[0].objects[0]);
    expect(result.slides[0].objects).toHaveLength(3);
    preview.slides[0].objects[0].bounds.x = 999;
    expect(
      (applicationSnapshot(prepared).content as SlideContent).slides[0].objects[0].bounds.x,
    ).toBe(40);
    expect(before.slides[0].objects[0].bounds.x).toBe(40);
    const editable = clone(before);
    const copied = prepared.command.apply(editable) as SlideContent;
    copied.slides[0].objects[0].bounds.x = 500;
    expect(editable.slides[0].objects[0].bounds.x).toBe(40);
  }
});

it('separates in-page insertion from whole-page layouts and retains destination body/notes/order/dimensions', async () => {
  const value = await author(),
    current = deck();
  const prepared = await prepareComponentInsertion({
    ...basis(current),
    ...value,
    reuse: 'linked',
    requestId: 'header',
    target: { slidePageId: 'page' },
  });
  const next = applyLocalTemplate(prepared, current) as SlideContent;
  expect(next.slides).toHaveLength(1);
  expect(next.slides[0]).toMatchObject({ ...current.slides[0], objects: expect.any(Array) });
  expect(next.slides[0].objects.slice(0, 2)).toEqual(current.slides[0].objects);
  expect(prepared.insertedIds).toEqual([next.slides[0].objects[2].id]);
  expect(Object.values(next.reuse!.instances[0].parts)).toEqual(prepared.insertedIds);
  expect(isDeck(JSON.parse(JSON.stringify(next)))).toBe(true);
  const copied = remapNative(next).content;
  expect(Object.values(copied.reuse!.instances[0].parts)).toEqual([copied.slides[0].objects[2].id]);
  await expect(
    prepareComponentInsertion({ ...basis(current), ...value, reuse: 'linked' }),
  ).rejects.toMatchObject({ code: 'slide-target' });
  await expect(
    prepareComponentInsertion({
      ...basis(current),
      ...value,
      reuse: 'linked',
      target: { slidePageId: 'gone' },
    }),
  ).rejects.toMatchObject({ code: 'target-deleted' });
  const layout = await author('pages');
  const pages = (
    await prepareComponentInsertion({
      ...basis(current),
      ...layout,
      reuse: 'copy',
      target: { afterId: 'page' },
    })
  ).preview as SlideContent;
  expect(pages.slides).toHaveLength(2);
  expect(pages.slides[0]).toEqual(current.slides[0]);
  expect(pages.slides[1].notes).toBe(current.slides[0].notes);
  await expect(
    prepareComponentInsertion({
      ...basis(current),
      ...layout,
      reuse: 'linked',
      target: { slidePageId: 'page' },
    }),
  ).rejects.toMatchObject({ code: 'slide-target' });
});

it('adopts page layout styles while preserving local text/runs, geometry overrides, notes, page order and the other pin', async () => {
  const value = await author('pages'),
    current = deck();
  let content = current;
  for (const requestId of ['first', 'second'])
    content = (
      await prepareComponentInsertion({ ...basis(content), ...value, requestId, reuse: 'linked' })
    ).preview as SlideContent;
  const first = content.slides[1];
  first.notes = '案件の発表者ノート\n改行も維持';
  first.objects[1].text = '独自の本文';
  first.objects[1].runs = [{ text: '独自の本文', style: { bold: true } }];
  first.objects[0].bounds.x = 99;
  const before = clone(content);
  const update = await revised(value.definition, (d) => {
    d.slides[0].background = '#ddeeff';
    d.slides[0].notes = '新しい標準ノート';
    d.slides[0].objects[0].fill = '#336699';
    d.slides[0].objects[0].typography!.fontSize = 32;
    d.slides[0].objects[0].bounds.x = 70;
    d.slides[0].objects[1].fill = '#224466';
  });
  const diff = await previewComponentUpdate({
    ...basis(content),
    ...update,
    selections: [
      { instanceId: 'reuse_first', choice: 'adopt' },
      { instanceId: 'reuse_second', choice: 'pin' },
    ],
  });
  expect(diff.conflicts).toEqual([]);
  const next = applyLocalTemplate(diff.prepared!, content) as SlideContent;
  expect(next.slides.map((p) => p.id)).toEqual(before.slides.map((p) => p.id));
  expect([next.width, next.height]).toEqual([960, 540]);
  expect(next.slides[1].notes).toBe(first.notes);
  expect(next.slides[1].objects[1]).toMatchObject({
    text: '独自の本文',
    runs: first.objects[1].runs,
  });
  expect(next.slides[1].objects[0]).toMatchObject({
    fill: '#336699',
    typography: { fontSize: 32 },
    bounds: { x: 99 },
  });
  expect(next.slides[2]).toEqual(before.slides[2]);
  expect(exportSlideSvg(before, before.slides[1])).toContain('#112233');
  expect(exportSlideSvg(next, next.slides[1])).toContain('#336699');
  expect(exportSlideSvg(next, next.slides[1])).toContain('独自の本文');
  const wrongSize = await revised(value.definition, (d) => {
    d.width = 1000;
  });
  expect(
    (
      await previewComponentUpdate({
        ...basis(content),
        ...wrongSize,
        selections: [{ instanceId: 'reuse_first', choice: 'adopt' }],
      })
    ).conflicts,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'page-layout' })]));
});

it('shared in-page adoption/Undo retain a concurrent same-part body edit, and changed style ABA is stale', async () => {
  const value = await author(),
    content = (
      await prepareComponentInsertion({
        ...basis(deck()),
        ...value,
        reuse: 'linked',
        requestId: 'header',
        target: { slidePageId: 'page' },
      })
    ).preview as SlideContent;
  const codec = templateCodec('slide'),
    authority = new Authority(codec, initial('deck', codec, content));
  const update = await revised(value.definition, (d) => {
    d.slides[0].objects[0].fill = '#336699';
  });
  const prepare = () =>
    previewComponentUpdate({
      state: authority.snapshot(),
      identity,
      ...update,
      selections: [{ instanceId: 'reuse_header', choice: 'adopt' }],
    });
  const diff = (await prepare()).prepared!;
  const remote = { ...principal, actorId: 'B', clientId: 'b', sessionId: 'two' };
  const edit = (patch: object) => {
    const snapshot = authority.snapshot();
    const op = prepareEditorCommand(
      codec,
      snapshot,
      remote,
      command('edit', 'Remote edit', (current) => {
        const next = clone(current) as SlideContent;
        Object.assign(next.slides[0].objects[2], patch);
        return next;
      }),
    )!;
    expect(authority.commit(remote, op).status).toBe('accepted');
  };
  edit({ text: '同じ部品への共同編集' });
  expect(authority.commit(principal, diff.operation).status).toBe('accepted');
  expect(authority.undo(principal, diff.operation.operationId).status).toBe('accepted');
  expect((authority.snapshot().content as SlideContent).slides[0].objects[2]).toMatchObject({
    text: '同じ部品への共同編集',
    fill: '#112233',
  });
  const stale = (await prepare()).prepared!;
  edit({ fill: '#aabbcc' });
  edit({ fill: '#112233' });
  expect(authority.commit(principal, stale.operation).status).not.toBe('accepted');
});

it('keeps explicit default-equal public ownership through revision and resets only that property', async () => {
  const value = await author();
  const payload = clone(value.definition.payload);
  payload.contract.properties.push({
    id: 'color',
    label: '色',
    type: 'text',
    default: '#112233',
    targets: [{ partId: payload.contract.parts[0].id, field: 'fill' }],
  });
  const definition = await sealReusableDefinition({ ...value.definition, payload });
  const closure = await lockClosure([definitionRef(definition)], [definition]);
  const content = (
    await prepareComponentInsertion({
      ...basis(deck()),
      definition,
      closure,
      reuse: 'linked',
      requestId: 'owned',
      target: { slidePageId: 'page' },
      inputs: { color: '#112233' },
    })
  ).preview as SlideContent;
  const changed = clone(payload);
  changed.contract.properties.find((p) => p.id === 'color')!.default = '#336699';
  const update = await createReusableVersion(definition, { payload: changed });
  const diff = await previewComponentUpdate({
    ...basis(content),
    ...update,
    selections: [{ instanceId: 'reuse_owned', choice: 'adopt' }],
  });
  const next = diff.prepared!.preview as SlideContent;
  expect(next.slides[0].objects[2].fill).toBe('#112233');
  const reset = await prepareComponentProperties({
    ...basis(next),
    instanceId: 'reuse_owned',
    reset: ['color'],
  });
  expect((reset.preview as SlideContent).slides[0].objects[2].fill).toBe('#336699');
  expect(retainedComponent(reset.preview, 'reuse_owned').instance.inputs).toEqual({});
});

it('nested required Slide slots use real groups/pages, one Undo, reload and independent copy IDs', async () => {
  const source = deck();
  source.slides[0].objects = [
    {
      id: 'group',
      type: 'group',
      text: '',
      fill: '#ffffff',
      bounds: { x: 0, y: 0, width: 960, height: 540 },
    },
  ];
  const parent = await authorReusableComponent({
    domain: 'slide',
    content: source,
    ids: [],
    slide: 'objects',
    name: '囲み',
  });
  const payload = clone(parent.definition.payload);
  payload.contract.slots[0].min = 1;
  const definition = await sealReusableDefinition({ ...parent.definition, payload });
  const closure = await lockClosure([definitionRef(definition)], [definition]);
  const child = await author();
  const args = {
    ...basis(deck()),
    definition,
    closure,
    requestId: 'nested',
    target: { slidePageId: 'page' },
    slots: {
      [payload.contract.slots[0].id]: [
        {
          kind: 'component' as const,
          definition,
          closure,
          slots: { [payload.contract.slots[0].id]: [{ kind: 'component' as const, ...child }] },
        },
      ],
    },
  };
  const prepared = await prepareComponentInsertion({ ...args, reuse: 'linked' });
  const next = prepared.preview as SlideContent;
  expect(next.reuse!.instances).toHaveLength(3);
  expect(next.slides[0].objects[3].groupId).toBe(next.slides[0].objects[2].id);
  expect(next.slides[0].objects[4].groupId).toBe(next.slides[0].objects[3].id);
  expect(isDeck(JSON.parse(JSON.stringify(next)))).toBe(true);
  const authority = new Authority(templateCodec('slide'), args.state);
  expect(authority.commit(principal, prepared.operation).status).toBe('accepted');
  expect(authority.undo(principal, prepared.operation.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(args.state.content);
  const copy = (await prepareComponentInsertion({ ...args, reuse: 'copy', requestId: 'copy' }))
    .preview as SlideContent;
  expect(copy.reuse).toBeUndefined();
  expect(copy.slides[0].objects[2].id).not.toBe(next.slides[0].objects[2].id);
  await expect(
    prepareComponentSlot({
      ...basis(next),
      instanceId: 'reuse_nested',
      slotId: payload.contract.slots[0].id,
      values: [{ kind: 'component', ...(await author('pages')) }],
    }),
  ).rejects.toMatchObject({ code: 'slot-target' });
});

it('Slide materializes the same brand with explicit pixel units and resolved SVG output', () => {
  const content = deck();
  materializePartStyle(
    content,
    'title',
    resolveStyle(brandStyles[1], brandTokens, { instanceMode: 'dark' }),
    'ブランド',
  );
  const svg = exportSlideSvg(content, content.slides[0]);
  expect(svg).toContain('#99ccff');
  expect(svg).toContain('font-size="32"');
  expect(svg).toContain('Noto Sans CJK JP');
});
