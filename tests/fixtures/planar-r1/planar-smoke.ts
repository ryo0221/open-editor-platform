import {
  classifySegments,
  pointOnSegment,
  validatePlanarPoint,
  validateRing,
} from '@editor-platform/geometry-core/planar';

export function capturePlanarResults() {
  const m = Number.MAX_VALUE;
  const t = Number.MIN_VALUE;
  const options = { maxVertices: 4 };
  return {
    point: validatePlanarPoint([0, -0]),
    invalid: validatePlanarPoint([Infinity, 0]),
    position: pointOnSegment([1, 0], [0, 0], [2, 0]),
    cross: classifySegments([0, 0], [m, m], [0, m], [m, 0]),
    tiny: validateRing(
      [
        [0, 0],
        [t, 0],
        [0, t],
        [0, 0],
      ],
      options,
    ),
    huge: validateRing(
      [
        [-m, -m],
        [m, -m],
        [0, m],
        [-m, -m],
      ],
      options,
    ),
    bowtie: validateRing(
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
        [0, 0],
      ],
      options,
    ),
    budget: validateRing(Array(6), options),
  };
}
