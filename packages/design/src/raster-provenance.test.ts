import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import { describe, expect, it } from 'vitest';
import {
  MemoryStorage,
  createArtifact,
  serializeArtifact,
  deserializeArtifact,
  commitVersion,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createDesign,
  createComponent,
  updateComponent,
  appearance,
  detachInstance,
  designDrawings,
  designInstanceElements,
  makeDesignElement,
  updateElement,
  patchDesign,
  updateComponentPart,
  overrideInstance,
  applyDesignOverride,
  isDesign,
  isDesignWithPaths,
  deriveDesignRasterProvenance,
  validDesignRasterProvenance,
  type DesignContent,
} from '@editor-platform/design/model';

const src = 'data:image/png;base64,AA==',
  replacement = 'data:image/png;base64,AQ==';
const provenance = { src, source: 'Original artist', license: 'CC0', name: 'Coat', version: '1' };
const image = (id: string) => ({ ...makeDesignElement('image'), id, src, provenance });
const fixture = (): DesignContent => ({
  ...createDesign(),
  elements: [image('coat'), image('background')],
});

it.each([1, 2, 3, 4] as const)(
  'reads legacy and attributed schema %i without migration',
  (schemaVersion) => {
    const d: DesignContent = {
      ...fixture(),
      schemaVersion,
      ...(schemaVersion === 4
        ? { pagination: { schemaVersion: 2, direction: 'ltr', pages: [], images: [] } }
        : {}),
    };
    expect(isDesignWithPaths(d)).toBe(true);
    expect(isDesign(d)).toBe(schemaVersion <= 2);
    delete d.elements[0].provenance;
    expect(isDesignWithPaths(d)).toBe(true);
  },
);
it('retains provenance through native artifact save/version/reload', async () => {
  const original = fixture();
  const a = await commitVersion(createArtifact('design', 'Attribution', original), null, 'Save');
  const restored = deserializeArtifact(serializeArtifact(a));
  expect(restored.draft.content).toEqual(original);
  expect(restored.versions[0].content).toEqual(original);
  expect(isDesignWithPaths(restored.draft.content)).toBe(true);
});
for (const edit of [
  updateElement,
  (id: string, patch: Parameters<typeof updateElement>[1]) => patchDesign([id], patch),
]) {
  it(`invalidates only replaced image provenance via ${edit.name || 'patchDesign'} with Undo/Redo`, () => {
    const session = new EditorSession(fixture());
    const original = session.content;
    session.execute(edit('coat', { src: replacement }));
    expect(session.content.elements[0].provenance).toBeUndefined();
    expect(session.content.elements[1]).toEqual(original.elements[1]);
    const next = session.content;
    session.undo();
    expect(session.content).toEqual(original);
    session.redo();
    expect(session.content).toEqual(next);
  });
}
it('replaces attribution atomically and preserves it for source-preserving edits', () => {
  const next = updateElement('coat', {
    src: replacement,
    provenance: { ...provenance, src: replacement, source: 'New artist' },
  }).apply(fixture());
  expect(next.elements[0].provenance?.source).toBe('New artist');
  const moved = patchDesign(['coat'], { opacity: 0.5 }).apply(next);
  expect(moved.elements[0].provenance).toEqual(next.elements[0].provenance);
  expect(() => updateElement('coat', { src: replacement, provenance }).apply(fixture())).toThrow(
    /provenance/,
  );
});
it('preview/reject leaves originals unchanged; applying native proposal changes one Undo unit', () => {
  const session = new EditorSession(fixture());
  const original = session.content;
  const proposal = {
    id: 'replacement',
    summary: 'Replace coat',
    commands: [
      updateElement('coat', { src: replacement, provenance: { ...provenance, src: replacement } }),
    ],
  };
  const adapter: EditorHostAdapter<DesignContent> = {
    kind: 'design',
    validate: isDesignWithPaths,
    capabilities: {
      undo: true,
      nativeJson: true,
      formats: [],
      preview: 'none',
      shared: false,
      proposals: true,
    },
  };
  const host = new ArtifactEditor(
    createArtifact('design', 'Images', fixture()),
    adapter,
    new MemoryStorage(),
  );
  const preview = host.propose(proposal).preview;
  expect(preview.content.elements[0].provenance?.src).toBe(replacement);
  expect(session.content).toEqual(original); // discarding preview is rejection
  expect(host.rejectProposal(proposal.id).outcome).toBe('rejected');
  expect(host.snapshot.content).toEqual(original);
  host.propose(proposal);
  host.acceptProposal(proposal.id);
  expect(host.snapshot.content).toEqual(preview.content);
  host.undo();
  expect(host.snapshot.content).toEqual(original);
  host.redo();
  expect(host.snapshot.content).toEqual(preview.content);
});
it('binds component and instance attribution to their effective source', () => {
  const part = image('coat');
  const d: DesignContent = {
    ...createDesign(),
    components: [
      {
        id: 'body',
        name: 'Body',
        width: 220,
        height: 160,
        template: { type: 'image', fill: '', text: '', src, provenance },
        elements: [part],
      },
    ],
    elements: [
      { ...makeDesignElement('instance'), id: 'A', componentId: 'body' },
      { ...makeDesignElement('instance'), id: 'B', componentId: 'body' },
    ],
  };
  const shared = updateComponentPart('body', 'coat', { src: replacement }).apply(d);
  expect(shared.components[0].elements![0].provenance).toBeUndefined();
  const local = overrideInstance('A', ['coat'], { src: replacement }).apply(d);
  expect(applyDesignOverride(part, local.elements[0].overrides?.coat).provenance).toBeUndefined();
  expect(applyDesignOverride(part, local.elements[1].overrides?.coat).provenance).toEqual(
    provenance,
  );
  expect(local.components).toEqual(d.components);
});
describe('lineage contract', () => {
  it('retains exact original bytes/reference and license without mutating the original', () => {
    const child = deriveDesignRasterProvenance(provenance, replacement, {
      elementId: 'original',
      artifactId: 'design',
      versionId: 'v1',
    });
    expect(child).toEqual({
      ...provenance,
      src: replacement,
      lineage: [{ ...provenance, elementId: 'original', artifactId: 'design', versionId: 'v1' }],
    });
    expect(provenance).not.toHaveProperty('lineage');
    expect(validDesignRasterProvenance(child)).toBe(true);
    expect(deriveDesignRasterProvenance(child, src).lineage).toHaveLength(2);
  });
  it.each([
    { ...provenance, license: '' },
    { ...provenance, lineage: [{}] },
    { ...provenance, lineage: Array(33).fill(provenance) },
    { ...provenance, unexpected: true },
  ])('rejects invalid provenance %j', (bad) => {
    expect(validDesignRasterProvenance(bad)).toBe(false);
    const d = fixture();
    d.elements[0].provenance = bad as typeof provenance;
    expect(isDesignWithPaths(d)).toBe(false);
  });
});

