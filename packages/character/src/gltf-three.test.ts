import { describe, expect, it } from 'vitest';
import { AnimationMixer, LoopOnce, Mesh, SkinnedMesh, Vector3, type Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  exportGlb,
  hattedFigure,
  poseAt,
  skinMatrices,
  skinnedPositions,
  transformPoint,
  worldMatrices,
  type CharacterDocument,
  type Vec3,
} from '@editor-platform/character-core';
import type { EpmMesh } from '@editor-platform/geometry-mesh';

/** The editor's evaluation: each part's vertices in character space (mm, Z-up). */
function editor(
  doc: CharacterDocument,
  meshes: ReadonlyMap<string, EpmMesh>,
  actionId: string,
  tick: number,
): Map<string, Vec3[]> {
  const pose = poseAt(doc, doc.actions.find((a) => a.id === actionId)!, tick);
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
    const at = (p: ArrayLike<number>, v: number): Vec3 => [p[3 * v], p[3 * v + 1], p[3 * v + 2]];
    if (skin) {
      const p = skinnedPositions({ ...mesh, positions }, skinMatrices(skin, mesh, world.bones));
      out.set(
        part.id,
        used.map((v) => at(p, v)),
      );
    } else
      out.set(
        part.id,
        used.map((v) => transformPoint(world.parts.get(part.id)!, at(positions, v))),
      );
  }
  return out;
}
/**
 * three.js's: the part's vertices, morphed and skinned, in mm and Z-up. A part node with several
 * primitives is a group of meshes (its child parts are nodes with their own `ep_id`).
 */
function player(node: Object3D): Vec3[] {
  const meshes =
    node instanceof Mesh
      ? [node]
      : node.children.filter((c): c is Mesh => c instanceof Mesh && c.userData.ep_id === undefined);
  const out: Vec3[] = [];
  const v = new Vector3();
  for (const o of meshes) {
    const count = o.geometry.getAttribute('position').count;
    for (let i = 0; i < count; i++) {
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld);
      out.push([v.x * 1000, -v.z * 1000, v.y * 1000]);
    }
  }
  return out;
}
function distance(a: Vec3[], b: Vec3[]) {
  const one = (x: Vec3[], y: Vec3[]) =>
    Math.max(
      ...x.map((p) => Math.min(...y.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))),
    );
  return Math.max(one(a, b), one(b, a));
}

describe('three.js plays the exported GLB as the editor does (C6d, CH60, TS-1270)', () => {
  it('matches vertex positions over frames of each action, within 0.05 mm', async () => {
    const f = hattedFigure();
    const { bytes } = exportGlb(f.doc, f.meshes, new Map());
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().parseAsync(buffer as ArrayBuffer, '');
    expect(gltf.animations.map((a) => a.name)).toEqual(['Wave', 'Walk']);
    // A mesh node with several primitives is a group; with one, the mesh itself.
    const nodeOf = (partId: string) => {
      let found: Object3D | undefined;
      gltf.scene.traverse((o) => {
        if (o.userData.ep_id === partId) found = o;
      });
      return found!;
    };
    let checked = 0;
    for (const clip of gltf.animations) {
      const actionId = f.doc.actions.find((a) => a.name === clip.name)!.id;
      const mixer = new AnimationMixer(gltf.scene);
      // Played once and held at its end, so 1 s shows the last frame (a loop would wrap to 0).
      const played = mixer.clipAction(clip);
      played.setLoop(LoopOnce, 1);
      played.clampWhenFinished = true;
      played.play();
      for (const seconds of [0, 0.2, 0.5, 0.75, 1]) {
        mixer.setTime(seconds);
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (o instanceof SkinnedMesh) o.skeleton.update();
        });
        const want = editor(f.doc, f.meshes, actionId, Math.round(seconds * 240000));
        for (const [part, points] of want) {
          const got = player(nodeOf(part));
          expect(got.length).toBeGreaterThan(0);
          expect(distance(points, got), `${part} ${clip.name} ${seconds}`).toBeLessThan(0.05);
          checked++;
        }
      }
      mixer.stopAllAction();
    }
    expect(checked).toBe(20);
  });
});
