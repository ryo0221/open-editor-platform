import { EditorSession } from '@editor-platform/editor-core';
import { decodeEpm } from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  characterLimits,
  characterContentHash,
  characterEditorCommand,
  checkCharacterMeshes,
  emptyCharacter,
  eulerXyzToQuat,
  quatToEulerXyz,
  axisAngleQuat,
  freshCharacterId,
  isCharacterDocument,
  poseAt,
  characterIds,
  skinMatrices,
  skinnedPositions,
  validateCharacter,
  worldMatrices,
  type CharacterDocument,
} from './index';

const codes = (v: unknown) => validateCharacter(v).map((d) => `${d.code} ${d.path}`);
const edit = (fn: (d: CharacterDocument) => void) => {
  const d = structuredClone(blockyFigure().doc);
  fn(d);
  return d;
};

describe('character schema 1', () => {
  it('accepts the empty document and the fixture, with its meshes', () => {
    expect(codes(emptyCharacter())).toEqual([]);
    const f = blockyFigure();
    expect(codes(f.doc)).toEqual([]);
    expect(checkCharacterMeshes(f.doc, f.meshes)).toEqual([]);
    // The asset is the bytes the content names.
    expect(decodeEpm(f.assets.get('mesh-body')!)).toEqual(f.meshes.get('mesh-body'));
  });
  it('refuses other schemas and non-JSON values without reading further', () => {
    expect(codes({ ...emptyCharacter(), schemaVersion: 2 })).toEqual([
      'unsupported-schema $.schemaVersion',
    ]);
    expect(codes({ ...emptyCharacter(), name: NaN })).toEqual(['number $.name']);
    expect(codes([])).toEqual(['character-document $']);
  });
  it('names broken references, duplicates, cycles and bad values by path', () => {
    expect(codes(edit((d) => (d.parts[0].mesh = 'nope')))).toEqual(['mesh-asset $.parts[0].mesh']);
    expect(codes(edit((d) => (d.materials[1].id = 'mat-body')))).toContain(
      'duplicate-id $.materials[1].id',
    );
    expect(codes(edit((d) => (d.skeletons[0].bones[0].parentId = 'shin.R')))).toContain(
      'cycle $.skeletons[0].bones[0].parentId',
    );
    expect(codes(edit((d) => (d.parts[0].transform.rotation = [0, 0, 0, 2])))).toEqual([
      'unit-quaternion $.parts[0].transform.rotation',
    ]);
    expect(codes(edit((d) => (d.actions[0].tracks[0].keys[1].tick = 0)))).toEqual([
      'key-order $.actions[0].tracks[0].keys[1].tick',
    ]);
    expect(codes(edit((d) => (d.actions[0].tracks[0].keys[1].value = [1, 2, 3])))).toEqual([
      'value $.actions[0].tracks[0].keys[1].value',
    ]);
    expect(
      codes(edit((d) => ((d.actions[0].tracks[1].target as { id?: string }).id = 'arm.R'))),
    ).toEqual(['target-id $.actions[0].tracks[1].target.id']);
    expect(
      codes(edit((d) => ((d.materials[0] as unknown as Record<string, unknown>).extra = 1))),
    ).toEqual(['unknown-key $.materials[0].extra']);
    expect(codes(edit((d) => (d.skins[0].inverseBind[0].boneId = 'missing')))).toEqual([
      'bone $.skins[0].inverseBind[0].boneId',
    ]);
    // A non-string kind is a diagnostic, not a thrown coercion error.
    const oddKind = edit(
      (d) => ((d.assets[0] as unknown as Record<string, unknown>).kind = { toString: 0 }),
    );
    expect(codes(oddKind)).toContain('asset-kind $.assets[0].kind');
    expect(isCharacterDocument(oddKind)).toBe(false);
    const oddTarget = edit(
      (d) =>
        ((d.actions[0].tracks[0].target as unknown as Record<string, unknown>).id = {
          toString: 0,
        }),
    );
    expect(codes(oddTarget)).toContain('target-id $.actions[0].tracks[0].target.id');
    expect(isCharacterDocument(oddTarget)).toBe(false);
  });
  it('checks the document against its decoded meshes', () => {
    const f = blockyFigure();
    const noSlot = structuredClone(f.doc);
    noSlot.parts[0].materials = ['mat-body'];
    expect(checkCharacterMeshes(noSlot, f.meshes).map((d) => d.code)).toEqual(['material-slots']);
    const noMorph = structuredClone(f.doc);
    noMorph.morphs = [];
    noMorph.actions[0].tracks.pop();
    expect(checkCharacterMeshes(noMorph, f.meshes).map((d) => d.code)).toEqual(['morph-mismatch']);
    const noBind = structuredClone(f.doc);
    noBind.skins[0].inverseBind.pop();
    expect(checkCharacterMeshes(noBind, f.meshes).map((d) => d.code)).toEqual(['skin-bone']);
    expect(checkCharacterMeshes(f.doc, new Map()).map((d) => d.code)).toEqual(['mesh-missing']);
  });
});

