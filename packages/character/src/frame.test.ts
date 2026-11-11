import { describe, expect, it } from 'vitest';
import {
  blockyFigure,
  importGltf,
  poseAt,
  skinMatrices,
  skinnedPositions,
  worldMatrices,
} from '@editor-platform/character-core';
import { testGltf } from '@editor-platform/character-core/gltf-fixtures';
import {
  cornerNormals,
  cornerTangents,
  editInput,
  meshEdges,
  unwrapMesh,
} from '@editor-platform/geometry-mesh';
import { checkCharacterAssets, decodeCharacterAssets, readCharacterAssets } from './assets';
import { characterFrame, frameBounds, prepareMesh } from './frame';
import { advance, choose, formatTicks, pause, play, restPlayback, seek, stop } from './playback';

const prepared = (meshes: Map<string, import('@editor-platform/geometry-mesh').EpmMesh>) =>
  new Map([...meshes].map(([id, m]) => [id, prepareMesh(m)]));

describe('character frame', () => {
  it('draws each corner where character-core poses its vertex', () => {
    const f = blockyFigure();
    const wave = f.doc.actions.find((a) => a.id === 'wave')!;
    const frame = characterFrame(f.doc, prepared(f.meshes), wave, 120000);
    const part = f.doc.parts[0];
    const mesh = f.meshes.get(part.mesh)!;
    const pose = poseAt(f.doc, wave, 120000);
    const morphed = { ...mesh, positions: mesh.positions.slice() };
    for (const m of mesh.morphs) {
      const w = pose.morphs.get(m.id) ?? 0;
      for (let i = 0; i < m.deltas.length; i++) morphed.positions[i] += w * m.deltas[i];
    }
    const expected = skinnedPositions(
      morphed,
      skinMatrices(f.doc.skins[0], mesh, worldMatrices(f.doc, pose).bones),
    );
    const corners = prepareMesh(mesh).display.cornerVertex;
    for (let c = 0; c < corners.length; c++)
      for (let k = 0; k < 3; k++)
        expect(frame[0].positions[3 * c + k]).toBeCloseTo(expected[3 * corners[c] + k], 3);
    // Normals stay unit length.
    for (let c = 0; c < corners.length; c++) {
      const n = frame[0].normals.subarray(3 * c, 3 * c + 3);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
    }
  });
  it('places an unskinned part by its world matrix and leaves hidden parts out of the bounds', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.skins = [];
    doc.parts[0].transform.translation = [1000, 0, 0];
    const at = frameBounds(characterFrame(doc, prepared(f.meshes), null, 0))!;
    const rest = frameBounds(characterFrame(f.doc, prepared(f.meshes), null, 0))!;
    expect(at[0][0]).toBeCloseTo(rest[0][0] + 1000, 3);
    doc.parts[0].visible = false;
    expect(frameBounds(characterFrame(doc, prepared(f.meshes), null, 0))).toBeUndefined();
  });
  it('keeps normals perpendicular under a non-uniform part scale', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.skins = [];
    doc.parts[0].transform.scale = [2, 1, 1];
    const frame = characterFrame(doc, prepared(f.meshes), null, 0)[0];
    const display = prepareMesh(f.meshes.get('mesh-body')!).display;
    // The inverse transpose of diag(2, 1, 1): x halves, then the normal is made unit again.
    for (let c = 0; c < display.cornerVertex.length; c++) {
      const n0 = display.normals.subarray(3 * c, 3 * c + 3);
      const e = [n0[0] / 2, n0[1], n0[2]];
      const len = Math.hypot(...e);
      for (let k = 0; k < 3; k++) expect(frame.normals[3 * c + k]).toBeCloseTo(e[k] / len, 5);
    }
  });
  it("carries the baked normal map's tangents through the pose (C7d, TS-1284)", () => {
    const f = blockyFigure();
    const input = editInput(f.meshes.get('mesh-body')!);
    const mesh = unwrapMesh(input, meshEdges(input.mesh, input.topology));
    const meshes = new Map([['mesh-body', mesh]]);
    const p = prepareMesh(mesh);
    // The frame the bake and the GLB use.
    expect(p.tangents).toEqual(cornerTangents(mesh, p.display.normals));
    expect(prepareMesh(f.meshes.get('mesh-body')!).tangents).toBeUndefined();
    const doc = structuredClone(f.doc);
    doc.skins = [];
    const rest = characterFrame(doc, prepared(meshes), null, 0)[0].tangents!;
    for (let i = 0; i < rest.length; i++) expect(rest[i]).toBeCloseTo(p.tangents![i], 5);
    // A non-uniform scale: still unit and perpendicular to the normal.
    doc.parts[0].transform.scale = [2, 1, 1];
    const scaled = characterFrame(doc, prepared(meshes), null, 0)[0];
    for (let c = 0; c < scaled.tangents!.length / 4; c++) {
      const t = scaled.tangents!.subarray(4 * c, 4 * c + 3);
      const n = scaled.normals.subarray(3 * c, 3 * c + 3);
      expect(Math.hypot(t[0], t[1], t[2])).toBeCloseTo(1, 5);
      expect(t[0] * n[0] + t[1] * n[1] + t[2] * n[2]).toBeCloseTo(0, 4);
    }
    // A morph that turns a face: its tangents come from the morphed shape, as its normals do.
    const turned = structuredClone(doc);
    turned.parts[0].transform.scale = [1, 1, 1];
    const deltas = new Float32Array(mesh.positions.length);
    for (let v = 0; v < deltas.length / 3; v++) {
      // Rotate every vertex 90° about z (x, y) → (−y, x).
      const x = mesh.positions[3 * v],
        y = mesh.positions[3 * v + 1];
      deltas[3 * v] = -y - x;
      deltas[3 * v + 1] = x - y;
    }
    const morphMesh = { ...mesh, morphs: [{ id: 'turn', deltas }] };
    turned.actions = [
      {
        id: 'turn',
        name: 'Turn',
        duration: 240000,
        frameRate: { numerator: 30, denominator: 1 },
        tracks: [
          {
            id: 'turn-track',
            target: { kind: 'morph', id: 'turn', property: 'weight' },
            keys: [{ id: 'turn-0', tick: 0, value: 1, easing: { type: 'hold' } }],
          },
        ],
      },
    ] as typeof turned.actions;
    const posed = characterFrame(
      turned,
      prepared(new Map([['mesh-body', morphMesh]])),
      turned.actions[0]!,
      0,
    )[0];
    for (let c = 0; c < posed.tangents!.length / 4; c++) {
      const t = posed.tangents!.subarray(4 * c, 4 * c + 3);
      const r = p.tangents!.subarray(4 * c, 4 * c + 3);
      // The rest tangent turned by the same 90°.
      expect(t[0]).toBeCloseTo(-r[1], 4);
      expect(t[1]).toBeCloseTo(r[0], 4);
      expect(t[2]).toBeCloseTo(r[2], 4);
    }
    // A mirror flips the handedness, so the bitangent (normal × tangent × w) stays M × bitangent.
    doc.parts[0].transform.scale = [-1, 1, 1];
    const mirrored = characterFrame(doc, prepared(meshes), null, 0)[0].tangents!;
    for (let c = 0; c < mirrored.length / 4; c++) {
      expect(mirrored[4 * c]).toBeCloseTo(-p.tangents![4 * c], 5);
      expect(mirrored[4 * c + 3]).toBe(-p.tangents![4 * c + 3]);
    }
  });
  it('marks parts drawn through a mirroring matrix, so the view winds them the other way', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    doc.skins = [];
    const all = (v: number) => (x: Uint8Array) => x.length > 0 && x.every((b) => b === v);
    expect(all(0)(characterFrame(doc, prepared(f.meshes), null, 0)[0].flipped)).toBe(true);
    doc.parts[0].transform.scale = [-1, 1, 1];
    expect(all(1)(characterFrame(doc, prepared(f.meshes), null, 0)[0].flipped)).toBe(true);
    doc.parts[0].transform.scale = [-1, -1, 1];
    expect(all(0)(characterFrame(doc, prepared(f.meshes), null, 0)[0].flipped)).toBe(true);
  });
  it('winds only the triangles of a reflected limb the other way, not the whole skin', () => {
    const f = blockyFigure();
    const doc = structuredClone(f.doc);
    // The left forearm scaled by −1 in x: its box is reflected, the rest of the body is not.
    doc.actions[0]!.tracks.push({
      id: 'mirror-forearm',
      target: { kind: 'bone', id: 'forearm.L', property: 'scale' },
      keys: [{ id: 'mirror-forearm-0', tick: 0, value: [-1, 1, 1], easing: { type: 'hold' } }],
    });
    const flipped = characterFrame(doc, prepared(f.meshes), doc.actions[0]!, 0)[0].flipped;
    const count = flipped.reduce((a, b) => a + b, 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(flipped.length / 4);
  });
  it('shades a morphed shape with the normals of the morphed faces', () => {
    const r = importGltf(testGltf());
    const doc = structuredClone(r.doc);
    doc.morphs[0].weight = 1;
    const mesh = r.meshes.get(doc.parts[0].mesh)!;
    // Lift the tip out of the bar's plane (Z-up −y is glTF +z), so the top quad tilts.
    const deltas = mesh.morphs[0].deltas.map((_, i) => (i >= 12 && i % 3 === 1 ? -300 : 0));
    const tilted = { ...mesh, morphs: [{ ...mesh.morphs[0], deltas: Float32Array.from(deltas) }] };
    const frame = characterFrame(doc, prepared(new Map([[doc.parts[0].mesh, tilted]])), null, 0)[0];
    const positions = mesh.positions.map((x, i) => x + deltas[i]);
    const expected = cornerNormals({ ...mesh, positions });
    const top = prepareMesh(mesh).display.cornerVertex.indexOf(5);
    for (let k = 0; k < 3; k++)
      expect(frame.normals[3 * top + k]).toBeCloseTo(expected[3 * top + k], 4);
    // The rest shape's normal there is different: the frame did not reuse it.
    expect(
      Math.abs(prepareMesh(mesh).display.normals[3 * top + 1] - expected[3 * top + 1]),
    ).toBeGreaterThan(0.1);
  });
  it('shows an imported glTF bent at 1 s as glTF does', () => {
    const r = importGltf(testGltf());
    const frame = characterFrame(r.doc, prepared(r.meshes), r.doc.actions[0], 240000);
    const display = prepareMesh(r.meshes.get(r.doc.parts[0].mesh)!).display;
    const c = display.cornerVertex.indexOf(5);
    // glTF: tip (0.05, 1, 0) + morph 0.1 x, turned 90° about +Z at y 0.5, root z 0.25 m.
    expect([...frame[0].positions.subarray(3 * c, 3 * c + 3)].map((x) => Math.round(x))).toEqual([
      -500, -250, 650,
    ]);
  });
});

