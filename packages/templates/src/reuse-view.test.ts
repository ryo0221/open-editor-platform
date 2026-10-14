import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import type { ElementAddress } from '@editor-platform/editor-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import {
  annotationsToThreads,
  threadsToAnnotations,
} from '@editor-platform/collaboration-adapters';
import {
  createFile,
  originalBytes,
  type ReviewContent,
} from '@editor-platform/review-surfaces/model';
import { definitionRef, sealReusableDefinition } from '@editor-platform/reuse-core';
import { brandTokens } from '../../../tests/fixtures/reuse/brand';
import { MemoryCatalog, exportTemplatePack, importTemplatePack } from './catalog';
import { applyLocalTemplate, localTemplateSnapshot, templateCodec } from './apply';
import { validateReusableClosure } from './reuse-catalog';
import {
  authorReusableViewPreset,
  annotationSource,
  detachReusableViewPreset,
  editPrivateViewSettings,
  materializeReusableView,
  prepareReusableAnnotation,
  prepareReusableViewPreset,
  retainedViewPreset,
  validateReusableViewDefinition,
} from './reuse-view';
const identity = { actorId: 'A', clientId: 'a', sessionId: 'one' },
  principal = { ...identity, writable: true, scopes: ['*'] };
const review = (): ReviewContent => ({
  schemaVersion: 2,
  files: [
    {
      id: 'file',
      name: 'review.txt',
      oldText: '旧版\n確認',
      newText: '新版\n確認',
      oldRevision: 'before',
      newRevision: 'after',
    },
  ],
});
const address: ElementAddress = {
  artifactId: 'artifact',
  elementId: 'file',
  region: { type: 'lines', start: 1, end: 2, side: 'new', revisionId: 'after' },
};
const preset = () =>
  authorReusableViewPreset({
    domain: 'review',
    name: '比較と注釈',
    settings: { split: true, wrap: true },
    annotation: { body: '確認してください。', color: '#336699' },
  });

it('private exact presets retain default-equal overrides through reviewed updates, reset, copy, unlink and an empty catalog', async () => {
  const value = await preset(),
    adopted = await prepareReusableViewPreset({ ...value, current: {}, reuse: 'linked' });
  const owned = editPrivateViewSettings(adopted.settings, { split: true });
  const update = await authorReusableViewPreset({
    domain: 'review',
    name: value.definition.name,
    definitionId: value.definition.definitionId,
    version: 2,
    dependencies: value.closure.definitions,
    settings: { split: false, wrap: false },
    annotation: { body: '新しい確認', color: '#cc3300' },
  });
  const before = clone(owned),
    next = await prepareReusableViewPreset({ ...update, current: owned, reuse: 'linked' });
  expect(next.settings).toMatchObject({
    split: true,
    wrap: false,
    $annotation: { body: '新しい確認' },
  });
  expect(next.preserved).toEqual(['split']);
  expect(owned).toEqual(before);
  expect(
    (await retainedViewPreset(JSON.parse(JSON.stringify(next.settings))))!.definition.version,
  ).toBe(2);
  const reset = await prepareReusableViewPreset({
    ...update,
    current: next.settings,
    reuse: 'linked',
    reset: ['split'],
  });
  expect(reset.settings.split).toBe(false);
  const detached = detachReusableViewPreset(next.settings);
  expect(detached.$library).toBeUndefined();
  expect(detached.$annotation).toEqual(next.settings.$annotation);
  const copy = await prepareReusableViewPreset({ ...value, current: {}, reuse: 'copy' });
  expect(copy.settings.$library).toBeUndefined();
  const catalog = new MemoryCatalog([]);
  await catalog.putBundle({ templates: [], reusable: [value.closure] });
  await catalog.archiveReusable('personal', value.definition.definitionId, true);
  expect(await catalog.listReusable()).toEqual([]);
  expect((await retainedViewPreset(adopted.settings))!.definition.hash).toBe(value.definition.hash);
  const portable = await exportTemplatePack([], [value.closure]),
    other = new MemoryCatalog([]);
  await importTemplatePack(portable, other);
  expect((await other.getReusable(definitionRef(value.definition)))!.hash).toBe(
    value.definition.hash,
  );
});

