import { describe, expect, it, vi } from 'vitest';
import { clone, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import {
  replaceDesignRaster,
  updateElement,
  makeDesignElement,
} from '@editor-platform/design/model';
import { designCreativeProposalDiff } from '@editor-platform/design/creative-proposal-diff';
import { CreativeProject, readCreativeMapping, type CreativeStorage } from './project';
import { characterMode } from './character-mode';
import { settingMode } from './setting-mode';
import {
  addCreativeGenerationLayer,
  emptyCreativeLayerPng,
  generateCreativeLayer,
  importCreativeRough,
  prepareCreativeLayerGeneration,
  setCreativeRoughVisible,
  type CreativeLayerPreparation,
} from './generation';
import { inspectGeneratedPng } from './generation-png';
import { createCreativeLayerHttpProvider } from './generation-http';
import { generatedPng } from '../../../../tests/fixtures/creative-host/generated-png';

async function fixture() {
  const artifacts = new MemoryStorage<Artifact<unknown>>();
  let mapping: unknown,
    writable = true,
    failMapping = false;
  const io: CreativeStorage = {
    artifacts,
    readMapping: async () => clone(mapping),
    writeMapping: async (v) => {
      if (failMapping) throw Error('write failed');
      mapping = clone(v);
    },
  };
  const p = await CreativeProject.open(characterMode, io, () => writable),
    card = p.cards[0],
    editor = await p.ensureDesign(card);
  await p.save({ rough: { itemId: card.id, frameId: 'candidate-1' } });
  const id = addCreativeGenerationLayer(p, card, 'candidate-1', '前髪', {
    x: 1,
    y: 2,
    width: 2,
    height: 2,
  });
  await p.save();
  const prepare = (options = {}) =>
    prepareCreativeLayerGeneration(
      p,
      card,
      'candidate-1',
      { elementId: id },
      { instructions: '前髪だけ清書', ...options },
    );
  return {
    p,
    card,
    editor,
    id,
    io,
    prepare,
    setWritable: (v: boolean) => {
      writable = v;
    },
    setFailure: (v: boolean) => {
      failMapping = v;
    },
  };
}
const result = (p: CreativeLayerPreparation, extra = {}) => ({
  requestId: p.request.id,
  src: generatedPng(),
  source: 'Host generator / run-1',
  license: 'Author grant',
  ...extra,
});

describe('rough to per-layer native editing', () => {
  it('reads old maps and saves an exact rough pin without copying content; reopens and never repins implicitly', async () => {
    const f = await fixture(),
      pin = clone(f.p.binding(f.card)!.rough!);
    const old = f.p.mapping;
    delete old.bindings[0].rough;
    expect(readCreativeMapping(old, 'character')).toEqual(old);
    expect(Object.keys(pin).sort()).toEqual(['frameId', 'versionId']);
    expect(pin.versionId).not.toBe(f.p.binding(f.card)!.design.versionId);
    const prep = await f.prepare(),
      before = clone(f.editor.content);
    const proposal = prep.preview(result(prep));
    expect(f.editor.content).toEqual(before);
    const diff = designCreativeProposalDiff.diff(before, proposal.preview.content);
    expect(diff.fallback).toEqual([]);
    expect(new Set(diff.changes.map((c) => c.elementId)).size).toBe(1);
    f.editor.acceptProposal(proposal.id);
    expect(f.editor.content.elements.find((e) => e.id === f.id)?.provenance).toMatchObject({
      source: expect.stringContaining(pin.versionId),
      license: 'Author grant',
    });
    expect(f.editor.content.elements.filter((e) => e.id !== f.id)).toEqual(
      before.elements.filter((e) => e.id !== f.id),
    );
    const accepted = clone(f.editor.content);
    f.editor.undo();
    expect(f.editor.content).toEqual(before);
    f.editor.redo();
    expect(f.editor.content).toEqual(accepted);
    await f.p.save();
    const reopened = await CreativeProject.open(characterMode, f.io, () => true),
      card = reopened.cards[0];
    expect(reopened.binding(card)?.rough).toEqual(pin);
    expect(reopened.editor(card)?.content).toEqual(accepted);
    const next = await prepareCreativeLayerGeneration(
      reopened,
      card,
      'candidate-1',
      { elementId: f.id },
      { instructions: '次の調整' },
    );
    expect(next.request.rough).toEqual(prep.request.rough);
    expect(next.request.currentSvg).not.toBe(prep.request.currentSvg);
    expect(JSON.stringify(reopened.mapping)).not.toContain('前髪');
  });
  it('imports a rough in one native Undo and hides only the pinned visible children', async () => {
    const f = await fixture(),
      before = clone(f.editor.content);
    const id = importCreativeRough(
      f.p,
      f.card,
      'candidate-1',
      generatedPng(),
      'AI rough / 1',
      'author',
    );
    expect(f.editor.content.elements.find((e) => e.id === id)?.name).toBe('ラフ画像');
    expect(f.editor.content.elements.find((e) => e.id === 'instance-candidate-1')?.hidden).toBe(
      true,
    );
    f.editor.undo();
    expect(f.editor.content).toEqual(before);
    f.editor.redo();
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const clean = addCreativeGenerationLayer(f.p, f.card, 'candidate-1', '服', {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    setCreativeRoughVisible(f.p, f.card, false);
    expect(f.editor.content.elements.find((e) => e.id === id)?.hidden).toBe(true);
    expect(f.editor.content.elements.find((e) => e.id === clean)?.hidden).not.toBe(true);
    setCreativeRoughVisible(f.p, f.card, true);
    expect(f.editor.content.elements.find((e) => e.id === id)?.hidden).toBe(false);
    expect(f.editor.content.elements.find((e) => e.id === 'instance-candidate-1')?.hidden).toBe(
      true,
    );
  });
  it('retains imported rough attribution as lineage while giving generated pixels their own source/license', async () => {
    const f = await fixture();
    const roughId = importCreativeRough(
      f.p,
      f.card,
      'candidate-1',
      generatedPng(4, 4, true),
      'Rough author',
      'Rough terms',
    );
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const id = addCreativeGenerationLayer(f.p, f.card, 'candidate-1', 'new', {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    await f.p.save();
    const prep = await prepareCreativeLayerGeneration(
      f.p,
      f.card,
      'candidate-1',
      { elementId: id },
      { instructions: 'clean' },
    );
    f.editor.acceptProposal(prep.preview(result(prep)).id);
    const provenance = f.editor.content.elements.find((e) => e.id === id)!.provenance!;
    expect(provenance.source).toContain('Host generator');
    expect(provenance.license).toBe('Author grant');
    expect(provenance.lineage).toContainEqual(
      expect.objectContaining({
        source: 'Rough author',
        license: 'Rough terms',
        elementId: roughId,
        versionId: f.p.binding(f.card)!.rough!.versionId,
      }),
    );
  });
  it('retains grouped and effective Instance raster sources from the exported rough, excluding hidden subtrees', async () => {
    const f = await fixture(),
      src = generatedPng(4, 4, true),
      other = generatedPng(3, 3, true);
    f.p.execute(f.card, updateElement('instance-candidate-1', { hidden: true }));
    const image = (id: string, source: string, parentId?: string) => ({
      ...makeDesignElement('image'),
      id,
      parentId,
      src,
      provenance: { src, source, license: `${source} terms` },
      bounds: { x: 1, y: 1, width: 4, height: 4 },
    });
    f.editor.execute({
      type: 'test-nested-rough',
      label: 'Group roughs and insert Component instances',
      apply: (c) => ({
        ...c,
        styles: [
          ...(c.styles ?? []),
          { id: 'hidden-rough', name: 'hidden', appearance: { hidden: true } },
        ],
        elements: [
          ...c.elements,
          { ...makeDesignElement('group'), id: 'rough-group', parentId: 'candidate-1' },
          image('grouped-rough', 'Grouped author', 'rough-group'),
          {
            ...makeDesignElement('group'),
            id: 'hidden-group',
            parentId: 'candidate-1',
            styleId: 'hidden-rough',
          },
          image('hidden-rough', 'Hidden author', 'hidden-group'),
          {
            ...makeDesignElement('instance'),
            id: 'rough-instance',
            componentId: 'rough-component',
            parentId: 'rough-group',
            overrides: {
              part: {
                src: other,
                provenance: { src: other, source: 'Override author', license: 'Override terms' },
              },
            },
          },
        ],
        components: [
          ...c.components,
          {
            id: 'rough-component',
            name: 'rough',
            width: 10,
            height: 10,
            template: makeDesignElement('rectangle'),
            elements: [
              image('part', 'Shared author'),
              { ...makeDesignElement('group'), id: 'hidden-part-group', styleId: 'hidden-rough' },
              image('hidden-part', 'Hidden Component author', 'hidden-part-group'),
            ],
          },
        ],
      }),
    });
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const prep = await f.prepare(),
      rough = clone(prep.request.rough),
      before = clone(f.editor.content);
    expect(rough.svg).toContain(src);
    expect(rough.svg).toContain(other);
    expect(rough.rasterSources).toEqual([
      { elementId: 'grouped-rough', source: 'Grouped author', license: 'Grouped author terms' },
      { elementId: 'rough-instance', source: 'Override author', license: 'Override terms' },
    ]);
    f.editor.acceptProposal(prep.preview(result(prep)).id);
    const accepted = clone(f.editor.content);
    expect(accepted.elements.find((e) => e.id === f.id)!.provenance!.lineage).toEqual([
      {
        src,
        source: 'Grouped author',
        license: 'Grouped author terms',
        artifactId: f.editor.id,
        versionId: rough.versionId,
        elementId: 'grouped-rough',
      },
      {
        src: other,
        source: 'Override author',
        license: 'Override terms',
        artifactId: f.editor.id,
        versionId: rough.versionId,
        elementId: 'rough-instance',
      },
    ]);
    f.editor.undo();
    expect(f.editor.content).toEqual(before);
    f.editor.redo();
    expect(f.editor.content).toEqual(accepted);
    await f.p.save();
    const reopened = await CreativeProject.open(characterMode, f.io, () => true);
    expect(reopened.editor(reopened.cards[0])!.content).toEqual(accepted);
    expect(
      (
        await prepareCreativeLayerGeneration(
          reopened,
          reopened.cards[0],
          'candidate-1',
          { elementId: f.id },
          { instructions: 'again' },
        )
      ).request.rough,
    ).toEqual(rough);
  });
  it('rejects a composite rough whose retained raster ancestry exceeds the native limit without truncating or publishing', async () => {
    const f = await fixture(),
      src = generatedPng();
    f.p.execute(f.card, updateElement('instance-candidate-1', { hidden: true }));
    f.editor.execute({
      type: 'many-roughs',
      label: '33 attributed roughs',
      apply: (c) => ({
        ...c,
        elements: [
          ...c.elements,
          ...Array.from({ length: 33 }, (_, i) => ({
            ...makeDesignElement('image'),
            id: `rough-${i}`,
            parentId: 'candidate-1',
            src,
            provenance: { src, source: `Author ${i}`, license: 'terms' },
          })),
        ],
      }),
    });
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const prep = await f.prepare(),
      before = clone(f.editor.content),
      revision = clone(f.editor.revision);
    expect(prep.request.rough.rasterSources).toHaveLength(33);
    expect(() => prep.preview(result(prep))).toThrow();
    expect(f.editor.content).toEqual(before);
    expect(f.editor.revision).toEqual(revision);
    expect(f.editor.proposals).toHaveLength(0);
  });
  it('keeps the previous pin and dirty protection if mapping save fails', async () => {
    const f = await fixture(),
      pin = clone(f.p.binding(f.card)?.rough);
    f.setFailure(true);
    await expect(
      f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } }),
    ).rejects.toThrow('write failed');
    expect(f.p.binding(f.card)?.rough).toEqual(pin);
    expect(f.p.mappingDirty).toBe(true);
    f.setFailure(false);
    await f.p.save();
    expect(f.p.binding(f.card)?.rough).toEqual(pin);
  });
  it('rejects a missing rough saved version on open instead of guessing the latest', async () => {
    const f = await fixture();
    const bad = f.p.mapping;
    bad.bindings[0].rough!.versionId = 'missing';
    await f.io.writeMapping(bad);
    await expect(CreativeProject.open(characterMode, f.io, () => true)).rejects.toThrow();
  });
  it('shares the same API with Setting Mode', async () => {
    const io: CreativeStorage = {
      artifacts: new MemoryStorage<Artifact<unknown>>(),
      readMapping: async () => undefined,
      writeMapping: async () => {},
    };
    const p = await CreativeProject.open(settingMode, io, () => true),
      card = p.cards[0];
    await p.ensureDesign(card);
    const frame = p.binding(card)!.chosenFrameId;
    await p.save({ rough: { itemId: card.id, frameId: frame } });
    const id = addCreativeGenerationLayer(p, card, frame, '屋根', {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    await p.save();
    const prep = await prepareCreativeLayerGeneration(
      p,
      card,
      frame,
      { elementId: id },
      { instructions: '屋根だけ清書' },
    );
    const proposal = prep.preview(result(prep));
    p.editor(card)!.rejectProposal(proposal.id);
    expect(p.editor(card)!.content.elements.find((e) => e.id === id)?.src).toBe(
      emptyCreativeLayerPng,
    );
  });
  it.each([
    'wrong-id',
    'extra-field',
    'wrong-size',
    'opaque',
    'empty',
    'broken',
    'no-source',
    'old-lineage',
  ])('rejects invalid generation %s without changes', async (kind) => {
    const f = await fixture(),
      prep = await f.prepare(),
      before = clone(f.editor.content);
    const extra =
      kind === 'wrong-id'
        ? { requestId: 'else' }
        : kind === 'extra-field'
          ? { address: { elementId: 'other' } }
          : kind === 'wrong-size'
            ? { src: generatedPng(3, 2) }
            : kind === 'opaque'
              ? { src: generatedPng(2, 2, true) }
              : kind === 'empty'
                ? { src: generatedPng(2, 2, false, true) }
                : kind === 'broken'
                  ? { src: 'data:image/png;base64,AA==' }
                  : kind === 'no-source'
                    ? { source: '' }
                    : { provenance: { source: 'old' } };
    expect(() => prep.preview(result(prep, extra))).toThrow();
    expect(f.editor.content).toEqual(before);
    expect(f.editor.proposals).toHaveLength(0);
  });
  it('takes immutable addresses and native source projections, never provider-supplied targets', async () => {
    const f = await fixture(),
      address = { elementId: f.id };
    const prep = await prepareCreativeLayerGeneration(
      f.p,
      { ...f.card, name: 'fake name', fields: [] },
      'candidate-1',
      address,
      { instructions: '清書' },
    );
    address.elementId = 'other';
    prep.request.target.address.elementId = 'evil';
    prep.request.rough.versionId = 'evil';
    expect(prep.request.settings.name).toBe(f.card.name);
    const proposal = prep.preview(result(prep));
    f.editor.acceptProposal(proposal.id);
    expect(f.editor.content.elements.find((e) => e.id === f.id)?.src).toBe(generatedPng());
  });
  it.each(['edit', 'source', 'pin', 'permission', 'lock'])(
    'revalidates %s between preview and apply',
    async (kind) => {
      const f = await fixture();
      let read = true;
      const prep = await f.prepare({ mayRead: () => read });
      const proposal = prep.preview(result(prep));
      if (kind === 'edit') f.p.execute(f.card, updateElement(f.id, { opacity: 0.5 }));
      if (kind === 'source')
        f.p.source.execute(
          f.p.mode.edit(
            f.p.source.content,
            f.card,
            f.card.fields.find((x) => x.editable)!.id,
            'changed',
          ),
        );
      if (kind === 'pin') await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-2' } });
      if (kind === 'permission') read = false;
      if (kind === 'lock') f.p.execute(f.card, updateElement(f.id, { locked: true }));
      expect(() => f.editor.acceptProposal(proposal.id)).toThrow();
      expect(f.editor.content.elements.find((e) => e.id === f.id)?.src).toBe(emptyCreativeLayerPng);
    },
  );
  it('rejects readonly, unsaved, deleted, locked, hidden, transformed and out-of-frame layers', async () => {
    const f = await fixture();
    f.setWritable(false);
    await expect(f.prepare()).rejects.toThrow();
    f.setWritable(true);
    for (const patch of [
      { locked: true },
      { hidden: true },
      { rotation: 5 },
      { bounds: { x: 99999, y: 0, width: 2, height: 2 } },
    ]) {
      f.p.execute(f.card, updateElement(f.id, patch));
      await f.p.save();
      await expect(f.prepare()).rejects.toThrow();
      f.editor.undo();
      await f.p.save();
    }
    f.p.execute(f.card, updateElement(f.id, { opacity: 0.5 }));
    await expect(f.prepare()).rejects.toThrow('保存');
  });
  it('distinguishes Instance and shared edits with explicit revocable shared authority', async () => {
    const f = await fixture(),
      image = {
        ...makeDesignElement('image'),
        id: 'gen-eye',
        src: emptyCreativeLayerPng,
        bounds: { x: 1, y: 1, width: 2, height: 2 },
      };
    // Author inserts a native Component image; results themselves can only replace existing pixels.
    f.editor.execute({
      type: 'test-image',
      label: 'add image',
      apply: (c) => ({
        ...c,
        components: c.components.map((v) =>
          v.id === 'component-character' ? { ...v, elements: [...v.elements!, image] } : v,
        ),
      }),
    });
    await f.p.save();
    const shared = { componentId: 'component-character', elementId: 'gen-eye' };
    let allowed = true;
    await expect(
      prepareCreativeLayerGeneration(f.p, f.card, 'candidate-1', shared, { instructions: 'eyes' }),
    ).rejects.toThrow('許可');
    const local = await prepareCreativeLayerGeneration(
      f.p,
      f.card,
      'candidate-1',
      { ...shared, instanceId: 'instance-candidate-1' },
      { instructions: 'eyes' },
    );
    f.editor.acceptProposal(local.preview(result(local)).id);
    expect(
      f.editor.content.elements.find((e) => e.id === 'instance-candidate-1')?.overrides?.['gen-eye']
        ?.src,
    ).toBe(generatedPng());
    expect(
      f.editor.content.elements.find((e) => e.id === 'instance-candidate-2')?.overrides?.[
        'gen-eye'
      ],
    ).toBeUndefined();
    await f.p.save();
    const prep = await prepareCreativeLayerGeneration(f.p, f.card, 'candidate-1', shared, {
      instructions: 'eyes',
      mayEditShared: () => allowed,
    });
    const proposal = prep.preview(result(prep));
    allowed = false;
    expect(() => f.editor.acceptProposal(proposal.id)).toThrow();
    allowed = true;
    f.editor.acceptProposal(proposal.id);
    expect(
      f.editor.content.components
        .find((c) => c.id === 'component-character')
        ?.elements?.find((e) => e.id === 'gen-eye')?.src,
    ).toBe(generatedPng());
    f.editor.execute({
      type: 'test-nested',
      label: 'nested instance target',
      apply: (c) => ({
        ...c,
        components: [
          ...c.components.map((v) =>
            v.id === 'component-character'
              ? {
                  ...v,
                  elements: [
                    ...v.elements!,
                    { ...makeDesignElement('instance'), id: 'inner', componentId: 'nested-leaf' },
                  ],
                }
              : v,
          ),
          {
            id: 'nested-leaf',
            name: 'Leaf',
            width: 10,
            height: 10,
            template: { type: 'shape' as const, text: '', fill: 'none' },
          },
        ],
      }),
    });
    await f.p.save();
    await expect(
      prepareCreativeLayerGeneration(
        f.p,
        f.card,
        'candidate-1',
        { ...shared, elementId: 'inner' },
        {
          instructions: 'eyes',
          mayEditShared: () => true,
        },
      ),
    ).rejects.toThrow();
  });
  it('revalidates before disclosing a request to the provider', async () => {
    const f = await fixture();
    let canRead = true;
    const prep = await f.prepare({ mayRead: () => canRead });
    const provider = { generate: vi.fn(async () => result(prep)) };
    canRead = false;
    await expect(
      generateCreativeLayer(prep, provider, new AbortController().signal),
    ).rejects.toThrow('権限');
    expect(provider.generate).not.toHaveBeenCalled();
  });
  it('flushes native buffered input before provider submission and rejects the stale request', async () => {
    const f = await fixture(),
      prep = await f.prepare();
    let buffered = true;
    f.editor.registerInputBoundary(() => {
      if (buffered) {
        buffered = false;
        f.p.execute(f.card, updateElement(f.id, { opacity: 0.4 }));
      }
    });
    const provider = { generate: vi.fn(async () => result(prep)) };
    await expect(
      generateCreativeLayer(prep, provider, new AbortController().signal),
    ).rejects.toThrow('変更');
    expect(provider.generate).not.toHaveBeenCalled();
    expect(f.editor.content.elements.find((e) => e.id === f.id)?.opacity).toBe(0.4);
  });
  it('rejects a lock supplied by an Instance parent style before provider submission', async () => {
    const f = await fixture();
    f.editor.execute({
      type: 'test-style',
      label: 'parent style fixture',
      apply: (c) => ({
        ...c,
        styles: [
          ...(c.styles ?? []),
          { id: 'guarded-parent', name: 'locked', appearance: { locked: true } },
        ],
        components: c.components.map((v) =>
          v.id === 'component-character'
            ? {
                ...v,
                elements: [
                  ...v.elements!,
                  {
                    ...makeDesignElement('image'),
                    id: 'styled-image',
                    parentId: 'group-face',
                    src: emptyCreativeLayerPng,
                    bounds: { x: 1, y: 1, width: 2, height: 2 },
                  },
                ],
              }
            : v,
        ),
        elements: c.elements.map((e) =>
          e.id === 'instance-candidate-1'
            ? { ...e, overrides: { ...e.overrides, 'group-face': { styleId: 'guarded-parent' } } }
            : e,
        ),
      }),
    });
    await f.p.save();
    await expect(
      prepareCreativeLayerGeneration(
        f.p,
        f.card,
        'candidate-1',
        {
          instanceId: 'instance-candidate-1',
          componentId: 'component-character',
          elementId: 'styled-image',
        },
        { instructions: 'clear' },
      ),
    ).rejects.toThrow('親group');
  });
  it('does not reveal rough layers that were hidden through a native style', async () => {
    const f = await fixture();
    f.editor.execute({
      type: 'test-hidden-style',
      label: 'hidden fixture',
      apply: (c) => ({
        ...c,
        styles: [
          ...(c.styles ?? []),
          { id: 'rough-hidden', name: 'hidden', appearance: { hidden: true } },
        ],
        elements: c.elements.map((e) => (e.id === f.id ? { ...e, styleId: 'rough-hidden' } : e)),
      }),
    });
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const before = clone(f.editor.content.elements.find((e) => e.id === f.id));
    setCreativeRoughVisible(f.p, f.card, false);
    setCreativeRoughVisible(f.p, f.card, true);
    expect(f.editor.content.elements.find((e) => e.id === f.id)).toEqual(before);
  });
  it('retains unsaved original provenance across many native brush strokes, generation and reload', async () => {
    const f = await fixture(),
      original = generatedPng(2, 2, true),
      edited = generatedPng();
    const rough = importCreativeRough(
      f.p,
      f.card,
      'candidate-1',
      original,
      'Rough artist',
      'Original terms',
    );
    const imported = clone(f.editor.content);
    for (let n = 0; n < 41; n++)
      f.p.execute(
        f.card,
        replaceDesignRaster(f.editor.content, rough, n % 2 ? original : edited, 'paint'),
      );
    const painted = f.editor.content.elements.find((e) => e.id === rough)!;
    expect(painted.provenance).toMatchObject({
      src: edited,
      source: 'Creative Host / native pixel edit',
      license: 'Original terms',
    });
    expect(painted.provenance!.lineage).toEqual([
      expect.objectContaining({
        src: original,
        source: 'Rough artist',
        license: 'Original terms',
        artifactId: f.editor.id,
        elementId: rough,
      }),
    ]);
    expect(painted.provenance!.lineage![0]).not.toHaveProperty('versionId');
    expect(f.editor.content.elements.filter((e) => e.id !== rough)).toEqual(
      imported.elements.filter((e) => e.id !== rough),
    );
    f.editor.undo();
    expect(f.editor.content.elements.find((e) => e.id === rough)?.src).toBe(original);
    f.editor.redo();
    await f.p.save({ rough: { itemId: f.card.id, frameId: 'candidate-1' } });
    const clean = addCreativeGenerationLayer(f.p, f.card, 'candidate-1', 'clean', {
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    await f.p.save();
    const reopened = await CreativeProject.open(characterMode, f.io, () => true),
      card = reopened.cards[0];
    const prep = await prepareCreativeLayerGeneration(
      reopened,
      card,
      'candidate-1',
      { elementId: clean },
      { instructions: 'clean' },
    );
    expect(prep.request.rough.rasterSources[0].lineage).toContainEqual(
      expect.objectContaining({ source: 'Rough artist', license: 'Original terms' }),
    );
    expect(prep.request.rough.rasterSources[0].lineage![0]).not.toHaveProperty('src');
    const proposal = prep.preview(result(prep));
    reopened.editor(card)!.acceptProposal(proposal.id);
    const final = reopened.editor(card)!.content.elements.find((e) => e.id === clean)!.provenance!;
    expect(final.source).toContain('Host generator');
    expect(final.license).toBe('Author grant');
    expect(final.lineage).toContainEqual(
      expect.objectContaining({ source: 'Rough artist', license: 'Original terms', src: original }),
    );
    reopened.execute(card, updateElement(clean, { src: generatedPng(3, 2) }));
    expect(
      reopened.editor(card)!.content.elements.find((e) => e.id === clean)?.provenance,
    ).toBeUndefined();
  });
  it('records an exact pixel origin only when saved attribution also matches', async () => {
    for (const changeAttribution of [false, true]) {
      const f = await fixture(),
        src = generatedPng(2, 2, true),
        id = importCreativeRough(f.p, f.card, 'candidate-1', src, 'Original', 'Terms');
      await f.p.save();
      const versionId = f.editor.artifact.draft.baseVersionId;
      if (changeAttribution)
        f.p.execute(
          f.card,
          updateElement(id, {
            provenance: { src, source: 'Corrected author', license: 'Corrected terms' },
          }),
        );
      f.p.execute(f.card, replaceDesignRaster(f.editor.content, id, generatedPng(), 'paint'));
      const ancestor = f.editor.content.elements.find((e) => e.id === id)!.provenance!.lineage![0];
      expect(ancestor.source).toBe(changeAttribution ? 'Corrected author' : 'Original');
      if (changeAttribution) expect(ancestor).not.toHaveProperty('versionId');
      else expect(ancestor.versionId).toBe(versionId);
    }
  });
  it.each([{ rotation: 10 }, { flipX: true }, { flipY: true }])(
    'rejects top-level image transforms supplied by styles %j',
    async (transform) => {
      const f = await fixture();
      f.editor.execute({
        type: 'test-transform-style',
        label: 'style transform fixture',
        apply: (c) => ({
          ...c,
          styles: [
            ...(c.styles ?? []),
            { id: 'transformed', name: 'transformed', appearance: transform },
          ],
          elements: c.elements.map((e) => (e.id === f.id ? { ...e, styleId: 'transformed' } : e)),
        }),
      });
      await f.p.save();
      await expect(f.prepare()).rejects.toThrow('回転なし画像');
    },
  );
  it.each(['resolve', 'reject'] as const)(
    'cancels an abort-ignoring provider before settlement and ignores late %s',
    async (outcome) => {
      const f = await fixture(),
        prep = await f.prepare(),
        controller = new AbortController();
      const before = {
        content: clone(f.editor.content),
        revision: f.editor.revision,
        undo: f.editor.peekHistory('undo'),
        redo: f.editor.peekHistory('redo'),
      };
      let release!: (value: unknown) => void, fail!: (reason: Error) => void;
      const old = new Promise<unknown>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      const provider = { generate: vi.fn(() => old) };
      const pending = generateCreativeLayer(prep, provider, controller.signal);
      const canceled = expect(pending).rejects.toThrow('中止');
      controller.abort();
      await canceled; // The old provider has deliberately NOT been released yet.
      expect(provider.generate).toHaveBeenCalledTimes(1);
      expect(f.editor.proposals).toHaveLength(0);
      const next = await f.prepare();
      let finish!: (value: unknown) => void;
      const second = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const following = generateCreativeLayer(
        next,
        { generate: () => second },
        new AbortController().signal,
      );
      if (outcome === 'resolve') release(result(prep, { source: 'old canceled request' }));
      else fail(Error('late canceled rejection'));
      await Promise.resolve();
      await Promise.resolve();
      expect(f.editor.proposals).toHaveLength(0);
      expect({
        content: f.editor.content,
        revision: f.editor.revision,
        undo: f.editor.peekHistory('undo'),
        redo: f.editor.peekHistory('redo'),
      }).toEqual(before);
      finish(result(next, { source: 'second request' }));
      const proposal = await following;
      expect(f.editor.proposals).toHaveLength(1);
      f.editor.acceptProposal(proposal.id);
      expect(f.editor.content.elements.find((e) => e.id === f.id)?.provenance?.source).toContain(
        'second request',
      );
      f.editor.undo();
      expect(f.editor.content).toEqual(before.content);
      f.editor.redo();
      expect(f.editor.content.elements.find((e) => e.id === f.id)?.provenance?.source).toContain(
        'second request',
      );
    },
  );
  it('cancels/ignores late provider output and keeps failure outside native history', async () => {
    const f = await fixture(),
      prep = await f.prepare(),
      controller = new AbortController();
    const provider = {
      generate: vi.fn(async () => {
        controller.abort();
        return result(prep);
      }),
    };
    await expect(generateCreativeLayer(prep, provider, controller.signal)).rejects.toThrow('中止');
    expect(f.editor.proposals).toHaveLength(0);
    await expect(generateCreativeLayer(prep, provider, controller.signal)).rejects.toThrow();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    await expect(
      generateCreativeLayer(
        prep,
        {
          generate: async () => {
            throw Error('unavailable');
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('unavailable');
    expect(f.editor.proposals).toHaveLength(0);
  });
});

describe('generation PNG and HTTP admission', () => {
  it.each([0, 1, 2, 3, 4])('decodes alpha from actual PNG filter %s', (filter) => {
    expect(inspectGeneratedPng(generatedPng(3, 2, false, false, filter))).toMatchObject({
      width: 3,
      height: 2,
      transparent: true,
      visible: true,
    });
  });
  it('checks actual transparency and malformed pixels', () => {
    expect(inspectGeneratedPng(emptyCreativeLayerPng)).toMatchObject({
      visible: false,
      transparent: true,
    });
    expect(inspectGeneratedPng(generatedPng(2, 2, true))).toMatchObject({
      visible: true,
      transparent: false,
    });
    expect(() => inspectGeneratedPng(generatedPng(2, 2, false, false, 5))).toThrow('filter');
    expect(() => inspectGeneratedPng(generatedPng().slice(0, -8))).toThrow();
  });
  it.each(['checksum', 'short', 'overrun'] as const)(
    'rejects PNG %s despite valid outer chunk CRC',
    (fault) => {
      expect(() => inspectGeneratedPng(generatedPng(2, 2, false, false, 0, fault))).toThrow();
    },
  );
  it('sends only the request contract to a Host endpoint, forwards abort and checks HTTP failures', async () => {
    const f = await fixture(),
      prep = await f.prepare(),
      controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(result(prep))));
    const provider = createCreativeLayerHttpProvider('/host/generate', fetcher);
    const proposal = await generateCreativeLayer(prep, provider, controller.signal);
    f.editor.rejectProposal(proposal.id);
    expect(fetcher).toHaveBeenCalledWith(
      '/host/generate',
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
        credentials: 'same-origin',
      }),
    );
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual(prep.request);
    fetcher.mockResolvedValue(new Response('', { status: 503 }));
    await expect(provider.generate(prep.request, controller.signal)).rejects.toThrow('503');
    fetcher.mockResolvedValue(new Response('broken'));
    await expect(provider.generate(prep.request, controller.signal)).rejects.toThrow();
  });
  it('bounds streaming HTTP bodies and rejects unsafe endpoint forms', async () => {
    for (const endpoint of ['http://host', '//host', '/\\host', '/host\n'])
      expect(() => createCreativeLayerHttpProvider(endpoint)).toThrow();
    const f = await fixture(),
      prep = await f.prepare(),
      cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    const provider = createCreativeLayerHttpProvider(
      '/gen',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );
    await expect(provider.generate(prep.request, new AbortController().signal)).rejects.toThrow(
      '大きすぎ',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
