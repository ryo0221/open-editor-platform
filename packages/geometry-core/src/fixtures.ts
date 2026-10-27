import type {
  GeometryFrame,
  GeometryGraph,
  GeometryLoop,
  GeometryOp,
  GeometryRequest,
} from './ops';

/**
 * F30 geometry ops (docs/cad/r2c-architecture.md, fixtures): small graphs of every op with
 * their analytic values, run against the kernel by `geometry-kernel-occt`'s tests.
 */
export interface GeometryFixture {
  graph: GeometryGraph;
  requests: GeometryRequest[];
  /** Expected values by request node. */
  expect: Record<
    string,
    {
      volumeMm3?: number;
      areaMm2?: number;
      bounds?: [[number, number, number], [number, number, number]];
      /** Total length of the section's edges and how many closed loops they form. */
      section?: { lengthMm: number; loops: number };
      /** Total length of the visible and hidden edges in the view plane. */
      projection?: { visibleMm: number; hiddenMm: number };
    }
  >;
}

const ground: GeometryFrame = { origin: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1] };
const square = (s: number, x = 0, y = 0): GeometryLoop => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
const cube = (s: number): GeometryOp => ({
  op: 'prism',
  frame: ground,
  outer: square(s),
  vector: [0, 0, s],
});

/** A prism whose outer loop ends in a half circle, with a round hole (arcs by bulge). */
export function f30Prism(): GeometryFixture {
  const outer: GeometryLoop = [
    [0, 0],
    [1000, 0],
    [1000, 1000, 1],
    [0, 1000],
  ];
  const hole: GeometryLoop = [
    [400, 500, 1],
    [600, 500, 1],
  ];
  const area = 1e6 + (Math.PI * 500 ** 2) / 2 - Math.PI * 100 ** 2;
  return {
    graph: {
      nodes: { slab: { op: 'prism', frame: ground, outer, holes: [hole], vector: [0, 0, 300] } },
    },
    requests: [{ node: 'slab', measure: true }],
    expect: {
      slab: {
        volumeMm3: area * 300,
        bounds: [
          [0, 0, 0],
          [1000, 1500, 300],
        ],
      },
    },
  };
}

/** A straight profile sweep: an L section in a vertical frame, swept along a slanted vector. */
export function f30Sweep(): GeometryFixture {
  const frame: GeometryFrame = { origin: [0, 0, 0], x: [0, 1, 0], z: [1, 0, 0] };
  const l: GeometryLoop = [
    [0, 0],
    [100, 0],
    [100, 10],
    [10, 10],
    [10, 100],
    [0, 100],
  ];
  // The area is 1,900 mm²; a vector of 4,000 along x and 3,000 along z leaves 4,000 along the normal.
  return {
    graph: { nodes: { beam: { op: 'prism', frame, outer: l, vector: [4000, 0, 3000] } } },
    requests: [{ node: 'beam', measure: true }],
    expect: { beam: { volumeMm3: 1900 * 4000 } },
  };
}

/** Booleans: a cube less a smaller cube at a corner, the union of two, their common part. */
export function f30Boolean(): GeometryFixture {
  const corner: GeometryOp = {
    op: 'prism',
    frame: { origin: [50, 50, 50], x: [1, 0, 0], z: [0, 0, 1] },
    outer: square(100),
    vector: [0, 0, 100],
  };
  return {
    graph: {
      nodes: {
        a: cube(100),
        b: corner,
        cut: { op: 'boolean', kind: 'cut', target: 'a', tools: ['b'] },
        union: { op: 'boolean', kind: 'union', target: 'a', tools: ['b'] },
        common: { op: 'boolean', kind: 'common', target: 'a', tools: ['b'] },
      },
    },
    requests: ['cut', 'union', 'common'].map((node) => ({ node, measure: true })),
    expect: {
      cut: { volumeMm3: 1e6 - 125_000 },
      union: { volumeMm3: 2e6 - 125_000 },
      common: { volumeMm3: 125_000 },
    },
  };
}

