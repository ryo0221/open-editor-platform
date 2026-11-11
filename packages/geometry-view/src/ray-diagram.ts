/**
 * CR6c (docs/cad/car-design.md, CR-U6): a lamp's ray diagram. A fan of rays leaves a focus in a
 * plane; each ray is followed through the shown bodies' display meshes, reflected by mirror
 * surfaces and refracted (Snell's law, with total internal reflection) by transmitting ones,
 * until it meets an opaque surface, leaves the model or reaches the bounce limit. Geometry only:
 * no light distribution, no standard's check. The surfaces are the display mesh with its node
 * normals interpolated, not the exact B-rep.
 */
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { PartCheckMesh } from './part-checks';

/** How a surface treats a ray. Lit bodies (a bulb) are passed through: they are the source. */
export type RaySurface =
  | { kind: 'mirror' }
  | { kind: 'refract'; ior: number }
  | { kind: 'opaque' }
  | { kind: 'pass' };

export interface RayDiagramBody extends PartCheckMesh {
  surface: RaySurface;
}

export interface RayFan {
  focus: readonly [number, number, number];
  /** The fan's middle direction (normalised here). */
  direction: readonly [number, number, number];
  /** The fan's plane holds `direction` and is normal to this (normalised here). */
  planeNormal: readonly [number, number, number];
  /** The whole fan's angle (degrees, 0–360) and its ray count. */
  spreadDeg: number;
  count: number;
  /** Surfaces met before a ray stops. */
  maxBounces: number;
  /** Length drawn for a ray that leaves the model (mm). */
  exitLength: number;
}

/** Limits of the fan settings. */
export const rayDiagramLimits = Object.freeze({
  spreadDeg: [0, 360] as const,
  count: [1, 256] as const,
  maxBounces: [1, 16] as const,
  exitLength: [1, 100_000] as const,
  /**
   * A ray leaving a surface skips hits nearer than this (mm): that surface itself. Under the
   * smallest CAD dimension (0.001 mm), so both faces of a supported thin lens are met.
   */
  epsilonMm: 1e-4,
  /** Surfaces (lit ones included) a ray may meet at most. */
  maxSteps: 1024,
});

/** How each ray ended. */
export type RayEnd = 'escaped' | 'absorbed' | 'bounces';

export interface TracedRay {
  /** The path's points (model mm): the focus, each hit, and the end. */
  points: [number, number, number][];
  /** What each hit did, in order: `mirror`, `refract`, `internal` (total internal reflection). */
  events: ('mirror' | 'refract' | 'internal')[];
  end: RayEnd;
}

interface Merged {
  bvh: MeshBVH;
  geometry: BufferGeometry;
  normals: Float32Array;
  /** The body of each node (the BVH reorders the triangles, never the nodes). */
  owner: Uint32Array;
}

/**
 * The bodies' meshes in one buffer, relative to `base` (the fan's focus): each body's origin is
 * taken off in doubles before the Float32 rounding, so a lamp far from the model's origin keeps
 * the origin-relative mesh's precision.
 */
function merge(bodies: readonly RayDiagramBody[], base: readonly [number, number, number]): Merged {
  let nodes = 0;
  let triangles = 0;
  for (const b of bodies) {
    nodes += b.positions.length / 3;
    triangles += b.indices.length / 3;
  }
  const positions = new Float32Array(nodes * 3);
  const normals = new Float32Array(nodes * 3);
  const indices = new Uint32Array(triangles * 3);
  const owner = new Uint32Array(nodes);
  let n = 0;
  let t = 0;
  bodies.forEach((b, k) => {
    const count = b.positions.length / 3;
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) {
        positions[(n + i) * 3 + a] = b.origin[a]! - base[a]! + b.positions[i * 3 + a]!;
        normals[(n + i) * 3 + a] = b.normals[i * 3 + a]!;
      }
    }
    for (let i = 0; i < b.indices.length; i++) indices[t * 3 + i] = b.indices[i]! + n;
    owner.fill(k, n, n + count);
    n += count;
    t += b.indices.length / 3;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { bvh: new MeshBVH(geometry), geometry, normals, owner };
}

/** The fan's ray directions, evenly over the spread (one ray: the middle direction). */
export function rayFanDirections(
  fan: Pick<RayFan, 'direction' | 'planeNormal' | 'spreadDeg' | 'count'>,
) {
  const d = new Vector3(...fan.direction).normalize();
  const axis = new Vector3(...fan.planeNormal);
  // The plane's normal made square to the direction.
  axis.addScaledVector(d, -axis.dot(d));
  if (axis.lengthSq() < 1e-12)
    throw new Error('The fan plane must not be normal to its direction.');
  axis.normalize();
  const spread = (fan.spreadDeg * Math.PI) / 180;
  // A full turn has no repeated end ray.
  const full = fan.spreadDeg >= 360;
  return Array.from({ length: fan.count }, (_, i) => {
    const t = fan.count === 1 ? 0.5 : full ? i / fan.count : i / (fan.count - 1);
    return d.clone().applyAxisAngle(axis, (t - 0.5) * spread);
  });
}

