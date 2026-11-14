// GV2c (docs/cad/gulliver-world.md): a camera 10 km out and a prop raised 6.4 km (Laputa's
// greatest height, "four miles", Part III ch. 3) with the tracks that already exist.
import { describe, expect, it } from 'vitest';
import { poseAt } from './evaluate';
import { blockyFigure } from './fixtures';
import { characterLimits, type CharacterDocument } from './model';
import { applyCharacterOperation, freshCharacterId } from './operations';
import { validateCharacter } from './validation';

const codes = (v: unknown) => validateCharacter(v).map((d) => `${d.code} ${d.path}`);
const second = 240_000;
const fourMilesMm = 4 * 1_609_344;
const island = {
  id: 'laputa',
  name: 'Laputa',
  source: {
    kind: 'cad' as const,
    artifactId: 'art-laputa',
    versionId: 'v-1',
    contentHash: 'c'.repeat(64),
  },
  placement: {
    translation: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  },
  visible: true,
};
function key(
  d: CharacterDocument,
  target:
    | { kind: 'prop'; id: string; property: 'translation' }
    | { kind: 'camera'; property: 'position' | 'target' },
  tick: number,
  value: [number, number, number],
) {
  const name = target.kind === 'prop' ? `rise/${target.property}` : `cam/${target.property}`;
  return applyCharacterOperation(d, {
    type: 'setKey',
    actionId: d.actions[0]!.id,
    target,
    tick,
    value,
    trackId: freshCharacterId(d, name),
    keyId: freshCharacterId(d, `${name}#${tick}`),
  } as never);
}

describe('Laputa range (ST-643, TS-2305)', () => {
  it('a camera key may stand 10 km out; one millimetre more is refused', () => {
    expect(characterLimits.cameraRangeMm).toBe(10_000_000);
    expect(characterLimits.jointTravelMm).toBe(1_000_000);
    let d = blockyFigure().doc;
    d = key(d, { kind: 'camera', property: 'position' }, 0, [0, -10_000_000, 3_000_000]);
    d = key(d, { kind: 'camera', property: 'target' }, 0, [0, 0, fourMilesMm]);
    expect(codes(d)).toEqual([]);
    const far = structuredClone(d);
    far.actions[0]!.tracks.find((t) => t.target.kind === 'camera')!.keys[0]!.value = [
      0, -10_000_001, 0,
    ];
    expect(codes(far).some((c) => c.startsWith('camera-range '))).toBe(true);
  });

  it('the whole island rises four miles on its translation track, with no new limit', () => {
    let d = applyCharacterOperation(blockyFigure().doc, { type: 'addProp', prop: island });
    d = key(d, { kind: 'prop', id: 'laputa', property: 'translation' }, 0, [0, 0, 0]);
    d = key(d, { kind: 'prop', id: 'laputa', property: 'translation' }, second, [
      0,
      0,
      fourMilesMm,
    ]);
    expect(codes(d)).toEqual([]);
    const at = (tick: number) => poseAt(d, d.actions[0]!, tick).props.get('laputa')!.translation;
    expect(at(0)).toEqual([0, 0, 0]);
    expect(at(second / 2)).toEqual([0, 0, fourMilesMm / 2]);
    expect(at(second)).toEqual([0, 0, 6_437_376]);
  });
});
