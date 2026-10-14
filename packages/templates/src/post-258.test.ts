import { expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { Authority, initial, operation } from '@editor-platform/collaboration-core';
import { isDesign, type DesignContent } from '@editor-platform/design/model';
import { exportDesignSvg } from '@editor-platform/design';
import { definitionRef } from '@editor-platform/reuse-core';
import {
  applyLocalTemplate,
  measureTemplateTextFit,
  patchReusablePart,
  retainedComponent,
  reusableParts,
  reusableNativeActions,
  saveAsTemplate,
  templateCodec,
  previewComponentUpdate,
} from '@editor-platform/templates';
import { vectorUpdateFixture } from '../../../tests/fixtures/design-reuse/post-258';
import { textLayoutReviewContent } from '../../../tests/fixtures/design-reuse/content';

it('adopts vector paths/viewBox/provenance with the exact ref and native/export roundtrip', async () => {
  const f = await vectorUpdateFixture();
  const before = JSON.stringify(f.current);
  const diff = await f.preview();
  expect(diff.conflicts).toEqual([]);
  expect(diff.changes).toContainEqual(expect.objectContaining({ field: 'vector', kind: 'update' }));
  const next = applyLocalTemplate(diff.prepared!, f.current) as DesignContent;
  expect(reusableParts(next).get(f.address)?.vector).toEqual(f.vector);
  expect(retainedComponent(next, 'reuse_vector').instance.ref).toEqual(definitionRef(f.definition));
  const reopened = JSON.parse(JSON.stringify(next));
  expect(isDesign(reopened)).toBe(true);
  expect(exportDesignSvg(reopened)).toContain('M0 0L12 12');
  expect(JSON.stringify(f.current)).toBe(before);
});

it.each([false, true])(
  'preserves locally owned vector including default-equal override=%s',
  async (equal) => {
    const f = await vectorUpdateFixture();
    const vector = clone(reusableParts(f.current).get(f.address)!.vector);
    if (!equal) Object.assign(vector!, { paths: ['M1 1L3 3'] });
    patchReusablePart(f.current, f.address, { vector }, true);
    const diff = await f.preview();
    expect(diff.changes).toContainEqual(
      expect.objectContaining({ field: 'vector', kind: 'preserve' }),
    );
    const next = applyLocalTemplate(diff.prepared!, f.current);
    expect(reusableParts(next).get(f.address)?.vector).toEqual(vector);
  },
);

it('rejects stale vector previews and shared Undo restores geometry and exact ref', async () => {
  const f = await vectorUpdateFixture();
  const codec = templateCodec('design');
  const authority = new Authority(codec, initial('artifact', codec, f.current));
  const principal = { ...f.identity, writable: true, scopes: ['*'] };
  const prepare = () =>
    previewComponentUpdate({
      state: authority.snapshot(),
      identity: f.identity,
      definition: f.definition,
      closure: f.closure,
      selections: [{ instanceId: 'reuse_vector', choice: 'adopt' }],
    });
  const diff = await prepare();
  expect(authority.commit(principal, diff.prepared!.operation).status).toBe('accepted');
  expect(authority.undo(principal, diff.prepared!.operation.operationId).status).toBe('accepted');
  expect(reusableParts(authority.snapshot().content).get(f.address)?.vector).toEqual(
    reusableParts(f.current).get(f.address)?.vector,
  );
  expect(retainedComponent(authority.snapshot().content, 'reuse_vector').instance.ref).toEqual(
    retainedComponent(f.current, 'reuse_vector').instance.ref,
  );
  const stale = await prepare();
  const content = clone(authority.snapshot().content) as DesignContent;
  patchReusablePart(content, f.address, { vector: f.vector }, true);
  const remote = { ...principal, actorId: 'remote', sessionId: 'remote' };
  expect(
    authority.commit(
      remote,
      operation(
        codec,
        authority.snapshot(),
        remote,
        reusableNativeActions(authority.snapshot(), remote, content),
      ),
    ).status,
  ).toBe('accepted');
  expect(authority.commit(principal, stale.prepared!.operation).status).not.toBe('accepted');
});

it('checks normalized effective rich run minimum without changing base, fit, empty or stale runs', () => {
  const input = {
    text: '確認',
    bounds: { width: 100, height: 100 },
    fontSize: 12,
    minFontSize: 10,
  };
  expect(
    measureTemplateTextFit({
      ...input,
      runs: [{ text: '確', style: { fontSize: 9 } }, { text: '認' }],
    }).fits,
  ).toBe(false);
  expect(
    measureTemplateTextFit({
      ...input,
      typography: { overflow: 'fit' },
      runs: [{ text: '確認', style: { fontSize: 9 } }],
    }).fits,
  ).toBe(false);
  expect(
    measureTemplateTextFit({ ...input, runs: [{ text: '確認', style: { fontSize: 10 } }] }).fits,
  ).toBe(true);
  expect(
    measureTemplateTextFit({ ...input, runs: [{ text: 'stale', style: { fontSize: 9 } }] }).fits,
  ).toBe(true);
  expect(
    measureTemplateTextFit({
      ...input,
      runs: [{ text: '', style: { fontSize: 9 } }, { text: '確認' }],
    }).fits,
  ).toBe(true);
  expect(
    measureTemplateTextFit({ ...input, text: '', runs: [{ text: '', style: { fontSize: 9 } }] })
      .fits,
  ).toBe(true);
});

it.each(['error', 'expand'] as const)(
  'rejects undersized instance runs during %s authoring',
  async (policy) => {
    const content = textLayoutReviewContent('run', true);
    const label = content.components
      .find((c) => c.id === 'inner')!
      .elements!.find((e) => e.type === 'text')!;
    label.bounds.height = 100;
    label.runs = [{ text: label.text, style: { fontSize: 9 } }];
    await expect(
      saveAsTemplate({
        domain: 'design',
        content,
        kind: 'whole',
        name: 'minimum',
        purpose: 'test',
        category: 'test',
        slots: [],
        overflow: { policy, minFontSize: 10 },
      }),
    ).rejects.toThrow(/does not fit/);
  },
);
