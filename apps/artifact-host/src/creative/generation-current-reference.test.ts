import { describe, expect, it } from 'vitest';
import { clone, contentHash, MemoryStorage, type Artifact } from '@editor-platform/artifact-core';
import { CreativeProject, type CreativeStorage } from './project';
import { characterMode } from './character-mode';
import {
  addCreativeGenerationLayer,
  importCreativeRough,
  prepareCreativeLayerGeneration,
} from './generation';
import { generatedPng } from '../../../../tests/fixtures/creative-host/generated-png';

describe('all transmitted raster reference snapshots retain attribution', () => {
  it('pins current generated and later imported pixels separately from the old rough, through apply/history/reload', async () => {
    let mapping: unknown;
    const io: CreativeStorage = {
      artifacts: new MemoryStorage<Artifact<unknown>>(),
      readMapping: async () => clone(mapping),
      writeMapping: async (v) => {
        mapping = clone(v);
      },
    };
    const p = await CreativeProject.open(characterMode, io),
      card = p.cards[0],
      editor = await p.ensureDesign(card);
    const rough = importCreativeRough(
      p,
      card,
      'candidate-1',
      generatedPng(4, 4, true),
      'Rough source',
      'Rough terms',
    );
    await p.save({ rough: { itemId: card.id, frameId: 'candidate-1' } });
    const add = (name: string) =>
      addCreativeGenerationLayer(p, card, 'candidate-1', name, { x: 0, y: 0, width: 2, height: 2 });
    const prepare = (elementId: string) =>
      prepareCreativeLayerGeneration(
        p,
        card,
        'candidate-1',
        { elementId },
        { instructions: 'clean' },
      );
    const first = add('first');
    await p.save();
    const initial = await prepare(first);
    editor.acceptProposal(
      initial.preview({
        requestId: initial.request.id,
        src: generatedPng(),
        source: 'First generated source',
        license: 'First terms',
      }).id,
    );
    // This attributed image was not present in the original rough pin.
    const later = importCreativeRough(
      p,
      card,
      'candidate-1',
      generatedPng(3, 3, true),
      'Later source',
      'Later terms',
    );
    // Import deliberately hides older children; explicitly show the generated image too.
    p.execute(card, {
      type: 'show-generated',
      label: 'Show first generated layer',
      apply: (c) => ({
        ...c,
        elements: c.elements.map((e) => (e.id === first ? { ...e, hidden: false } : e)),
      }),
    });
    const second = add('second');
    await p.save();
    const saved = p.binding(card)!.design.versionId,
      prep = await prepare(second),
      before = clone(editor.content);
    expect(prep.request.rough.versionId).toBe(initial.request.rough.versionId);
    expect(prep.request.rough.rasterSources.map((s) => s.elementId)).toEqual([rough]);
    expect(prep.request.currentSvg).toContain(generatedPng());
    expect(prep.request.currentSvg).toContain(generatedPng(3, 3, true));
    expect(prep.request.currentReference).toMatchObject({
      artifactId: editor.id,
      versionId: saved,
      frameId: 'candidate-1',
      contentHash: await contentHash(before),
      rasterSources: [
        expect.objectContaining({
          elementId: first,
          source: expect.stringContaining('First generated source'),
          license: 'First terms',
        }),
        { elementId: later, source: 'Later source', license: 'Later terms' },
      ],
    });
    expect(saved).not.toBe(prep.request.rough.versionId);
    expect(JSON.stringify(prep.request.currentReference.rasterSources)).not.toContain('data:image');
    editor.acceptProposal(
      prep.preview({
        requestId: prep.request.id,
        src: generatedPng(),
        source: 'Second source',
        license: 'Second terms',
      }).id,
    );
    const accepted = clone(editor.content),
      provenance = accepted.elements.find((e) => e.id === second)!.provenance!;
    expect(provenance.source).toContain('Second source');
    expect(provenance.license).toBe('Second terms');
    expect(provenance.lineage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elementId: rough,
          versionId: initial.request.rough.versionId,
          source: 'Rough source',
          license: 'Rough terms',
        }),
        expect.objectContaining({
          elementId: first,
          versionId: saved,
          source: expect.stringContaining('First generated source'),
          license: 'First terms',
        }),
        expect.objectContaining({
          elementId: later,
          versionId: saved,
          source: 'Later source',
          license: 'Later terms',
        }),
      ]),
    );
    editor.undo();
    expect(editor.content).toEqual(before);
    editor.redo();
    expect(editor.content).toEqual(accepted);
    await p.save();
    const reopened = await CreativeProject.open(characterMode, io);
    expect(reopened.editor(reopened.cards[0])!.content).toEqual(accepted);
  });
});