describe('poses and skinning', () => {
  const f = blockyFigure();
  const mesh = f.meshes.get('mesh-body')!;
  const skin = f.doc.skins[0];
  const at = (actionId: string | null, tick: number) => {
    const pose = poseAt(f.doc, f.doc.actions.find((a) => a.id === actionId) ?? null, tick);
    const { bones } = worldMatrices(f.doc, pose);
    return { pose, positions: skinnedPositions(mesh, skinMatrices(skin, mesh, bones)) };
  };
  it('keeps the bind shape at rest', () => {
    const { positions } = at(null, 0);
    positions.forEach((x, i) => expect(x).toBeCloseTo(mesh.positions[i], 3));
  });
  it('samples rotations by slerp and morph weights by easing', () => {
    const half = at('wave', 60000).pose;
    const q = half.bones.get('arm.R')!.rotation;
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
    expect(2 * Math.acos(q[3])).toBeCloseTo(0.6, 6);
    expect(half.morphs.get('chest-wide')).toBeCloseTo(0.5, 9);
    // Hold after the last key, and clamped past the end.
    expect(at('wave', 240000).pose.morphs.get('chest-wide')).toBe(0);
    expect(at('wave', 999999).pose.bones.get('arm.R')!.rotation).toEqual([0, 0, 0, 1]);
  });
  it('raises the right hand with the arm and leaves the left one where it was', () => {
    const rest = at(null, 0).positions;
    const up = at('wave', 120000).positions;
    // Vertex 6×8+0 is the right forearm box's first corner (−x end).
    const v = 6 * 8;
    expect(up[3 * v + 2] - rest[3 * v + 2]).toBeGreaterThan(300);
    const left = 4 * 8;
    for (let k = 0; k < 3; k++) expect(up[3 * left + k]).toBeCloseTo(rest[3 * left + k], 3);
  });
});

describe('operations and commands', () => {
  it('renames and hides without touching anything else, and refuses unknown targets', () => {
    const doc = blockyFigure().doc;
    const next = applyCharacterOperation(doc, {
      type: 'setPartVisible',
      id: 'body',
      visible: false,
    });
    expect(next.parts[0].visible).toBe(false);
    expect(doc.parts[0].visible).toBe(true);
    expect({ ...next, parts: doc.parts }).toEqual(doc);
    expect(() =>
      applyCharacterOperation(doc, { type: 'rename', collection: 'parts', id: 'x', name: 'y' }),
    ).toThrow(/missing-target/);
    expect(() =>
      applyCharacterOperation(doc, {
        type: 'renameBone',
        skeletonId: 'rig',
        id: 'hip',
        name: '\u0007',
      }),
    ).toThrow(/name/);
  });
  it('replaces the whole document on re-import, validated, as one undoable edit', () => {
    const doc = blockyFigure().doc;
    const imported = structuredClone(doc);
    imported.name = 'Re-imported';
    imported.parts[0].visible = false;
    const session = new EditorSession(doc);
    session.execute(
      characterEditorCommand(
        { type: 'replaceDocument', document: imported },
        { expectedHash: characterContentHash(doc), canEdit: () => true },
      ),
    );
    expect(session.content).toEqual(imported);
    session.undo();
    expect(session.content).toEqual(doc);
    const broken = structuredClone(doc);
    broken.parts[0].mesh = 'nowhere';
    expect(() =>
      applyCharacterOperation(doc, { type: 'replaceDocument', document: broken }),
    ).toThrow();
  });
  it('runs as one EditorSession edit with undo, and refuses a stale base', () => {
    const doc = blockyFigure().doc;
    const session = new EditorSession(doc);
    const cmd = characterEditorCommand(
      { type: 'rename', collection: 'actions', id: 'wave', name: 'Hello' },
      { expectedHash: characterContentHash(doc), canEdit: () => true },
    );
    session.execute(cmd);
    expect(session.content.actions[0].name).toBe('Hello');
    session.undo();
    expect(session.content).toEqual(doc);
    session.execute(
      characterEditorCommand(
        { type: 'setPartVisible', id: 'body', visible: false },
        { expectedHash: characterContentHash(doc), canEdit: () => true },
      ),
    );
    expect(() =>
      session.execute(
        characterEditorCommand(
          { type: 'setPartVisible', id: 'body', visible: true },
          { expectedHash: characterContentHash(doc), canEdit: () => true },
        ),
      ),
    ).toThrow('character-base-mismatch');
    expect(() =>
      characterEditorCommand(
        { type: 'setPartVisible', id: 'body', visible: true },
        { expectedHash: characterContentHash(session.content), canEdit: () => false },
      ).apply(session.content),
    ).toThrow('permission-denied');
  });
});