/**
 * Traces the fan through the bodies. A refracting body's normals face out of it: a ray going
 * against the normal enters (1 → ior), along it leaves (ior → 1).
 */
export function traceRayFan(bodies: readonly RayDiagramBody[], fan: RayFan): TracedRay[] {
  // Traced relative to the focus; the points are put back in the model on the way out.
  const base = fan.focus;
  const merged = bodies.length ? merge(bodies, base) : undefined;
  const model = (v: Vector3): [number, number, number] => [
    v.x + base[0],
    v.y + base[1],
    v.z + base[2],
  ];
  const eps = rayDiagramLimits.epsilonMm;
  const ray = new Ray();
  const tri = new Triangle();
  const bary = new Vector3();
  const na = new Vector3();
  const nb = new Vector3();
  const nc = new Vector3();
  const out = rayFanDirections(fan).map((direction) => {
    const points: [number, number, number][] = [[...fan.focus] as [number, number, number]];
    const events: TracedRay['events'] = [];
    const origin = new Vector3();
    const d = direction.clone();
    let end: RayEnd = 'bounces';
    let bounces = 0;
    // Each pass through a lit body is a step too: a bound against a mesh that traps the ray.
    for (let step = 0; step < rayDiagramLimits.maxSteps; step++) {
      ray.origin.copy(origin);
      ray.direction.copy(d);
      const hit = merged?.bvh.raycastFirst(ray, DoubleSide, eps, Infinity);
      if (!merged || !hit?.face) {
        points.push(model(origin.clone().addScaledVector(d, fan.exitLength)));
        end = 'escaped';
        break;
      }
      const surface = bodies[merged.owner[hit.face.a]!]!.surface;
      const p = hit.point;
      if (surface.kind === 'pass') {
        // The source's own shape: go on through it, not counted as a bounce.
        origin.copy(p);
        continue;
      }
      points.push(model(p));
      if (surface.kind === 'opaque') {
        end = 'absorbed';
        break;
      }
      if (bounces >= fan.maxBounces) break;
      bounces++;
      // The surface's normal there, from the node normals (a smooth reflector stays smooth).
      const { a, b, c } = hit.face;
      const pos = merged.geometry.getAttribute('position');
      tri.setFromAttributeAndIndices(pos, a, b, c);
      tri.getBarycoord(p, bary);
      na.fromArray(merged.normals, a * 3);
      nb.fromArray(merged.normals, b * 3);
      nc.fromArray(merged.normals, c * 3);
      const n = na.multiplyScalar(bary.x).addScaledVector(nb, bary.y).addScaledVector(nc, bary.z);
      if (n.lengthSq() < 1e-12) tri.getNormal(n);
      n.normalize();
      const cos = d.dot(n);
      const reflect = () => d.addScaledVector(n, -2 * cos).normalize();
      if (surface.kind === 'mirror') {
        reflect();
        events.push('mirror');
      } else {
        // Snell: the normal turned against the ray; η the ratio of the indices.
        const entering = cos < 0;
        const eta = entering ? 1 / surface.ior : surface.ior;
        const facing = entering ? n.clone() : n.clone().negate();
        const ci = -d.dot(facing);
        const k = 1 - eta * eta * (1 - ci * ci);
        if (k < 0) {
          reflect();
          events.push('internal');
        } else {
          d.multiplyScalar(eta)
            .addScaledVector(facing, eta * ci - Math.sqrt(k))
            .normalize();
          events.push('refract');
        }
      }
      // The next query skips hits nearer than ε: the surface just left (once, not twice).
      origin.copy(p);
    }
    return { points, events, end };
  });
  merged?.geometry.dispose();
  return out;
}

/**
 * The traced rays as line segments (pairs of points, model mm), for the view to draw. Doubles:
 * the view takes its origin off before the Float32 rounding, so a lamp far from the model's
 * origin keeps its ray points apart.
 */
export function rayDiagramSegments(rays: readonly TracedRay[]): Float64Array {
  const out: number[] = [];
  for (const r of rays)
    for (let i = 1; i < r.points.length; i++) out.push(...r.points[i - 1]!, ...r.points[i]!);
  return Float64Array.from(out);
}
