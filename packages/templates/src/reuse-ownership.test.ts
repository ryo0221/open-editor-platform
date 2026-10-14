import { expect, it } from 'vitest';
import { clone, deepFreeze } from '@editor-platform/artifact-core';
import type { DocumentContent } from '@editor-platform/document/model';
import { authorReusableComponent } from './reuse-definition';
import { prepareComponentInsertion, prepareComponentProperties } from './reuse-apply';
import { prepareComponentSlot } from './reuse-slots';
import { previewComponentUpdate } from './reuse-update';
import { localTemplateSnapshot, applyLocalTemplate } from './apply';
import { createReusableVersion } from './reuse-catalog';
import { applicationSnapshot } from './reuse-preparation';

const identity = { actorId: 'A', clientId: 'a', sessionId: 'a' };
const initial: DocumentContent = {
  schemaVersion: 2,
  blocks: [{ id: 'outside', type: 'paragraph', text: '確定した本文' }],
};
async function fixture() {
  const source = await authorReusableComponent({
    domain: 'document',
    content: initial,
    name: '注意書き',
    ids: [],
  });
  const state = localTemplateSnapshot('artifact', 'document', initial);
  const inputs = {
    [source.definition.payload.contract.properties.find((p) => p.type === 'text')!.id]:
      '依頼時の入力',
  };
  const inserted = applyLocalTemplate(
    await prepareComponentInsertion({
      ...source,
      state,
      identity,
      inputs,
      reuse: 'linked',
      requestId: 'one',
    }),
    initial,
  ) as DocumentContent;
  return { source, state, inputs, inserted, instanceId: inserted.reuse!.instances[0].id };
}
it('owns insertion state, identity and public inputs before the caller can mutate them across an await', async () => {
  const { source, state, inputs } = await fixture();
  const options: Parameters<typeof prepareComponentInsertion>[0] = clone({
    ...source,
    state,
    identity,
    inputs,
    reuse: 'linked',
    requestId: 'owned',
  });
  const pending = prepareComponentInsertion(options);
  options.inputs![Object.keys(inputs)[0]] = '遅い入力';
  (options.state.content as DocumentContent).blocks[0].text = '遅い本文';
  options.identity.actorId = 'B';
  const prepared = await pending;
  expect(prepared.operation.actorId).toBe('A');
  expect((prepared.preview as DocumentContent).blocks.map((b) => b.text)).toEqual([
    '確定した本文',
    '依頼時の入力',
  ]);
});
it('prepares against a retained immutable native basis and returns an isolated editable preview', async () => {
  const { source, inserted } = await fixture();
  const state = deepFreeze(localTemplateSnapshot('immutable', 'document', inserted));
  const before = clone(state);
  const prepared = await prepareComponentInsertion({
    ...source,
    state,
    identity,
    reuse: 'linked',
    requestId: 'immutable',
  });
  expect(state).toEqual(before);
  (prepared.preview as DocumentContent).blocks[0].text = 'preview edit';
  const projection = applicationSnapshot(prepared);
  expect((projection.content as DocumentContent).blocks[0].text).toBe('確定した本文');
  expect(() => {
    (projection.content as DocumentContent).blocks[0].text = 'mutate';
  }).toThrow();
  projection.engineVersion = 10000;
  expect(applicationSnapshot(prepared).engineVersion).not.toBe(10000);
  expect(state).toEqual(before);
  expect((prepared.base as DocumentContent).blocks[0].text).toBe('確定した本文');
  const result = applyLocalTemplate(prepared, inserted) as DocumentContent;
  expect(result.blocks[0].text).toBe('確定した本文');
  expect(result.reuse!.instances).toHaveLength(2);
  prepared.operation.actorId = 'changed';
  expect(() => applicationSnapshot(prepared)).toThrow(/operation changed/);
});
it('owns property, slot and update requests while preserving the captured native body and selection', async () => {
  const { source, inputs, inserted, instanceId } = await fixture();
  const propertyOptions = {
    state: localTemplateSnapshot('artifact', 'document', inserted),
    identity: clone(identity),
    instanceId,
    inputs: { [Object.keys(inputs)[0]]: '公開入力の変更' },
  };
  const properties = prepareComponentProperties(propertyOptions);
  (propertyOptions.state.content as DocumentContent).blocks[0].text = '後から変更した本文';
  propertyOptions.identity.actorId = 'B';
  const changed = await properties;
  expect(changed.operation.actorId).toBe('A');
  expect((changed.preview as DocumentContent).blocks[0].text).toBe('確定した本文');

  const body: DocumentContent = {
    schemaVersion: 2,
    blocks: [{ id: 'body', type: 'paragraph', text: '依頼時の補足' }],
  };
  const slotOptions: Parameters<typeof prepareComponentSlot>[0] = {
    state: localTemplateSnapshot('artifact', 'document', inserted),
    identity: clone(identity),
    instanceId,
    slotId: source.definition.payload.contract.slots[0].id,
    values: [{ kind: 'body', content: body }],
  };
  const slot = prepareComponentSlot(slotOptions);
  body.blocks[0].text = '後から変更した補足';
  slotOptions.identity.actorId = 'B';
  const appended = await slot;
  expect(appended.operation.actorId).toBe('A');
  expect((appended.preview as DocumentContent).blocks.map((b) => b.text)).toContain('依頼時の補足');

  const payload = clone(source.definition.payload);
  (payload.template.content as DocumentContent).blocks[0].style = { fontSize: 22 };
  const revised = await createReusableVersion(source.definition, { payload });
  const updateOptions: Parameters<typeof previewComponentUpdate>[0] = {
    ...revised,
    state: localTemplateSnapshot('artifact', 'document', inserted),
    identity: clone(identity),
    selections: [{ instanceId, choice: 'adopt' }],
  };
  const update = previewComponentUpdate(updateOptions);
  updateOptions.selections[0].choice = 'pin';
  const preview = await update;
  expect(preview.prepared).toBeDefined();
  expect((preview.prepared!.preview as DocumentContent).reuse!.instances[0].ref.version).toBe(2);
});