describe('keyframes (C2a)', () => {
  const doc = () => blockyFigure().doc;
  const wave = (d: CharacterDocument) => d.actions.find((a) => a.id === 'wave')!;
  const arm = (d: CharacterDocument) =>
    wave(d).tracks.find((t) => t.target.kind === 'bone' && t.target.id === 'arm.R')!;
  it('inserts a key in order, replaces one at the same tick, and starts a new track', () => {
    const d = doc();
    const before = arm(d).keys.length;
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const at = arm(d).keys[0]!.tick + 1;
    let next = applyCharacterOperation(d, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'bone', id: 'arm.R', property: 'rotation' },
      tick: at,
      value: q,
      trackId: 'unused',
      keyId: 'k-new',
    });
    expect(arm(next).keys.map((k) => k.tick)).toEqual(
      [...arm(d).keys.map((k) => k.tick), at].sort((a, b) => a - b),
    );
    expect(arm(next).keys.length).toBe(before + 1);
    // Same tick: the value changes, the key and its easing stay.
    next = applyCharacterOperation(next, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'bone', id: 'arm.R', property: 'rotation' },
      tick: at,
      value: [0, 0, 0, 1],
      trackId: 'unused',
      keyId: 'k-other',
    });
    const k = arm(next).keys.find((x) => x.tick === at)!;
    expect(k).toMatchObject({ id: 'k-new', value: [0, 0, 0, 1], easing: { type: 'linear' } });
    // A target without a track gets one.
    next = applyCharacterOperation(next, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'bone', id: 'hip', property: 'translation' },
      tick: 0,
      value: [0, 0, 1000],
      easing: { type: 'hold' },
      trackId: freshCharacterId(next, 'wave/hip/translation'),
      keyId: freshCharacterId(next, 'wave/hip/translation#0'),
    });
    const hip = wave(next).tracks.find((t) => (t.target as { id?: string }).id === 'hip')!;
    expect(hip.keys).toEqual([
      { id: 'wave/hip/translation#0', tick: 0, value: [0, 0, 1000], easing: { type: 'hold' } },
    ]);
    // A value of the wrong shape is refused by the whole-document check.
    expect(() =>
      applyCharacterOperation(next, {
        type: 'setKey',
        actionId: 'wave',
        target: { kind: 'bone', id: 'hip', property: 'translation' },
        tick: 1,
        value: 3,
        trackId: 'x',
        keyId: 'y',
      }),
    ).toThrow();
  });
  it('moves keys together, refuses collisions and the action bounds, deletes and eases', () => {
    const d = doc();
    const t = arm(d);
    const [k0, k1] = t.keys;
    const address = (k: { id: string }) => ({ trackId: t.id, keyId: k.id });
    const gap = k1!.tick - k0!.tick;
    expect(() =>
      applyCharacterOperation(d, {
        type: 'moveKeys',
        actionId: 'wave',
        keys: [address(k0!)],
        delta: gap,
      }),
    ).toThrow(/key-collision/);
    expect(() =>
      applyCharacterOperation(d, {
        type: 'moveKeys',
        actionId: 'wave',
        keys: [address(k0!)],
        delta: -1 - k0!.tick,
      }),
    ).toThrow(/tick/);
    // Both together by the gap: no collision, since both move.
    const last = t.keys[t.keys.length - 1]!;
    if (last.tick + 1 <= wave(d).duration) {
      const moved = applyCharacterOperation(d, {
        type: 'moveKeys',
        actionId: 'wave',
        keys: t.keys.map(address),
        delta: 1,
      });
      expect(arm(moved).keys.map((k) => k.tick)).toEqual(t.keys.map((k) => k.tick + 1));
    }
    const eased = applyCharacterOperation(d, {
      type: 'setKeyEasing',
      actionId: 'wave',
      keys: [address(k0!)],
      easing: { type: 'bezier', x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
    });
    expect(arm(eased).keys[0]!.easing.type).toBe('bezier');
    const gone = applyCharacterOperation(d, {
      type: 'deleteKeys',
      actionId: 'wave',
      keys: t.keys.map(address),
    });
    expect(wave(gone).tracks.some((x) => x.id === t.id)).toBe(false);
    expect(() =>
      applyCharacterOperation(d, {
        type: 'deleteKeys',
        actionId: 'wave',
        keys: [{ trackId: t.id, keyId: 'nope' }],
      }),
    ).toThrow(/missing-target/);
  });
});

