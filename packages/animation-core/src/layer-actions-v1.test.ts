import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  contentHash,
  createArtifact,
  commitVersion,
  updateDraft,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  inspectAnimationLayerSubtreeV1,
  duplicateAnimationLayerV1,
  removeAnimationLayerV1,
  prepareRectangleAnimationV1,
  evaluateAnimation,
  readAnimationV1,
  type AnimationContent,
} from './index';
import { animationLayerActionsFixture } from '../../../tests/fixtures/animation-layer-actions';

const scope = { canEdit: () => true };
function mapping(content = animationLayerActionsFixture(), layer = 'group') {
  const plan = inspectAnimationLayerSubtreeV1(content, 'root', layer);
  return [...plan.layerIds, ...plan.trackIds, ...plan.keyIds].map((sourceId) => ({
    sourceId,
    id: `copy-${sourceId}`,
  }));
}

it('reports the complete descendant scope without relying on parent-first/contiguous paint order', () => {
  const content = animationLayerActionsFixture(),
    before = canonicalJson(content);
  const plan = inspectAnimationLayerSubtreeV1(content, 'root', 'group');
  expect(plan).toEqual({
    layerIds: ['child', 'inner', 'group'],
    trackIds: ['child-x', 'group-opacity'],
    keyIds: ['child-start', 'child-end', 'group-start', 'group-end'],
  });
  expect(Object.isFrozen(plan.layerIds)).toBe(true);
  expect(canonicalJson(content)).toBe(before);
});

it('duplicates a subtree with new identities, remapped parents/targets and identical evaluation', async () => {
  const content = animationLayerActionsFixture(),
    session = new EditorSession<AnimationContent>(content);
  const ids = mapping(content),
    command = duplicateAnimationLayerV1(content, 'root', 'group', ids, scope);
  ids[0].id = 'mutated-after-preparation';
  session.execute(command);
  const next = readAnimationV1(session.content),
    c = next.compositions[0];
  expect(c.layers.slice(0, 6)).toEqual(content.compositions[0].layers);
  expect(c.layers.slice(6).map((l) => [l.id, l.parentId])).toEqual([
    ['copy-child', 'copy-inner'],
    ['copy-inner', 'copy-group'],
    ['copy-group', 'parent'],
  ]);
  expect(c.tracks.slice(0, 3)).toEqual(content.compositions[0].tracks);
  expect(c.tracks.slice(3).map((t) => [t.id, t.layerId, t.keys.map((k) => k.id)])).toEqual([
    ['copy-child-x', 'copy-child', ['copy-child-start', 'copy-child-end']],
    ['copy-group-opacity', 'copy-group', ['copy-group-start', 'copy-group-end']],
  ]);
  expect(next.compositions[1]).toEqual(content.compositions[1]);
  const prepared = await prepareRectangleAnimationV1(next);
  for (const tick of [0, 480000, 960000]) {
    const scene = evaluateAnimation(prepared, 'root', tick);
    const child = scene.rectangles.find((r) => r.layerId === 'child')!;
    const copy = scene.rectangles.find((r) => r.layerId === 'copy-child')!;
    expect(copy).toEqual({ ...child, layerId: 'copy-child', instancePath: ['root', 'copy-child'] });
    expect(scene.rectangles.at(-1)?.layerId).toBe('copy-child');
  }
  session.undo();
  expect(session.content).toEqual(content);
  session.redo();
  expect(session.content).toEqual(next);
});

it('deletes descendants and dependent tracks atomically while retaining siblings and other compositions', () => {
  const content = animationLayerActionsFixture(),
    session = new EditorSession<AnimationContent>(content);
  session.execute(removeAnimationLayerV1(content, 'root', 'group', scope));
  const next = session.content;
  expect(next.compositions[0].layers.map((l) => l.id)).toEqual(['outside', 'parent', 'sibling']);
  expect(next.compositions[0].tracks).toEqual([content.compositions[0].tracks[2]]);
  expect(next.compositions[1]).toEqual(content.compositions[1]);
  session.undo();
  expect(session.content).toEqual(content);
  expect(session.canUndo).toBe(false);
  session.redo();
  expect(session.content).toEqual(next);
});

it('duplicates a leaf without copying its ancestors, and can remove the final layer', () => {
  const content = animationLayerActionsFixture(),
    session = new EditorSession<AnimationContent>(content);
  session.execute(
    duplicateAnimationLayerV1(content, 'root', 'child', mapping(content, 'child'), scope),
  );
  expect(session.content.compositions[0].layers.at(-1)?.parentId).toBe('inner');
  session.execute(
    removeAnimationLayerV1(session.content, 'other-composition', 'other-layer', scope),
  );
  expect(session.content.compositions[1].layers).toEqual([]);
  expect(readAnimationV1(session.content)).toEqual(session.content);
});