/** A half-space: a cube cut below a plane rising 0.3 mm per mm along x from 40 mm. */
export function f30HalfSpace(): GeometryFixture {
  return {
    graph: {
      nodes: {
        a: cube(100),
        below: {
          op: 'halfSpace',
          input: 'a',
          origin: [0, 0, 40],
          normal: [-0.3, 0, 1],
          keep: 'below',
        },
        above: {
          op: 'halfSpace',
          input: 'a',
          origin: [0, 0, 40],
          normal: [-0.3, 0, 1],
          keep: 'above',
        },
      },
    },
    requests: [
      { node: 'below', measure: true },
      { node: 'above', measure: true },
    ],
    // The height runs from 40 to 70 mm: a mean of 55.
    expect: { below: { volumeMm3: 100 * 100 * 55 }, above: { volumeMm3: 100 * 100 * 45 } },
  };
}

/** A rigid placement: a 100 × 200 × 50 box turned a quarter about z and moved. */
export function f30Transform(): GeometryFixture {
  return {
    graph: {
      nodes: {
        box: {
          op: 'prism',
          frame: ground,
          outer: [
            [0, 0],
            [100, 0],
            [100, 200],
            [0, 200],
          ],
          vector: [0, 0, 50],
        },
        placed: {
          op: 'transform',
          input: 'box',
          rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
          translation: [1000, 0, 10],
        },
      },
    },
    requests: [{ node: 'placed', measure: true }],
    expect: {
      placed: {
        volumeMm3: 100 * 200 * 50,
        bounds: [
          [800, 0, 10],
          [1000, 100, 60],
        ],
      },
    },
  };
}

/** A section: the holed slab of f30Prism cut half way up gives its outer loop and the hole. */
export function f30Section(): GeometryFixture {
  const prism = f30Prism();
  const perimeter = 1000 + 1000 + 1000 + Math.PI * 500 + 2 * Math.PI * 100;
  return {
    graph: prism.graph,
    requests: [{ node: 'slab', section: { origin: [0, 0, 150], normal: [0, 0, 1] } }],
    expect: { slab: { section: { lengthMm: perimeter, loops: 2 } } },
  };
}

/** A projection: a 100 mm cube seen along (-1, -1, -1): nine visible edges and three hidden. */
export function f30Projection(): GeometryFixture {
  const edge = 100 * Math.sqrt(2 / 3);
  return {
    graph: { nodes: { a: cube(100) } },
    requests: [
      {
        node: 'a',
        projection: {
          direction: [-1, -1, -1],
          up: [0, 0, 1],
          deflectionMm: 0.5,
          angularDeflectionRad: 0.1,
        },
      },
    ],
    expect: { a: { projection: { visibleMm: 9 * edge, hiddenMm: 3 * edge } } },
  };
}

/**
 * A compound: a 50 mm cube right behind the 100 mm cube along the view (-1, -1, -1) is hidden
 * by it, so all its edges are hidden and the big cube's are as on their own.
 */
export function f30Compound(): GeometryFixture {
  const edge = (s: number) => s * Math.sqrt(2 / 3);
  return {
    graph: {
      nodes: {
        a: cube(100),
        small: cube(50),
        b: {
          op: 'transform',
          input: 'small',
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [-300, -300, -300],
        },
        both: { op: 'compound', inputs: ['a', 'b'] },
      },
    },
    requests: [
      {
        node: 'both',
        projection: {
          direction: [-1, -1, -1],
          up: [0, 0, 1],
          deflectionMm: 0.5,
          angularDeflectionRad: 0.1,
        },
      },
    ],
    expect: {
      both: { projection: { visibleMm: 9 * edge(100), hiddenMm: 3 * edge(100) + 12 * edge(50) } },
    },
  };
}

export const f30Fixtures = {
  prism: f30Prism,
  sweep: f30Sweep,
  boolean: f30Boolean,
  halfSpace: f30HalfSpace,
  transform: f30Transform,
  section: f30Section,
  projection: f30Projection,
  compound: f30Compound,
};
