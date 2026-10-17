import { it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { animationFixture } from './fixtures';
import {
  putRectangleLayerV1,
  removeAnimationTrackV1,
  prepareRectangleAnimationV1,
  evaluateAnimation,
  type AnimationContent,
  type AnimationContentV1,
} from './index';
const fixture = (): AnimationContentV1 =>
  ({
    ...animationFixture(),
    schemaVersion: 1,
    ticksPerSecond: 240000,
    assets: [],
  }) as AnimationContentV1;
it('layer edits are owned, validated, stale/revoked guarded and use existing history', () => {
  const c = fixture(),
    s = new EditorSession<AnimationContent>(c);
  let allowed = true;
  const scope = { canEdit: () => allowed };
  const layer = structuredClone(c.compositions[0].layers[0]);
  layer.transform.opacity = 0.4;
  const command = putRectangleLayerV1(c, 'root', layer, scope);
  layer.transform.opacity = 0.9;
  s.execute(command);
  expect(s.content.compositions[0].layers[0].transform.opacity).toBe(0.4);
  expect(() => s.execute(command)).toThrow('stale');
  s.undo();
  expect(s.content).toEqual(c);
  s.redo();
  const before = s.content;
  allowed = false;
  expect(() => s.execute(putRectangleLayerV1(before, 'root', layer, scope))).toThrow('read-only');
  expect(s.content).toEqual(before);
  allowed = true;
  layer.transform.opacity = 2;
  expect(() => s.execute(putRectangleLayerV1(before, 'root', layer, scope))).toThrow();
  expect(s.content).toEqual(before);
});
it('removing the last track restores base evaluation and undo restores animation', async () => {
  const c = fixture(),
    s = new EditorSession<AnimationContent>(c),
    scope = { canEdit: () => true };
  const track = c.compositions[0].tracks[0];
  s.execute(removeAnimationTrackV1(c, 'root', track.id, scope));
  const scene = evaluateAnimation(await prepareRectangleAnimationV1(s.content), 'root', 120000);
  expect(scene.rectangles[0].matrix[4]).toBe(c.compositions[0].layers[0].transform.x);
  s.undo();
  expect(s.content).toEqual(c);
  s.redo();
  const before = s.content;
  expect(() => s.execute(removeAnimationTrackV1(before, 'root', 'missing', scope))).toThrow(
    'missing-track',
  );
  expect(s.content).toEqual(before);
});
it('rejects cyclic parent changes and missing compositions atomically', () => {
  const c = fixture(),
    s = new EditorSession<AnimationContent>(c),
    scope = { canEdit: () => true };
  const layer = structuredClone(c.compositions[0].layers[0]);
  layer.parentId = layer.id;
  expect(() => s.execute(putRectangleLayerV1(c, 'root', layer, scope))).toThrow();
  expect(s.canUndo).toBe(false);
  expect(() => s.execute(putRectangleLayerV1(c, 'absent', layer, scope))).toThrow(
    'missing-composition',
  );
  expect(s.content).toEqual(c);
});