it('keeps attributed singleton component creation, override, reset and detach native', () => {
  const d = createComponent('coat', 'singleton').apply(fixture());
  expect(isDesign(d)).toBe(true);
  const instance = d.elements.find((e) => e.id === 'coat')!;
  expect(appearance(d, instance).provenance).toEqual(provenance);
  const updated = updateComponent('singleton', { src: replacement }).apply(d);
  expect(updated.components[0].template.provenance).toBeUndefined();
  const local = overrideInstance('coat', ['root'], { src: replacement }).apply(d);
  expect(
    appearance(local, local.elements.find((e) => e.id === 'coat')!).provenance,
  ).toBeUndefined();
  const detached = detachInstance('coat').apply(d);
  expect(detached.elements.find((e) => e.id === 'coat')!.provenance).toEqual(provenance);
});
it('refuses attribution on non-images or unresolved override targets', () => {
  const d = createComponent('coat', 'singleton').apply(fixture());
  const instance = d.elements.find((e) => e.id === 'coat')!;
  instance.overrides = { missing: { provenance } };
  expect(isDesign(d)).toBe(false);
  instance.overrides = { root: { type: 'text', provenance } };
  expect(isDesign(d)).toBe(false);
});

it('clears removed sources and provenance-only overrides when their inherited source changes', () => {
  expect(
    updateElement('coat', { src: undefined }).apply(fixture()).elements[0].provenance,
  ).toBeUndefined();
  let d = createComponent('coat', 'singleton').apply(fixture());
  d = overrideInstance('coat', ['root'], { provenance }).apply(d);
  const after = updateComponent('singleton', { src: replacement }).apply(d);
  expect(after.elements.find((e) => e.id === 'coat')!.overrides?.root.provenance).toBeUndefined();
  expect(isDesign(after)).toBe(true);
});

for (const scoped of [false, true])
  it(`replaces an already attributed image override with source only (${scoped ? 'path' : 'string'})`, () => {
    let d = createComponent('coat', 'singleton').apply(fixture());
    const target = scoped ? ['root'] : 'root';
    d = overrideInstance('coat', target, { src, provenance }).apply(d);
    const session = new EditorSession(d);
    session.execute(overrideInstance('coat', target, { src: replacement }));
    expect(
      appearance(session.content, session.content.elements.find((e) => e.id === 'coat')!)
        .provenance,
    ).toBeUndefined();
    expect(
      session.content.elements.find((e) => e.id === 'coat')!.overrides?.root.provenance,
    ).toBeUndefined();
    const after = session.content;
    session.undo();
    expect(session.content).toEqual(d);
    session.redo();
    expect(session.content).toEqual(after);
    expect(() =>
      overrideInstance('coat', target, { src: replacement, provenance }).apply(d),
    ).toThrow(/provenance/);
  });
