import { describe, expect, it } from 'vitest';
import type { EpmMesh } from '@editor-platform/geometry-mesh';
import { hattedFigure } from './fixtures';
import { exportGlb } from './gltf-export';
import { GltfImportError, importGltf } from './gltf';
import { poseAt, skinMatrices, skinnedPositions, worldMatrices } from './evaluate';
import { transformPoint } from './math';
import type { CharacterDocument, Vec3 } from './model';

/** Every part's referenced vertices in character space at `tick` of `actionId` (mm). */
function evaluated(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, EpmMesh>,
  actionId: string | null,
  tick: number,
): Map<string, Vec3[]> {
  const action = doc.actions.find((a) => a.id === actionId) ?? null;
  const pose = poseAt(doc, action, tick);
  const world = worldMatrices(doc, pose);
  const out = new Map<string, Vec3[]>();
  for (const part of doc.parts) {
    const mesh = meshes.get(part.mesh)!;
    const positions = mesh.positions.slice();
    for (const m of mesh.morphs) {
      const w = pose.morphs.get(m.id) ?? 0;
      for (let i = 0; i < positions.length; i++) positions[i] += w * m.deltas[i];
    }
    const skin = doc.skins.find((s) => s.partId === part.id);
    const used = [...new Set(mesh.faceIndices)];
    if (skin) {
      const p = skinnedPositions({ ...mesh, positions }, skinMatrices(skin, mesh, world.bones));
      out.set(
        part.id,
        used.map((v) => [p[3 * v], p[3 * v + 1], p[3 * v + 2]]),
      );
    } else {
      const m = world.parts.get(part.id)!;
      out.set(
        part.id,
        used.map((v) =>
          transformPoint(m, [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]]),
        ),
      );
    }
  }
  return out;
}
/** The farthest any point of one set is from the nearest point of the other (mm). */
function distance(a: Vec3[], b: Vec3[]) {
  const one = (x: Vec3[], y: Vec3[]) =>
    Math.max(
      ...x.map((p) => Math.min(...y.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))),
    );
  return Math.max(one(a, b), one(b, a));
}
const ids = (doc: CharacterDocument) => ({
  parts: doc.parts.map((p) => [p.id, p.name, p.parentId]),
  bones: doc.skeletons.flatMap((s) => s.bones.map((b) => [s.id, b.id, b.parentId])).sort(),
  materials: doc.materials.map((m) => [m.id, m.name, m.color, m.opacity]),
  morphs: doc.morphs.map((m) => [m.id, m.partId, m.name, m.weight]),
  actions: doc.actions.map((a) => [a.id, a.name, a.duration]),
  tracks: doc.actions.map((a) => a.tracks.map((t) => JSON.stringify(t.target)).sort()),
});

describe('glTF round trip (C6d, CH60, TS-1269)', () => {
  it('keeps part, bone, material, morph and action IDs and the evaluated shape', () => {
    const f = hattedFigure();
    const out = exportGlb(f.doc, f.meshes, new Map());
    const r = importGltf(out.bytes);
    expect(ids(r.doc)).toEqual(ids(f.doc));
    // The same shape, part by part, at rest and through each action.
    for (const [action, ticks] of [
      [null, [0]],
      ['wave', [0, 50000, 120000, 200000, 240000]],
      ['walk', [0, 90000, 240000]],
    ] as const)
      for (const tick of ticks) {
        const before = evaluated(f.doc, f.meshes, action, tick);
        const after = evaluated(r.doc, r.meshes, action, tick);
        for (const [part, points] of before)
          expect(distance(points, after.get(part)!), `${part} ${action} ${tick}`).toBeLessThan(
            0.01,
          );
      }
    // Exported again, the file reads back to the same document IDs (the round trip is stable).
    const again = importGltf(exportGlb(r.doc, r.meshes, new Map()).bytes);
    expect(ids(again.doc)).toEqual(ids(f.doc));
  });

  it('refuses morph IDs that do not fit the targets', () => {
    const f = hattedFigure();
    const bytes = exportGlb(f.doc, f.meshes, new Map()).bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const length = view.getUint32(12, true);
    const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
    const rewrite = (change: (json: { meshes: { extras: Record<string, unknown> }[] }) => void) => {
      const json = JSON.parse(text);
      change(json);
      // Same length (padded with spaces), so the BIN chunk stays where it was.
      const next = new TextEncoder().encode(JSON.stringify(json));
      expect(next.length).toBeLessThanOrEqual(length);
      const copy = bytes.slice();
      copy.fill(0x20, 20, 20 + length);
      copy.set(next, 20);
      return copy;
    };
    const problem = (b: Uint8Array) => {
      try {
        importGltf(b);
      } catch (e) {
        if (e instanceof GltfImportError) return e.problem;
        throw e;
      }
      return undefined;
    };
    expect(problem(rewrite((j) => (j.meshes[0].extras.ep_morph_ids = [])))).toBe('id');
    expect(problem(rewrite((j) => (j.meshes[0].extras.ep_morph_ids = [' x'])))).toBe('id');
    // A morph ID that another element already has.
    expect(problem(rewrite((j) => (j.meshes[1].extras.ep_morph_ids = ['body'])))).toBe('id');
  });
});
