import { applyCharacterOperation, blockyFigure, poseAt } from '@editor-platform/character-core';
import { describe, expect, it } from 'vitest';
import { morphWeightOperation } from './morph-inspector';

describe('a morph weight change (C6a, TS-1262)', () => {
  it('keys the weight at the playhead when an action is chosen, reusing its track', () => {
    const { doc } = blockyFigure();
    const wave = doc.actions.find((a) => a.id === 'wave')!;
    const op = morphWeightOperation(doc, 'chest-wide', 0.75, wave.id, 12000)!;
    expect(op).toMatchObject({
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'morph', id: 'chest-wide', property: 'weight' },
      tick: 12000,
      value: 0.75,
    });
    const next = applyCharacterOperation(doc, op);
    const after = next.actions.find((a) => a.id === 'wave')!;
    expect(poseAt(next, after, 12000).morphs.get('chest-wide')).toBeCloseTo(0.75);
    // The morph's track is the one it had: no second track drives it.
    const tracks = after.tracks.filter((t) => t.target.kind === 'morph');
    expect(tracks).toHaveLength(1);
    // The weight used without an action does not change.
    expect(next.morphs[0]!.weight).toBe(0);
  });

  it('sets the weight used without an action when none is chosen', () => {
    const { doc } = blockyFigure();
    const op = morphWeightOperation(doc, 'chest-wide', 0.5, undefined, 0)!;
    expect(op).toEqual({ type: 'setMorphWeight', id: 'chest-wide', weight: 0.5 });
    expect(poseAt(applyCharacterOperation(doc, op), null, 0).morphs.get('chest-wide')).toBe(0.5);
  });

  it('makes nothing for a morph or an action that is gone', () => {
    const { doc } = blockyFigure();
    expect(morphWeightOperation(doc, 'nope', 0.5, undefined, 0)).toBeUndefined();
    expect(morphWeightOperation(doc, 'chest-wide', 0.5, 'nope', 0)).toBeUndefined();
  });
});
