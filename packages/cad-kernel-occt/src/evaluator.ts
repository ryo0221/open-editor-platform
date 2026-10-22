import {
  evaluationOrder,
  parameterValues,
  resolveAngle,
  resolveLength,
  resolvePosition,
  type CadBodyEvaluation,
  type CadDocument,
  type CadEvaluation,
  type CadFeature,
  type CadProfile,
  type Length,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { cadOutputLimits, meshBytes, type CadMesh } from './protocol';

/** The Embind module of the pinned build. It ships no types in this repository. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Embind surface, confined to this file
export type OcModule = any;

export class CadKernelError extends Error {
  constructor(
    readonly code: string,
    readonly featureId?: string,
    readonly retryable = false,
  ) {
    super(featureId ? `${code}@${featureId}` : code);
  }
}
/** Thrown when a cooperative cancel point sees the job was cancelled. */
export class CadEvaluationCancelled extends Error {}

/** Decodes an OCCT C++ exception thrown through Embind (a pointer number). */
export function decodeKernelException(
  oc: OcModule,
  error: unknown,
): { type: string; message: string } {
  if (typeof error !== 'number')
    return { type: 'js', message: String((error as Error)?.message ?? error) };
  const failure = oc.OCJS.getStandard_FailureData(error);
  return { type: failure.DynamicType().get().Name(), message: failure.GetMessageString() };
}

export interface EvaluateOptions {
  /** Absolute linear deflection (mm) for the display mesh. */
  deflectionMm?: number;
  angularDeflectionRad?: number;
  /** Cooperative cancel point between features; must yield to a macrotask, not a microtask. */
  checkpoint?: () => Promise<void>;
}

/**
 * Full-graph evaluation in stable topological order. Every feature must yield one valid solid
 * within the profile's result tolerance. Every handle created here is deleted before returning,
 * including on error or cancel.
 */
export async function evaluateCad(
  oc: OcModule,
  doc: CadDocument,
  contentHash: string,
  options: EvaluateOptions = {},
): Promise<{ evaluation: CadEvaluation; meshes: CadMesh[] }> {
  // Every Embind wrapper is owned, including ones returned by builders (.Shape(), ex.Current()):
  // deleting a builder does not delete them. A Set keeps own() idempotent.
  const owned = new Set<{ delete(): void; isDeleted?(): boolean }>();
  const own = <T>(value: T): T => (owned.add(value as never), value);
  const params = parameterValues(doc);
  const len = (l: Length) => resolveLength(l, params);
  const pnt = (x: number, y: number, z: number) => own(new oc.gp_Pnt_3(x, y, z));
  const place = (shape: unknown, q: Quaternion, t: Vec3) => {
    const trsf = own(new oc.gp_Trsf_1());
    trsf.SetTransformation_3(own(new oc.gp_Quaternion_2(...q)), own(new oc.gp_Vec_4(...t)));
    return own(own(new oc.BRepBuilderAPI_Transform_2(shape, trsf, false)).Shape());
  };
  const explore = (shape: unknown, kind: string, visit: (current: unknown) => void) => {
    const ex = own(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    for (; ex.More(); ex.Next()) visit(own(ex.Current()));
  };
  const maxTolerance = (shape: unknown): number =>
    own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
      shape,
      1,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
  function profileFace(profile: CadProfile) {
    const s = profile.shape;
    let wire;
    if (s.type === 'circle') {
      const ax = own(new oc.gp_Ax2_3(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1))));
      const edge = own(
        own(new oc.BRepBuilderAPI_MakeEdge_8(own(new oc.gp_Circ_2(ax, len(s.radius))))).Edge(),
      );
      wire = own(own(new oc.BRepBuilderAPI_MakeWire_2(edge)).Wire());
    } else {
      const points =
        s.type === 'rectangle'
          ? [
              [0, 0],
              [len(s.width), 0],
              [len(s.width), len(s.height)],
              [0, len(s.height)],
            ]
          : s.vertices.map((v) => [len(v.u), len(v.v)]);
      const poly = own(new oc.BRepBuilderAPI_MakePolygon_1());
      for (const [u, v] of points) poly.Add_1(pnt(u, v, 0));
      poly.Close();
      wire = own(poly.Wire());
    }
    return own(own(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face());
  }
  const plane = (p: CadProfile): [Quaternion, Vec3] => [
    p.plane.orientation,
    resolvePosition(p.plane.origin, params),
  ];
  function build(f: CadFeature, shapes: Map<string, unknown>, profiles: Map<string, CadProfile>) {
    switch (f.type) {
      case 'box': {
        const [x, y, z] = f.args.size.map(len);
        return place(
          own(own(new oc.BRepPrimAPI_MakeBox_2(x, y, z)).Shape()),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      }
      case 'cylinder':
        return place(
          own(
            own(new oc.BRepPrimAPI_MakeCylinder_1(len(f.args.radius), len(f.args.height))).Shape(),
          ),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      case 'sphere':
        return place(
          own(own(new oc.BRepPrimAPI_MakeSphere_1(len(f.args.radius))).Shape()),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      case 'extrude': {
        const profile = profiles.get(f.args.profileId)!;
        const vec = own(new oc.gp_Vec_4(0, 0, f.args.direction * len(f.args.distance)));
        return place(
          own(own(new oc.BRepPrimAPI_MakePrism_1(profileFace(profile), vec, false, true)).Shape()),
          ...plane(profile),
        );
      }
      case 'revolve': {
        const profile = profiles.get(f.args.profileId)!;
        const [ox, oy] = f.args.axisOrigin.map(len);
        const [dx, dy] = f.args.axisDirection;
        const axis = own(new oc.gp_Ax1_2(pnt(ox, oy, 0), own(new oc.gp_Dir_4(dx, dy, 0))));
        const angle = resolveAngle(f.args.angle, params);
        return place(
          own(
            own(new oc.BRepPrimAPI_MakeRevol_1(profileFace(profile), axis, angle, false)).Shape(),
          ),
          ...plane(profile),
        );
      }
      case 'transform':
        return place(
          shapes.get(f.inputFeatureIds[0]),
          f.args.rotation,
          resolvePosition(f.args.translation, params),
        );
      case 'boolean': {
        const [target, tool] = f.inputFeatureIds.map((i) => shapes.get(i));
        const Op = {
          union: oc.BRepAlgoAPI_Fuse_3,
          cut: oc.BRepAlgoAPI_Cut_3,
          common: oc.BRepAlgoAPI_Common_3,
        }[f.args.mode];
        const op = own(new Op(target, tool, own(new oc.Message_ProgressRange_1())));
        if (!op.IsDone() || op.HasErrors()) throw new CadKernelError('boolean-failed', f.id);
        return own(op.Shape());
      }
    }
  }
  function mesh(
    bodyId: string,
    shape: unknown,
    faceBase: number,
    origin: [number, number, number],
  ): CadMesh {
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        shape,
        options.deflectionMm ?? 0.05,
        false,
        options.angularDeflectionRad ?? 0.5,
        false,
      ),
    );
    const positions: number[] = [];
    const indices: number[] = [];
    const faceIds: number[] = [];
    let face = 0;
    explore(shape, 'TopAbs_FACE', (current) => {
      const topoFace = own(oc.TopoDS.Face_1(current));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topoFace, loc, 0));
      face++;
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      const offset = positions.length / 3;
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        positions.push(p.X() - origin[0], p.Y() - origin[1], p.Z() - origin[2]);
      }
      const reversed = topoFace.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map((n: number) => offset + n - 1);
        indices.push(...(reversed ? [a, c, b] : [a, b, c]));
        faceIds.push(faceBase + face);
      }
    });
    const pos = new Float32Array(positions);
    const normals = new Float32Array(pos.length);
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      for (const k of [a, b, c]) for (let j = 0; j < 3; j++) normals[k + j] += n[j];
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      for (let j = 0; j < 3; j++) normals[i + j] /= l;
    }
    return {
      bodyId,
      origin,
      positions: pos,
      normals,
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
    };
  }

  try {
    const order = evaluationOrder(doc.features);
    if (!order) throw new CadKernelError('feature-cycle');
    const byId = new Map(doc.features.map((f) => [f.id, f]));
    const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
    const shapes = new Map<string, unknown>();
    for (const id of order) {
      await options.checkpoint?.();
      const f = byId.get(id)!;
      let shape;
      try {
        shape = build(f, shapes, profiles);
      } catch (error) {
        if (error instanceof CadKernelError) throw error;
        const { type, message } = decodeKernelException(oc, error);
        throw new CadKernelError(`kernel-exception:${type}${message ? `:${message}` : ''}`, f.id);
      }
      let solids = 0;
      explore(shape, 'TopAbs_SOLID', () => solids++);
      if (solids !== 1) throw new CadKernelError(solids ? 'multiple-solids' : 'empty-result', f.id);
      if (!own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
        throw new CadKernelError('invalid-solid', f.id);
      if (maxTolerance(shape) > doc.kernelProfile.maxResultLinearToleranceMm)
        throw new CadKernelError('result-tolerance', f.id);
      shapes.set(id, shape);
    }
    const bodies: Record<string, CadBodyEvaluation> = {};
    const meshes: CadMesh[] = [];
    let faces = 0;
    for (const body of doc.bodies) {
      if (body.state !== 'active') continue;
      await options.checkpoint?.();
      const shape = shapes.get(body.resultFeatureId);
      const volume = own(new oc.GProp_GProps_1());
      oc.BRepGProp.VolumeProperties_1(shape, volume, false, false, false);
      const surface = own(new oc.GProp_GProps_1());
      oc.BRepGProp.SurfaceProperties_1(shape, surface, false, false);
      const box = own(new oc.Bnd_Box_1());
      oc.BRepBndLib.AddOptimal(shape, box, false, false);
      const [min, max] = [own(box.CornerMin()), own(box.CornerMax())];
      bodies[body.id] = {
        volumeMm3: volume.Mass(),
        areaMm2: surface.Mass(),
        bounds: [
          [min.X(), min.Y(), min.Z()],
          [max.X(), max.Y(), max.Z()],
        ],
      };
      // Float32 positions are relative to the box centre so small features far from the
      // model origin keep distinct vertices.
      const m = mesh(body.id, shape, faces, [
        (min.X() + max.X()) / 2,
        (min.Y() + max.Y()) / 2,
        (min.Z() + max.Z()) / 2,
      ]);
      faces += new Set(m.faceIds).size;
      meshes.push(m);
      const triangles = meshes.reduce((n, x) => n + x.indices.length / 3, 0);
      if (
        faces > cadOutputLimits.faces ||
        triangles > cadOutputLimits.triangles ||
        meshBytes(meshes) > cadOutputLimits.bufferBytes
      )
        throw new CadKernelError('output-limit', body.id);
    }
    const digest = sha256.create();
    digest.update(new TextEncoder().encode(`${contentHash}\n${JSON.stringify(bodies)}\n`));
    for (const m of meshes)
      for (const b of [new Float64Array(m.origin), m.positions, m.indices, m.faceIds])
        digest.update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    return {
      evaluation: {
        status: 'ok',
        contentHash,
        buildHash: doc.kernelProfile.buildHash,
        geometryDigest: `sha256:${bytesToHex(digest.digest())}`,
        bodies,
      },
      meshes,
    };
  } catch (error) {
    if (error instanceof CadEvaluationCancelled) throw error;
    const e =
      error instanceof CadKernelError
        ? error
        : new CadKernelError('kernel-failure', undefined, true);
    return {
      evaluation: {
        status: 'error',
        contentHash,
        code: e.code,
        ...(e.featureId ? { featureId: e.featureId } : {}),
        retryable: e.retryable,
      },
      meshes: [],
    };
  } finally {
    for (const value of [...owned].reverse())
      if (value && typeof value.delete === 'function' && !value.isDeleted?.()) value.delete();
  }
}