describe('pose angles', () => {
  it('turns XYZ degrees into a rotation and back, and matches a single-axis rotation', () => {
    for (const e of [
      [10, 20, 30],
      [-45, 60, 170],
      [0, 0, 90],
      [90, -30, 0],
    ] as [number, number, number][]) {
      const back = quatToEulerXyz(eulerXyzToQuat(e));
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(e[k]!, 6);
    }
    const z = axisAngleQuat([0, 0, 1], Math.PI / 2);
    const q = eulerXyzToQuat([0, 0, 90]);
    for (let k = 0; k < 4; k++) expect(q[k]).toBeCloseTo(z[k]!, 9);
  });
  it('gives angles of the same orientation at Y = ±90° (gimbal lock)', () => {
    for (const e of [
      [0, 90, 45],
      [30, 90, -20],
      [10, -90, 45],
      [-70, -90, 100],
    ] as [number, number, number][]) {
      const q = eulerXyzToQuat(e);
      const back = quatToEulerXyz(q);
      expect(back[0]).toBe(0);
      const r = eulerXyzToQuat(back);
      // The same rotation (q and -q are one orientation).
      expect(Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3])).toBeCloseTo(1, 9);
    }
  });
});

describe('fresh IDs', () => {
  it('stays within the ID limit for long action and bone IDs, with room for a suffix', () => {
    const doc = blockyFigure().doc;
    const long = `${'a'.repeat(70)}/${'b'.repeat(70)}/rotation`;
    const first = freshCharacterId(doc, long);
    expect([...first].length).toBeLessThanOrEqual(characterLimits.idCodePoints);
    expect(first.startsWith('a'.repeat(40))).toBe(true);
    const second = freshCharacterId(doc, long, new Set([first]));
    expect(second).toBe(`${first}-2`);
    expect([...second].length).toBeLessThanOrEqual(characterLimits.idCodePoints);
    // Two long bases that differ only past the cut get different IDs.
    expect(freshCharacterId(doc, `${long}x`)).not.toBe(first);
    expect(freshCharacterId(doc, 'wave/hip/rotation')).toBe('wave/hip/rotation');
  });
});

