import type { Vec3 } from './model';

/**
 * CR3d (docs/cad/car-design.md, CR3の分け方): the gap and flush between two bodies' facing
 * border edges, measured at equal distances along the first edge. Display only: the values never
 * enter the document.
 */
export const cadGapFlush = Object.freeze({
  /** Samples along the first edge, both ends included. */
  samples: 50,
  /**
   * A sample whose nearest point on the second edge is that edge's end, more than this far
   * (mm) along it: the edges do not face each other there, and the sample is left out.
   */
  beyondMm: 0.001,
});

/**
 * One sample on the first edge (model space, mm): its point `at`, the nearest point `to` on the
 * second edge, the gap (the distance between them in the first face's tangent plane, across the
 * edge) and the flush (how far `to` lies along the first face's normal; negative behind it).
 */
export interface CadGapFlushSample {
  at: Vec3;
  to: Vec3;
  gapMm: number;
  flushMm: number;
}
export interface CadGapFlushRange {
  min: number;
  max: number;
  mean: number;
}
export interface CadGapFlushReport {
  /** Samples measured: those where the edges face each other. */
  samples: number;
  gap: CadGapFlushRange;
  flush: CadGapFlushRange;
}

/** The report of the measured samples (at least one). */
export function gapFlushReport(samples: readonly CadGapFlushSample[]): CadGapFlushReport {
  if (!samples.length) throw new Error('gap-flush-no-samples');
  const range = (value: (s: CadGapFlushSample) => number): CadGapFlushRange => {
    const values = samples.map(value);
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, x) => a + x, 0) / values.length,
    };
  };
  return {
    samples: samples.length,
    gap: range((s) => s.gapMm),
    flush: range((s) => s.flushMm),
  };
}