it('preset publication rejects source/history/actor payloads, unknown settings and modified closure hashes', async () => {
  const value = await preset();
  const bad = await sealReusableDefinition({
    ...value.definition,
    payload: { ...value.definition.payload, annotation: { body: 'x', actor: 'other' } },
  });
  await expect(validateReusableViewDefinition(bad)).rejects.toThrow(/actor/);
  await expect(
    authorReusableViewPreset({ domain: 'file', name: 'bad', settings: { fit: 'other' } }),
  ).rejects.toThrow();
  const closure = clone(value.closure);
  closure.definitions[0].name = 'tampered';
  await expect(
    prepareReusableViewPreset({ ...value, closure, current: {}, reuse: 'linked' }),
  ).rejects.toThrow();
  await expect(
    materializeReusableView(value.definition, value.closure, {}, 'unknown'),
  ).rejects.toThrow(/Mode/);
});

it('Review annotation is bound to explicit source/revision/range, retains other authors and uses existing authority Undo/Redo', async () => {
  const value = await preset(),
    content = review(),
    codec = templateCodec('review'),
    authority = new Authority(codec, initial('artifact', codec, content));
  const source = await annotationSource('artifact', content, address),
    prepared = await prepareReusableAnnotation({
      state: authority.snapshot(),
      identity,
      ...value,
      source,
      requestId: 'review_annotation',
      createdAt: '2026-10-05T00:00:00.000Z',
    });
  const peer = { actorId: 'B', clientId: 'b', sessionId: 'two', writable: true, scopes: ['*'] };
  authority.commit(
    peer,
    operation(codec, authority.snapshot(), peer, [
      {
        type: 'thread.create',
        target: 'peer',
        payload: {
          anchor: { type: 'fixed', elementId: 'file', versionId: 'after', side: 'new' },
          createdAt: '2026-10-05T00:00:00.000Z',
        },
      },
      { type: 'thread.reply', target: 'peer', payload: { id: 'reply', text: '他の人のコメント' } },
    ]),
  );
  expect(
    authority.commit({ ...principal, writable: false }, prepared.application.operation).status,
  ).toBe('rejected');
  expect(authority.commit(principal, prepared.application.operation).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
  expect(authority.snapshot().threads).toHaveLength(2);
  const annotations = threadsToAnnotations('artifact', content, authority.snapshot().threads);
  expect(annotations[1]).toMatchObject({
    color: '#336699',
    anchor: { addresses: [address] },
    comments: [{ author: 'A', body: '確認してください。' }],
  });
  expect(annotationsToThreads('review', content, annotations)[1].color).toBe('#336699');
  const undo = authority.undo(principal, prepared.application.operation.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().threads.map((t) => t.id)).toEqual(['peer']);
  if (undo.status !== 'accepted') throw new Error('Undo failed');
  expect(authority.undo(principal, undo.operationId, true).status).toBe('accepted');
  expect(authority.snapshot().threads.find((t) => t.id === prepared.annotation.id)?.color).toBe(
    '#336699',
  );
  const modified = clone(content);
  modified.files[0].newText = 'changed without new ID\n確認';
  expect(() => applyLocalTemplate(prepared.application, modified)).toThrow();
  await expect(
    prepareReusableAnnotation({
      ...value,
      state: localTemplateSnapshot('artifact', 'review', modified),
      identity,
      source,
    }),
  ).rejects.toThrow(/Source/);
  await expect(
    annotationSource('artifact', content, {
      ...address,
      region: { type: 'lines', start: 1, end: 99, side: 'new', revisionId: 'after' },
    }),
  ).rejects.toThrow(/range/);
});

it.each(['text', 'image', 'pdf'] as const)(
  'Viewer %s preset/annotation leaves original bytes/hash and native revision unchanged',
  async (kind) => {
    const content = createFile(kind);
    if (kind === 'text') {
      content.data = '原本\r\n確認';
      content.originalData =
        'data:text/plain;base64,' +
        btoa('\xef\xbb\xbf' + unescape(encodeURIComponent(content.data)));
      content.size = originalBytes(content).length;
    }
    const before = originalBytes(content),
      hash = createHash('sha256').update(before).digest('hex');
    const region: ElementAddress['region'] =
      kind === 'text'
        ? { type: 'lines', start: 1, end: 2 }
        : kind === 'image'
          ? { type: 'canvas', x: 10, y: 20, width: 40, height: 30, units: 'image-pixels' }
          : {
              type: 'page',
              page: 1,
              bounds: { x: 10, y: 20, width: 40, height: 30 },
              units: 'pdf-points',
            };
    const chosen = { artifactId: 'artifact', elementId: content.id, region };
    const source = await annotationSource('artifact', content, chosen);
    expect(source.hash).toBe(hash);
    expect(source.revisionId).toBe(content.id);
    const value = await authorReusableViewPreset({
      domain: 'file',
      name: '原本の確認',
      settings: { fit: 'width' },
      annotation: { body: 'ここを確認', color: '#cc3300' },
    });
    expect(JSON.stringify(value.definition)).not.toContain(content.data);
    const codec = templateCodec('file'),
      authority = new Authority(codec, initial('artifact', codec, content));
    const prepared = await prepareReusableAnnotation({
      ...value,
      state: authority.snapshot(),
      identity,
      source,
    });
    expect(authority.commit(principal, prepared.application.operation).status).toBe('accepted');
    expect(originalBytes(authority.snapshot().content as typeof content)).toEqual(before);
    expect(createHash('sha256').update(originalBytes(content)).digest('hex')).toBe(hash);
    expect(authority.snapshot().content).toEqual(content);
    const immutable = clone(chosen),
      pending = annotationSource('artifact', content, immutable);
    immutable.elementId = 'other';
    expect((await pending).address).toEqual(chosen);
  },
);

it('retained token modes resolve only new annotation colors and survive private native-pack transport', async () => {
  const tokens = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'tokens',
    version: 1,
    kind: 'tokens',
    domain: 'shared',
    name: 'Brand',
    dependencies: [],
    payload: brandTokens,
  });
  const style = await sealReusableDefinition({
    schemaVersion: 1,
    libraryId: 'brand',
    definitionId: 'annotation',
    version: 1,
    kind: 'style',
    domain: 'review',
    name: '確認の色',
    dependencies: [definitionRef(tokens)],
    payload: {
      style: {
        schemaVersion: 1,
        domain: 'review',
        bindings: { 'annotation.color': { token: 'brand.primary' } },
      },
      tokens: definitionRef(tokens),
    },
  });
  const value = await authorReusableViewPreset({
    domain: 'review',
    name: 'Brand review',
    settings: {},
    style: definitionRef(style),
    dependencies: [tokens, style],
  });
  await validateReusableClosure(value.closure);
  const light = await materializeReusableView(value.definition, value.closure),
    dark = await materializeReusableView(value.definition, value.closure, {}, 'dark');
  expect(light.annotation.color).toBe('#336699');
  expect(dark.annotation.color).toBe('#99ccff');
  const settings = (
    await prepareReusableViewPreset({ ...value, current: {}, reuse: 'linked', mode: 'dark' })
  ).settings;
  const retained = await retainedViewPreset(JSON.parse(JSON.stringify(settings)));
  expect(retained!.adoption.mode).toBe('dark');
  const reset = await prepareReusableViewPreset({
    ...value,
    current: settings,
    reuse: 'linked',
    mode: null,
  });
  expect((reset.settings.$annotation as { color: string }).color).toBe('#336699');
  expect((await retainedViewPreset(reset.settings))!.adoption.mode).toBeUndefined();
  const unstyled = await authorReusableViewPreset({
    domain: 'review',
    name: value.definition.name,
    definitionId: value.definition.definitionId,
    version: 2,
    settings: {},
    annotation: { body: '固定色', color: '#cc3300' },
    dependencies: value.closure.definitions,
  });
  expect(unstyled.closure.definitions).toHaveLength(1);
  expect(unstyled.definition.dependencies).toEqual([]);
  await validateReusableClosure(unstyled.closure);
  expect(
    (await materializeReusableView(unstyled.definition, unstyled.closure)).annotation.color,
  ).toBe('#cc3300');
});

it('preset authoring accepts bounded generic definition IDs without leaking them into the legacy template identifier grammar', async () => {
  const value = await authorReusableViewPreset({
    domain: 'file',
    name: 'IDs',
    definitionId: '42:review/source',
    settings: {},
  });
  expect(value.definition.definitionId).toBe('42:review/source');
  await validateReusableClosure(value.closure);
});