describe('props and joint keys (C2b)', () => {
  const hash = 'a'.repeat(64);
  const arm = {
    id: 'robot',
    name: 'Robot arm',
    source: { kind: 'cad' as const, artifactId: 'art-1', versionId: 'v-1', contentHash: hash },
    placement: {
      translation: [500, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    },
    visible: true,
  };
  const keyJoint = (
    d: CharacterDocument,
    joint: string,
    property: 'angle' | 'distance',
    tick: number,
    value: number,
  ) =>
    applyCharacterOperation(d, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'prop-joint', id: 'robot', joint, property },
      tick,
      value,
      trackId: freshCharacterId(d, `wave/robot/${joint}/${property}`),
      keyId: freshCharacterId(d, `wave/robot/${joint}/${property}#${tick}`),
    });
  const withArm = () => applyCharacterOperation(blockyFigure().doc, { type: 'addProp', prop: arm });

  it('places a CAD version, checks its source and placement, and keeps IDs in one namespace', () => {
    expect(codes(withArm())).toEqual([]);
    const bad = (fn: (p: typeof arm) => void) => {
      const d = withArm();
      fn(d.props[0] as typeof arm);
      return codes(d);
    };
    expect(bad((p) => (p.source.contentHash = 'nope'))).toEqual(['prop-source $.props[0].source']);
    expect(bad((p) => ((p.source as { kind: string }).kind = 'ifc'))).toEqual([
      'prop-source $.props[0].source',
    ]);
    // C8p (TS-1295): a building version is a prop too, but its elements have no joints to key.
    expect(bad((p) => ((p.source as { kind: string }).kind = 'bim'))).toEqual([]);
    const keyed = keyJoint(withArm(), 'shoulder', 'angle', 0, 0);
    (keyed.props[0]!.source as { kind: string }).kind = 'bim';
    expect(codes(keyed)).toEqual(['prop-joint-unsupported $.actions[0].tracks[2].target']);
    expect(bad((p) => (p.placement.rotation = [0, 0, 0, 2]))).toEqual([
      'unit-quaternion $.props[0].placement.rotation',
    ]);
    expect(bad((p) => (p.id = 'wave'))).toContain('duplicate-id $.actions[0].id');
    expect(characterIds(withArm()).has('robot')).toBe(true);
  });
  it('keys joint values on the shared timeline, one track per joint value', () => {
    let d = withArm();
    d = keyJoint(d, 'shoulder', 'angle', 0, 0);
    d = keyJoint(d, 'shoulder', 'angle', 24_000, Math.PI / 2);
    d = keyJoint(d, 'elbow', 'angle', 0, 1);
    d = keyJoint(d, 'slide', 'distance', 0, 250);
    const tracks = d.actions[0]!.tracks.filter((t) => t.target.kind === 'prop-joint');
    expect(tracks).toHaveLength(3);
    expect(tracks[0]!.keys).toHaveLength(2);
    const pose = poseAt(d, d.actions[0]!, 12_000);
    expect(pose.joints.get('robot')!.get('shoulder')!.angle).toBeCloseTo(Math.PI / 4, 9);
    expect(pose.joints.get('robot')!.get('elbow')).toEqual({ angle: 1 });
    expect(pose.joints.get('robot')!.get('slide')).toEqual({ distance: 250 });
    // The bones are sampled as before beside them.
    expect(pose.bones.size).toBe(poseAt(blockyFigure().doc, d.actions[0]!, 12_000).bones.size);
    // An angle past a continuous joint's bound (WM2: one turn is the version's limit, checked by
    // the prop), or a track on a missing prop, is refused.
    expect(() => keyJoint(d, 'shoulder', 'angle', 0, 7)).not.toThrow();
    expect(() => keyJoint(d, 'shoulder', 'angle', 0, 1_000_001)).toThrow(/joint-value/);
    const orphan = structuredClone(d);
    orphan.props = [];
    expect(codes(orphan)).toContain('target-id $.actions[0].tracks[3].target.id');
    // A joint key target names its joint; one without, or with other keys, is refused.
    const loose = structuredClone(d);
    delete (loose.actions[0]!.tracks[3]!.target as { joint?: string }).joint;
    expect(codes(loose)).toContain('missing-key $.actions[0].tracks[3].target.joint');
  });
  it('removes a prop with the tracks that key it, and moves or hides it', () => {
    let d = keyJoint(withArm(), 'shoulder', 'angle', 0, 0.5);
    d = applyCharacterOperation(d, {
      type: 'setPropPlacement',
      id: 'robot',
      placement: { translation: [0, 300, 0], rotation: [0, 0, 0, 1] },
    });
    expect(d.props[0]!.placement.translation).toEqual([0, 300, 0]);
    d = applyCharacterOperation(d, { type: 'setPropVisible', id: 'robot', visible: false });
    expect(d.props[0]!.visible).toBe(false);
    const before = d.actions[0]!.tracks.length;
    d = applyCharacterOperation(d, { type: 'removeProp', id: 'robot' });
    expect(d.props).toEqual([]);
    expect(d.actions[0]!.tracks).toHaveLength(before - 1);
    expect(() => applyCharacterOperation(d, { type: 'removeProp', id: 'robot' })).toThrow(
      /missing-target/,
    );
  });
});
