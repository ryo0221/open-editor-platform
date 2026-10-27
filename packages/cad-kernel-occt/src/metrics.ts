import type { OcModule } from './evaluator';

/**
 * Relative error the reported volume is integrated to. OCCT's fixed-order volume integration is
 * exact for planes and quadrics but misses a solid with B-spline faces by about 5 × 10⁻⁵ (R2a-2);
 * Gauss–Kronrod over the knot spans meets this bound on both. The area keeps the fixed-order
 * integration (the adaptive one strays further on B-spline faces): exact on planes and quadrics,
 * within 5 × 10⁻⁴ of the area on B-spline faces (1.3 × 10⁻⁴ on F16).
 */
export const cadVolumeRelativeError = 1e-9;

/** A shape's area (mm²) and, for a solid, its volume (mm³), shared by evaluation and import. */
export function shapeMetrics(
  oc: OcModule,
  shape: unknown,
  own: <T>(value: T) => T,
  solid: boolean,
): { areaMm2: number; volumeMm3?: number } {
  const surface = own(new oc.GProp_GProps_1());
  oc.BRepGProp.SurfaceProperties_1(shape, surface, false, false);
  if (!solid) return { areaMm2: surface.Mass() };
  const volume = own(new oc.GProp_GProps_1());
  oc.BRepGProp.VolumePropertiesGK_1(
    shape,
    volume,
    cadVolumeRelativeError,
    false,
    true,
    false,
    false,
    false,
  );
  return { areaMm2: surface.Mass(), volumeMm3: volume.Mass() };
}