it('preserves retained immutable version bytes/hash through edit, undo, redo and a new save', async () => {
  const saved = await commitVersion(
    createArtifact('animation', 'Motion', animationLayerActionsFixture()),
    'test',
    'Original',
  );
  const original = canonicalJson(saved.versions),
    originalHash = await contentHash(saved.versions);
  const session = new EditorSession<AnimationContent>(saved.draft.content);
  session.execute(
    duplicateAnimationLayerV1(
      session.content,
      'root',
      'group',
      mapping(saved.draft.content),
      scope,
    ),
  );
  session.undo();
  session.redo();
  const next = await commitVersion(
    updateDraft(saved, readAnimationV1(session.content)),
    'test',
    'Copied',
  );
  expect(canonicalJson(next.versions.slice(0, 1))).toBe(original);
  expect(await contentHash(next.versions.slice(0, 1))).toBe(originalHash);
  expect(next.versions[1].parentVersionId).toBe(saved.versions[0].versionId);
  expect(readAnimationV1(JSON.parse(JSON.stringify(next)).draft.content)).toEqual(session.content);
});

for (const kind of ['duplicate', 'remove'] as const)
  describe(kind, () => {
    const command = (
      content: AnimationContent,
      canEdit = scope,
      composition = 'root',
      layer = 'group',
    ) =>
      kind === 'duplicate'
        ? duplicateAnimationLayerV1(
            content,
            composition,
            layer,
            mapping(animationLayerActionsFixture()),
            canEdit,
          )
        : removeAnimationLayerV1(content, composition, layer, canEdit);
    it('refuses stale and revoked commands without content/history changes', () => {
      const content = animationLayerActionsFixture(),
        session = new EditorSession<AnimationContent>(content);
      let allowed = true;
      const prepared = command(content, { canEdit: () => allowed });
      allowed = false;
      expect(() => session.execute(prepared)).toThrow('read-only');
      expect(session.content).toEqual(content);
      expect(session.canUndo).toBe(false);
      allowed = true;
      const changed = structuredClone(content);
      changed.compositions[1].width++;
      const other = new EditorSession<AnimationContent>(changed);
      expect(() => other.execute(prepared)).toThrow('stale');
      expect(other.content).toEqual(changed);
      expect(other.canUndo).toBe(false);
    });
    it('rejects missing targets and prototype schemas atomically', () => {
      const content = animationLayerActionsFixture(),
        session = new EditorSession<AnimationContent>(content);
      for (const [composition, layer] of [
        ['missing', 'group'],
        ['root', 'missing'],
      ])
        expect(() => session.execute(command(content, scope, composition, layer))).toThrow(
          /missing-/,
        );
      expect(() => command({ ...content, schemaVersion: 'animation-prototype-0' })).toThrow(
        'expected-v1',
      );
      expect(session.content).toEqual(content);
      expect(session.canUndo).toBe(false);
    });
  });

for (const failure of [
  'missing',
  'extra',
  'collision',
  'duplicate-target',
  'duplicate-source',
  'invalid-id',
] as const)
  it(`rejects ${failure} identity mapping without a partial duplicate or history entry`, () => {
    const content = animationLayerActionsFixture(),
      session = new EditorSession<AnimationContent>(content),
      ids = mapping(content);
    if (failure === 'missing') ids.pop();
    if (failure === 'extra') ids.push({ sourceId: 'outside', id: 'copy-outside' });
    if (failure === 'collision') ids[0].id = 'other-layer';
    if (failure === 'duplicate-target') ids[0].id = ids[1].id;
    if (failure === 'duplicate-source') ids.push({ ...ids[0] });
    if (failure === 'invalid-id') ids[0].id = '';
    expect(() =>
      session.execute(duplicateAnimationLayerV1(content, 'root', 'group', ids, scope)),
    ).toThrow();
    expect(session.content).toEqual(content);
    expect(session.canUndo).toBe(false);
  });

it('supports valid IDs that are also Object prototype member names', () => {
  const content = animationLayerActionsFixture(),
    c = content.compositions[0];
  c.layers.find((l) => l.id === 'child')!.id = 'constructor';
  c.tracks[0].layerId = 'constructor';
  const ids = mapping(content),
    session = new EditorSession<AnimationContent>(content);
  session.execute(duplicateAnimationLayerV1(content, 'root', 'group', ids, scope));
  expect(session.content.compositions[0].layers.some((l) => l.id === 'copy-constructor')).toBe(
    true,
  );
});

it('refuses aggregate layer overflow without trimming the copy', () => {
  const content = animationLayerActionsFixture(),
    c = content.compositions[0];
  while (c.layers.length < 998)
    c.layers.push({ ...structuredClone(c.layers[1]), id: `filler-${c.layers.length}` });
  const session = new EditorSession<AnimationContent>(content);
  expect(() =>
    session.execute(duplicateAnimationLayerV1(content, 'root', 'group', mapping(content), scope)),
  ).toThrow('list-limit');
  expect(session.content).toEqual(content);
  expect(session.canUndo).toBe(false);
});

it('refuses aggregate key overflow without dropping animation', () => {
  const content = animationLayerActionsFixture(),
    c = content.compositions[0];
  c.tracks[2].keys = Array.from({ length: 19993 }, (_, tick) => ({
    id: `filler-key-${tick}`,
    tick,
    value: tick,
    easing: { type: 'linear' as const },
  }));
  const session = new EditorSession<AnimationContent>(content);
  expect(() =>
    session.execute(duplicateAnimationLayerV1(content, 'root', 'group', mapping(content), scope)),
  ).toThrow('key-limit');
  expect(session.content).toEqual(content);
  expect(session.canUndo).toBe(false);
});
