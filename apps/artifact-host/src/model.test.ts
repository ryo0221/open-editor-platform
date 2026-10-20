import { expect, it } from 'vitest';
import {
  MemoryStorage,
  createArtifact,
  commitVersion,
  contentHash,
  updateDraft,
} from '@editor-platform/artifact-core';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import { createDeck, addSlide, placeSlideAnimation } from '@editor-platform/slide/model';
import { createRectangleAnimation, createAnimationEmbed } from '@editor-platform/animation-core';
import { isDesign } from '@editor-platform/design/model';
import { exportDesignReact, convertDesignToReact } from '@editor-platform/design-react-core';
import { setCell, isStructuredData } from '@editor-platform/structured-data/model';
import { defaultView, viewRows } from '@editor-platform/structured-data/views';
import {
  domainExecute,
  hostAdapters,
  nativeResolution,
  productDesign,
  referenceArtifacts,
} from './model';
import { compileProject } from './compiler';
it('opens all five declared Host adapters with valid native contents and existing Session', () => {
  for (const artifact of referenceArtifacts()) {
    const host = new ArtifactEditor(artifact, hostAdapters[artifact.kind], new MemoryStorage());
    expect(host.snapshot.kind).toBe(artifact.kind);
    expect(host.snapshot.canUndo).toBe(false);
    expect(host.capabilities.shared).toBe(false);
  }
});
it('exports actual native Design through the public bridge into independently compilable React files', () => {
  const design = productDesign('Public native bridge');
  expect(isDesign(design)).toBe(true);
  expect(convertDesignToReact(design).diagnostics).toEqual([]);
  const bundle = exportDesignReact(design, nativeResolution);
  expect(bundle.files['ProductPage.tsx']).toBeDefined();
  expect(bundle.files['native.json']).toContain('Public native bridge');
  const compiled = compileProject(bundle.files, 'ProductPage.tsx', 'ProductPage');
  expect(compiled.entry).toBe('ProductPage.tsx');
  expect(Object.values(compiled.modules).join('')).not.toContain('@editor-platform/');
});
it('Grid and Kanban use the same Data record/values and normal setCell command', async () => {
  const artifact = referenceArtifacts().find((a) => a.kind === 'data')!;
  if (!isStructuredData(artifact.draft.content)) throw Error('Invalid fixture');
  artifact.draft.content.rows = [
    {
      id: 'task-stable',
      values: {
        [artifact.draft.content.columns[0].id]: 'Task',
        [artifact.draft.content.columns[1].id]: 'Planned',
      },
    },
  ];
  const host = new ArtifactEditor(artifact, hostAdapters.data, new MemoryStorage());
  const status = artifact.draft.content.columns[1].id;
  domainExecute(host, isStructuredData)(setCell('task-stable', status, 'Done'));
  const content = host.snapshot.content;
  if (!isStructuredData(content)) throw Error('Invalid result');
  const grid = defaultView(content),
    kanban = { ...grid, projection: 'Kanban' as const, groupBy: status };
  expect(viewRows(content, grid)).toEqual(viewRows(content, kanban));
  expect(content.rows[0]).toEqual({
    id: 'task-stable',
    values: { ...artifact.draft.content.rows[0].values, [status]: 'Done' },
  });
  expect((await host.save()).artifact.draft.content).toEqual(content);
  host.undo();
  expect(host.snapshot.content).toEqual(artifact.draft.content);
});
it('Code compilation rejects external/dynamic imports, malformed syntax and missing entry', () => {
  for (const source of [
    "import x from 'external'; export default x;",
    "export default import('react');",
    'export default function(){ return <h1>',
  ])
    expect(() => compileProject({ 'Code.tsx': source }, 'Code.tsx')).toThrow();
  expect(() => compileProject({}, 'Code.tsx')).toThrow(/Missing TSX entry/);
});

it('refuses Animation in current or retained Slide pages in the SVG-only Host', async () => {
  const source = createRectangleAnimation();
  const embed = createAnimationEmbed(
    {
      artifactId: 'motion',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: await contentHash(source),
    },
    source,
    'Motion',
  );
  for (const laterPage of [false, true]) {
    let deck = createDeck();
    if (laterPage) deck = addSlide().apply(deck);
    deck = placeSlideAnimation(deck.slides.at(-1)!.id, embed, 'motion-object').apply(deck);
    const saved = await commitVersion(
      createArtifact('slide', 'Motion deck', deck),
      'host-test',
      'Saved',
    );
    expect(hostAdapters.slide.validate(saved.draft.content)).toBe(false);
    await expect(loadHostArtifact(JSON.stringify(saved), hostAdapters.slide)).rejects.toThrow();
    await expect(
      hostAdapters.slide.export!('svg', deck, new AbortController().signal),
    ).rejects.toThrow(/Animation/);
    const historical = updateDraft(saved, createDeck());
    await expect(
      loadHostArtifact(JSON.stringify(historical), hostAdapters.slide),
    ).rejects.toThrow();
  }
  const staticDeck = createDeck();
  const saved = await commitVersion(
    createArtifact('slide', 'Static deck', staticDeck),
    'host-test',
    'Saved',
  );
  expect((await loadHostArtifact(JSON.stringify(saved), hostAdapters.slide)).id).toBe(saved.id);
  expect(await hostAdapters.slide.export!('svg', staticDeck, new AbortController().signal)).toEqual(
    [expect.objectContaining({ text: expect.stringContaining('<svg') })],
  );
});
