import { describe, expect, it } from 'vitest';
import { blockyFigure } from './fixtures';
import { poseAt } from './evaluate';
import { exportGlb } from './gltf-export';
import { characterLimits, type CharacterDocument, type CharacterTrack } from './model';
import { applyCharacterOperation } from './operations';
import { validateCharacter } from './validation';

// TS-1825, ST-295 (CR7e): the action's camera, keyed as position and target tracks.
describe('action camera (CR7e)', () => {
  const lin = { type: 'linear' } as const;
  const camera = (doc: CharacterDocument): CharacterDocument => {
    const next = structuredClone(doc);
    const wave = next.actions.find((a) => a.id === 'wave')!;
    wave.tracks.push(
      {
        id: 'wave/camera/position',
        target: { kind: 'camera', property: 'position' },
        keys: [
          { id: 'cp0', tick: 0, value: [0, -4000, 1000], easing: lin },
          { id: 'cp1', tick: wave.duration, value: [4000, 0, 1000], easing: lin },
        ],
      },
      {
        id: 'wave/camera/target',
        target: { kind: 'camera', property: 'target' },
        keys: [{ id: 'ct0', tick: 0, value: [0, 0, 900], easing: lin }],
      },
    );
    return next;
  };
  const codes = (doc: unknown) => validateCharacter(doc).map((d) => d.code);

  it('validates camera tracks: no element ID, Vec3 keys within the range, one track a property', () => {
    const { doc } = blockyFigure();
    const keyed = camera(doc);
    expect(codes(keyed)).toEqual([]);
    const edit = (f: (t: CharacterTrack[]) => void) => {
      const next = structuredClone(keyed);
      f(next.actions.find((a) => a.id === 'wave')!.tracks);
      return codes(next);
    };
    const cam = (t: CharacterTrack[]) => t.find((x) => x.id === 'wave/camera/position')!;
    expect(edit((t) => ((cam(t).target as { id?: string }).id = 'hip'))).toContain('unknown-key');
    expect(edit((t) => ((cam(t).target as { property: string }).property = 'fov'))).toContain(
      'target',
    );
    expect(edit((t) => (cam(t).keys[0]!.value = 3))).toContain('value');
    // An unknown property with a scalar key is reported, never thrown on.
    expect(
      edit((t) => {
        (cam(t).target as { property: string }).property = 'fov';
        for (const k of cam(t).keys) k.value = 35;
      }),
    ).toContain('target');
    expect(
      edit((t) => (cam(t).keys[0]!.value = [characterLimits.cameraRangeMm + 1, 0, 0])),
    ).toContain('camera-range');
    expect(edit((t) => t.push({ ...structuredClone(cam(t)), id: 'again' }))).toContain(
      'duplicate-target',
    );
  });

  it('samples the camera with the pose; an action without camera tracks has none', () => {
    const { doc } = blockyFigure();
    const keyed = camera(doc);
    const wave = keyed.actions.find((a) => a.id === 'wave')!;
    expect(poseAt(keyed, wave, wave.duration / 2).camera).toEqual({
      position: [2000, -2000, 1000],
      target: [0, 0, 900],
    });
    expect(poseAt(keyed, wave, wave.duration).camera?.position).toEqual([4000, 0, 1000]);
    expect(poseAt(doc, doc.actions.find((a) => a.id === 'wave')!, 0).camera).toBeUndefined();
    expect(poseAt(keyed, null, 0).camera).toBeUndefined();
  });

  it('keys both camera properties in one edit, and the glTF export names them as lost', () => {
    const { doc, meshes } = blockyFigure();
    const next = applyCharacterOperation(doc, {
      type: 'setKeys',
      actionId: 'wave',
      keys: [
        {
          target: { kind: 'camera', property: 'position' },
          tick: 0,
          value: [100, -3000, 1200],
          trackId: 'wave/camera/position',
          keyId: 'k-p',
        },
        {
          target: { kind: 'camera', property: 'target' },
          tick: 0,
          value: [0, 0, 1000],
          trackId: 'wave/camera/target',
          keyId: 'k-t',
        },
      ],
    });
    const tracks = next.actions.find((a) => a.id === 'wave')!.tracks;
    expect(tracks.filter((t) => t.target.kind === 'camera').map((t) => t.target)).toEqual([
      { kind: 'camera', property: 'position' },
      { kind: 'camera', property: 'target' },
    ]);
    // A second key of the same property joins its track.
    const again = applyCharacterOperation(next, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'camera', property: 'position' },
      tick: 1000,
      value: [0, -3000, 1200],
      trackId: 'other',
      keyId: 'k-p2',
    });
    expect(
      again.actions
        .find((a) => a.id === 'wave')!
        .tracks.filter((t) => t.target.kind === 'camera')
        .map((t) => t.keys.length),
    ).toEqual([2, 1]);
    expect(exportGlb(again, meshes, new Map()).losses).toContain('camera-track ×2');
  });
});
