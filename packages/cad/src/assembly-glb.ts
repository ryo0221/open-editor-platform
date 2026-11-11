import {
  poseMatrix,
  type CadAssemblyOccurrence,
  type CadDocument,
  type CadSolvedPose,
} from '@editor-platform/cad-core';
import type { CadExportBody, CadMesh } from '@editor-platform/cad-kernel-occt';

/**
 * A display mesh moved by a pose: the positions and normals turn with it, the origin (the box
 * centre the positions are relative to) is placed by it, so float32 precision stays local.
 */
export function placedMesh(mesh: CadMesh, pose: CadSolvedPose): CadMesh {
  const m = poseMatrix(pose);
  const turn = (from: ArrayLike<number>) => {
    const out = new Float32Array(from.length);
    for (let i = 0; i < from.length; i += 3) {
      const [x, y, z] = [from[i]!, from[i + 1]!, from[i + 2]!];
      out[i] = m[0]! * x + m[4]! * y + m[8]! * z;
      out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z;
      out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z;
    }
    return out;
  };
  // The origin in doubles: it can be far from the part's own origin, and float32 would move it.
  const [x, y, z] = mesh.origin;
  return {
    ...mesh,
    origin: [
      m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
      m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
      m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    ],
    positions: turn(mesh.positions),
    normals: turn(mesh.normals),
  };
}

/**
 * MR6: the bodies of an assembly as GLB writes them: each active body of each placed part, its
 * display mesh at the occurrence's world pose, then the assembly's own bodies where they are.
 * Image maps are not carried (named in `losses`). `missing` when a placed part has no meshes
 * at hand (not evaluated, or not readable): nothing is written then.
 */
export function assemblyGlbBodies(
  occurrences: readonly CadAssemblyOccurrence[],
  meshesOf: (contentHash: string) => readonly CadMesh[] | undefined,
  own: { content: CadDocument; meshes: readonly CadMesh[] } | undefined,
): { status: 'ok'; bodies: CadExportBody[]; losses: string[] } | { status: 'missing' } {
  const bodies: CadExportBody[] = [];
  const losses: string[] = [];
  const add = (
    label: string,
    content: CadDocument,
    meshes: readonly CadMesh[],
    pose: CadSolvedPose | undefined,
  ) => {
    for (const b of content.bodies) {
      if (b.state !== 'active') continue;
      const mesh = meshes.find((m) => m.bodyId === b.id);
      if (!mesh) return false;
      const name = label ? `${label}: ${b.name}` : b.name;
      if (b.appearance.textures)
        losses.push(`${name}: image maps are not written for a placed part.`);
      const { textures: _, ...appearance } = b.appearance;
      bodies.push({
        name,
        kind: b.kind,
        appearance,
        mesh: pose ? placedMesh(mesh, pose) : mesh,
      });
    }
    return true;
  };
  for (const o of occurrences) {
    const meshes = meshesOf(o.part.source.contentHash);
    if (!o.content || !meshes || !add(o.path.join(' / '), o.content, meshes, o.pose))
      return { status: 'missing' };
  }
  if (own && !add('', own.content, own.meshes, undefined)) return { status: 'missing' };
  return { status: 'ok', bodies, losses };
}