describe('character assets', () => {
  it('reads matching bytes and refuses missing or changed ones without repairing them', () => {
    const f = blockyFigure();
    expect(readCharacterAssets(f.doc, f.assets).problems).toEqual([]);
    expect(readCharacterAssets(f.doc, new Map()).problems).toEqual(['mesh-body: missing']);
    const changed = new Map(f.assets);
    const bytes = changed.get('mesh-body')!.slice();
    bytes[bytes.length - 1] ^= 1;
    changed.set('mesh-body', bytes);
    expect(readCharacterAssets(f.doc, changed).problems).toEqual([
      'mesh-body: bytes do not match the document',
    ]);
    const r = importGltf(testGltf());
    const read = readCharacterAssets(r.doc, r.assets);
    expect(read.problems).toEqual([]);
    expect([...read.images.values()].map((i) => i.mediaType)).toEqual(['image/png']);
  });
  it('checks the same decoded bytes against each new document', () => {
    const f = blockyFigure();
    const decoded = decodeCharacterAssets(f.doc.assets, f.assets);
    const broken = structuredClone(f.doc);
    broken.parts[0].materials = [];
    expect(checkCharacterAssets(broken, decoded).problems).not.toEqual([]);
    expect(checkCharacterAssets(f.doc, decoded).problems).toEqual([]);
  });
});

