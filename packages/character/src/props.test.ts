import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  poseAt,
  type CharacterDocument,
} from '@editor-platform/character-core';
import { missingJoints, propFrames, type CharacterPropMesh, type CharacterPropView } from './props';

const mesh: CharacterPropMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: '#888888',
  opacity: 1,
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function withProp(): CharacterDocument {
  return applyCharacterOperation(blockyFigure().doc, {
    type: 'addProp',
    prop: {
      id: 'arm',
      name: 'Arm',
      source: { kind: 'cad', artifactId: 'a', versionId: 'v', contentHash: 'b'.repeat(64) },
      placement: { translation: [100, 0, 0], rotation: [0, 0, 0, 1] },
      visible: true,
    },
  });
}

describe('prop frames (C2b)', () => {
  it('asks the view for the keyed joint values and places its meshes', () => {
    let d = withProp();
    d = applyCharacterOperation(d, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'prop-joint', id: 'arm', joint: 'j', property: 'angle' },
      tick: 0,
      value: 0.5,
      trackId: 't',
      keyId: 'k',
    });
    const asked: unknown[] = [];
    const view: CharacterPropView = {
      status: 'ready',
      joints: [{ id: 'j', name: 'J', values: [{ key: 'angle', saved: 0 }] }],
      draw: (values) => {
        asked.push(Object.fromEntries(values));
        return [{ mesh, matrix: identity }];
      },
    };
    const frames = propFrames(d, new Map([['arm', view]]), poseAt(d, d.actions[0]!, 0));
    expect(asked).toEqual([{ j: { angle: 0.5 } }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.instances[0]!.matrix.slice(12, 15)).toEqual([100, 0, 0]);
    // Rest pose: no keyed values, the version's own.
    propFrames(d, new Map([['arm', view]]), poseAt(d, null, 0));
    expect(asked[1]).toEqual({});
    expect(missingJoints(d, 'arm', view)).toEqual([]);
    // A view without that joint names it; a pending or failed view draws nothing.
    expect(missingJoints(d, 'arm', { ...view, joints: [] })).toEqual(['j']);
    expect(propFrames(d, new Map([['arm', { status: 'pending' }]]), poseAt(d, null, 0))).toEqual(
      [],
    );
  });
});