it('clears retained attribution on an image override within a multipart component', () => {
  const initial = fixture();
  initial.elements[1].parentId = undefined;
  let d = createComponent(['coat', 'background'], 'composite').apply(initial);
  d = overrideInstance('coat', ['background'], { src, provenance }).apply(d);
  d = overrideInstance('coat', ['background'], { src: replacement }).apply(d);
  expect(d.elements[0].overrides?.background.provenance).toBeUndefined();
  expect(d.components[0].elements!.find((e) => e.id === 'background')!.provenance).toEqual(
    provenance,
  );
});

function nestedRasterFixture(): DesignContent {
  return {
    ...createDesign(),
    elements: [{ ...makeDesignElement('instance'), id: 'outer-instance', componentId: 'outer' }],
    components: [
      {
        id: 'leaf',
        name: 'Leaf',
        width: 220,
        height: 160,
        template: { type: 'image', text: '', fill: '', src },
      },
      {
        id: 'outer',
        name: 'Outer',
        width: 220,
        height: 160,
        template: { type: 'frame', text: '', fill: '' },
        elements: [{ ...makeDesignElement('instance'), id: 'child', componentId: 'leaf' }],
      },
    ],
  };
}
for (const typed of [false, true])
  for (const target of ['child', ['child', 'root']] as const)
    it(`preserves ${typed ? 'typed' : 'untyped'} provenance-only nested overrides on unrelated ${typeof target === 'string' ? 'legacy' : 'path'} edits`, async () => {
      const custom = { src, source: 'Custom instance artist', license: 'CC0' };
      const before = overrideInstance('outer-instance', ['child', 'root'], {
        ...(typed ? { type: 'image' as const } : {}),
        provenance: custom,
      }).apply(nestedRasterFixture());
      expect(Object.hasOwn(before.elements[0].overrides!.child.overrides!.root, 'src')).toBe(false);
      expect(before.elements[0].overrides!.child.overrides!.root.type).toBe(
        typed ? 'image' : undefined,
      );
      expect(isDesign(before)).toBe(true);
      expect(
        designInstanceElements(before, before.elements[0]).find((d) => d.id === 'child')
          ?.provenance,
      ).toEqual(custom);
      const session = new EditorSession(before);
      session.execute(overrideInstance('outer-instance', target, { opacity: 0.5 }));
      const after = session.content;
      expect(after.elements[0].overrides?.child.overrides?.root.provenance).toEqual(custom);
      expect(
        designInstanceElements(after, after.elements[0]).find((d) => d.id === 'child')?.provenance,
      ).toEqual(custom);
      const saved = await commitVersion(createArtifact('design', 'Nested', after), null, 'Save');
      const restored = deserializeArtifact(serializeArtifact(saved)).draft.content as DesignContent;
      expect(
        designInstanceElements(restored, restored.elements[0]).find((d) => d.id === 'child')
          ?.provenance,
      ).toEqual(custom);
      session.undo();
      expect(session.content).toEqual(before);
      session.redo();
      expect(session.content).toEqual(after);
    });
it('keeps shared replacement attribution identical before and after JSON/version reload', async () => {
  let d = fixture();
  d = createComponent(['coat', 'background'], 'body').apply(d);
  d = overrideInstance('coat', ['coat'], { provenance }).apply(d);
  const nextProvenance = { src: replacement, source: 'New shared artist', license: 'CC0' };
  const after = updateComponentPart('body', 'coat', {
    src: replacement,
    provenance: nextProvenance,
  }).apply(d);
  const definition = after.components[0].elements!.find((e) => e.id === 'coat')!;
  const beforeReload = applyDesignOverride(definition, after.elements[0].overrides?.coat);
  expect(beforeReload.provenance).toEqual(nextProvenance);
  expect(Object.hasOwn(after.elements[0].overrides!.coat, 'provenance')).toBe(false);
  const saved = await commitVersion(createArtifact('design', 'Shared', after), null, 'Save');
  const restored = deserializeArtifact(serializeArtifact(saved)).draft.content as DesignContent;
  const part = restored.components[0].elements!.find((e) => e.id === 'coat')!;
  expect(applyDesignOverride(part, restored.elements[0].overrides?.coat)).toEqual(beforeReload);
  expect(designDrawings(after, after.elements[0])).toEqual(
    designDrawings(restored, restored.elements[0]),
  );
});
it.each([false, true])(
  'still invalidates inherited-source nested attribution on source replacement (typed=%s)',
  (typed) => {
    let d = overrideInstance('outer-instance', ['child', 'root'], {
      ...(typed ? { type: 'image' as const } : {}),
      provenance,
    }).apply(nestedRasterFixture());
    d = overrideInstance('outer-instance', ['child', 'root'], { src: replacement }).apply(d);
    expect(d.elements[0].overrides?.child.overrides?.root).not.toHaveProperty('provenance');
    expect(designInstanceElements(d, d.elements[0]).find((e) => e.id === 'child')).toMatchObject({
      src: replacement,
    });
    expect(
      designInstanceElements(d, d.elements[0]).find((e) => e.id === 'child')?.provenance,
    ).toBeUndefined();
  },
);