describe('playback', () => {
  const action = blockyFigure().doc.actions[0];
  it('plays in real time, loops or stops at the end, and stops back to the start', () => {
    let p = play(restPlayback(action.id), action);
    p = advance(p, action, 500);
    expect(p.tick).toBe(120000);
    p = advance(p, action, action.duration / 240 - 400);
    expect(p.tick).toBe((120000 + action.duration - 96000) % action.duration);
    const once = advance({ ...play(restPlayback(action.id), action), loop: false }, action, 1e9);
    expect(once).toMatchObject({ tick: action.duration, playing: false });
    // Play again from the end starts over.
    expect(play(once, action).tick).toBe(0);
    expect(stop(p)).toMatchObject({ tick: 0, playing: false });
    expect(advance(pause(p), action, 1000).tick).toBe(p.tick);
  });
  it('seeks within the action and resets on another action', () => {
    const p = restPlayback(action.id);
    expect(seek(p, action, -5).tick).toBe(0);
    expect(seek(p, action, 1e12).tick).toBe(action.duration);
    expect(seek(p, action, 1234.6).tick).toBe(1235);
    expect(choose({ ...p, tick: 50, loop: false }, null)).toEqual({
      actionId: null,
      tick: 0,
      playing: false,
      loop: false,
    });
    expect(formatTicks(120000)).toBe('0.50 s');
  });
});
