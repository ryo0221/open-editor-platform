import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  drawingStarter,
  type DrawingBimDrawing,
  type DrawingDocument,
  type DrawingMeshBody,
  type DrawingPartsInfo,
  type DrawingPmiItem,
  type DrawingPmiLive,
  type Vec2,
} from '@editor-platform/drawing-core';
import { EditorInputs, EditorSession } from '@editor-platform/editor-core';
import { EditorInputsContext } from '@editor-platform/editor-ui';
import '@editor-platform/editor-ui/styles.css';
import ProjectWorker from '../src/project-worker?worker';
import {
  DrawingController,
  DrawingProjector,
  DrawingSurface,
  drawingBimViewState,
  drawingDeriveKey,
  drawingProjectionJob,
  drawingViewState,
  type DrawingIssueInfo,
  type DrawingSourceChoice,
} from '../src';
import '../src/style.css';

// Standalone host (N06): ?readonly=1. One fixed "saved version": a 60 × 40 × 20 mm block with a
// 10 mm through hole, as triangles and edges (the Host's kernel is not part of this host).
const params = new URLSearchParams(location.search);
const readOnly = params.get('readonly') === '1';

function block(a = 60): DrawingMeshBody {
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: number[] = [];
  const quad = (pts: number[][], f: number) => {
    const b = positions.length / 3;
    for (const p of pts) positions.push(p[0]!, p[1]!, p[2]!);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
    faces.push(f, f);
  };
  const [w, h] = [40, 20];
  quad(
    [
      [0, 0, 0],
      [0, w, 0],
      [a, w, 0],
      [a, 0, 0],
    ],
    0,
  );
  quad(
    [
      [0, 0, h],
      [a, 0, h],
      [a, w, h],
      [0, w, h],
    ],
    1,
  );
  quad(
    [
      [0, 0, 0],
      [a, 0, 0],
      [a, 0, h],
      [0, 0, h],
    ],
    2,
  );
  quad(
    [
      [0, w, 0],
      [0, w, h],
      [a, w, h],
      [a, w, 0],
    ],
    3,
  );
  quad(
    [
      [0, 0, 0],
      [0, 0, h],
      [0, w, h],
      [0, w, 0],
    ],
    4,
  );
  quad(
    [
      [a, 0, 0],
      [a, w, 0],
      [a, w, h],
      [a, 0, h],
    ],
    5,
  );
  const edges: DrawingMeshBody['edges'] = [];
  const c = [
    [0, 0, 0],
    [a, 0, 0],
    [a, w, 0],
    [0, w, 0],
    [0, 0, h],
    [a, 0, h],
    [a, w, h],
    [0, w, h],
  ];
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  // Each edge named by its corners on the unit block, as a kernel names an edge by its faces (DW3c).
  const unit = (p: number[]) => p.map((v, k) => Math.round(v / [a, w, h][k]!)).join('');
  for (const [i, j] of pairs)
    edges.push({
      index: edges.length,
      points: [...c[i]!, ...c[j]!],
      name: `edge ${unit(c[i]!)}-${unit(c[j]!)}`,
    });
  // The hole's wall (facing in), then its two circles.
  const n = 48;
  for (let k = 0; k < n; k++) {
    const t0 = (k / n) * 2 * Math.PI;
    const t1 = ((k + 1) / n) * 2 * Math.PI;
    const p = (t: number, z: number) => [a / 2 + 5 * Math.cos(t), 20 + 5 * Math.sin(t), z];
    quad([p(t0, 0), p(t0, h), p(t1, h), p(t1, 0)], 6);
  }
  for (const z of [0, h]) {
    const pts: number[] = [];
    for (let k = 0; k <= 48; k++) {
      const t = (k / 48) * 2 * Math.PI;
      pts.push(a / 2 + 5 * Math.cos(t), 20 + 5 * Math.sin(t), z);
    }
    edges.push({ index: edges.length, points: pts, name: `hole ${z ? 'top' : 'bottom'}` });
  }
  return { path: [], bodyId: 'block', positions, indices, faces, edges };
}
/** `?versions=2`: a second saved version, the block 1.5 times as long. */
const stretched = (b: DrawingMeshBody): DrawingMeshBody => ({
  ...b,
  positions: Array.from(b.positions, (v, i) => (i % 3 === 0 ? v * 1.5 : v)),
  edges: b.edges.map((e) => ({
    ...e,
    points: Array.from(e.points, (v, i) => (i % 3 === 0 ? v * 1.5 : v)),
  })),
});
/**
 * `?versions=3`: a third, 90 mm long with its hole in the middle, numbered the other way round, whose hole's circles have other names
 * (unresolved) and whose top front edge has the bottom front edge's name too (ambiguous).
 */
const renamed = (b: DrawingMeshBody): DrawingMeshBody => ({
  ...b,
  edges: [...b.edges].reverse().map((e, index) => ({
    ...e,
    index,
    name: e.name?.startsWith('hole')
      ? `${e.name} moved`
      : e.name === 'edge 001-101'
        ? 'edge 000-100'
        : e.name,
  })),
});
/** A body placed by an occurrence: moved by `d` (mm), its anchors under `path`. */
const placed = (b: DrawingMeshBody, path: string[], d: [number, number, number]) => ({
  ...b,
  path,
  positions: Array.from(b.positions, (v, i) => v + d[i % 3]!),
  edges: b.edges.map((e) => ({ ...e, points: Array.from(e.points, (v, i) => v + d[i % 3]!) })),
});
/**
 * `?assembly=1` (DW4): a base (the version's own body) with two copies of a 20 mm cube part on
 * it and a pin left out of the BOM, and its flat parts list.
 */
const cube = (): DrawingMeshBody => {
  const b = block(20);
  const keep = (v: number, i: number) => (i % 3 === 1 ? (v * 20) / 40 : v);
  return {
    ...b,
    bodyId: 'cube',
    positions: Array.from(b.positions, keep),
    edges: b.edges
      .filter((e) => !e.name?.startsWith('hole'))
      .map((e) => ({ ...e, points: Array.from(e.points, keep) })),
  };
};
const assembly: DrawingMeshBody[] = [
  { ...block(), bodyId: 'base' },
  placed(cube(), ['occ-1'], [5, 10, 20]),
  placed(cube(), ['occ-2'], [35, 10, 20]),
  placed(cube(), ['occ-pin'], [25, 15, 40]),
];
const assemblyParts: DrawingPartsInfo = {
  rows: [
    {
      item: '1',
      partNumber: 'B-100',
      name: 'Base',
      description: '',
      quantity: 1,
      key: 'base',
      bodyId: 'base',
    },
    {
      item: '2',
      partNumber: 'C-20',
      name: 'Cube',
      description: 'S45C',
      quantity: 2,
      key: 'cube',
      // DW4b: the cube's own saved version, for its part drawing.
      source: { artifactId: 'cube', versionId: 'v1', contentHash: 'hc' },
    },
  ],
  occurrences: [
    { path: [], bodyId: 'base', key: 'base' },
    { path: ['occ-1'], key: 'cube' },
    { path: ['occ-2'], key: 'cube' },
    { path: ['occ-pin'], key: 'pin' },
  ],
};
const assemblyOn = params.get('assembly') === '1';
const bodies = new Map<string, DrawingMeshBody[]>([
  ['h1', assemblyOn ? assembly : [block()]],
  ['h2', [stretched(block())]],
  ['h3', [renamed(block(90))]],
  ['hc', [cube()]],
]);
/** The bodies a view shows: all, or those `only` names (own bodies by ID, occurrences by path). */
const shown = (list: DrawingMeshBody[], only: readonly string[]) =>
  list.filter(
    (b) =>
      !only.length ||
      (b.path.length ? b.path.some((p) => only.includes(p)) : only.includes(b.bodyId)),
  );
/**
 * `?pmi=1` (DW3c-2b): the block's PMI as a Host reads it from a kept asset: datum A on the
 * bottom, a position tolerance on the hole and the length. v2's length is 90 (updated); v3 has
 * no hole tolerance (expired) and its datum is stale.
 */
const pmiOn = params.get('pmi') === '1';
function pmiOf(hash: string): DrawingPmiLive[] {
  const a = hash === 'h1' ? 60 : 90;
  const live = (itemId: string, item: DrawingPmiItem, target: [number, number, number]) => ({
    path: [],
    bodyId: 'block',
    itemId,
    assetSha256: `sha256:${(hash === 'h1' ? 'a' : 'b').repeat(64)}`,
    item,
    current: !(hash === 'h3' && item.kind === 'datum'),
    target,
  });
  return [
    live('pmi-datum', { kind: 'datum', name: 'A' }, [a / 2, 20, 0]),
    ...(hash === 'h3'
      ? []
      : [
          live(
            'pmi-hole',
            {
              kind: 'geometric-tolerance',
              type: 'Position',
              value: 0.1,
              zone: 'D',
              modifiers: ['MAXIMUM_MATERIAL_REQUIREMENT'],
              datums: ['A'],
            },
            [a / 2 + 5, 20, 20],
          ),
        ]),
    live(
      'pmi-length',
      {
        kind: 'dimension',
        type: 'Location_LinearDistance',
        values: [a],
        deviation: { lower: -0.1, upper: 0.1 },
      },
      [a, 0, 20],
    ),
  ];
}
const version = (n: number): DrawingSourceChoice => ({
  key: `part/v${n}`,
  kind: 'cad',
  artifactId: 'part',
  versionId: `v${n}`,
  contentHash: `h${n}`,
  name: 'Block',
  label: `Block · v${n}`,
});
// DW5a (`?bim=1`): a building version with its plan, drawn as a fixed building drawing.
const bimOn = params.get('bim') === '1';
const building: DrawingSourceChoice = {
  key: 'tower/v1',
  kind: 'bim',
  artifactId: 'tower',
  versionId: 'v1',
  contentHash: 'hb',
  name: 'Tower',
  label: 'Tower · v1',
  views: [{ id: 'v-1f', name: '1F plan', kind: 'plan', scale: '1:100' }],
  levels: [{ id: 'l-2f', name: '2F' }],
  grids: [{ id: 'g-a', label: 'A' }],
};
/** DW5b: the 2F framing plan: two beams marked G1 between the grid axes. */
const towerFraming: DrawingBimDrawing = {
  items: [
    ...[0, 8000].map((y, i) => ({
      type: 'line' as const,
      a: [0, y] as Vec2,
      b: [12000, y] as Vec2,
      cls: 'member',
      id: `b-${i}`,
    })),
    ...[0, 8000].map((y, i) => ({
      type: 'text' as const,
      at: [6000, y + 300] as Vec2,
      text: 'G1',
      anchor: 'middle' as const,
      cls: 'member-mark',
      id: `b-${i}`,
    })),
  ],
  failed: [],
};
/** A 12 × 8 m plan: four cut walls, two grid lines with their bubbles. */
const towerPlan: DrawingBimDrawing = {
  items: [
    ...(
      [
        [0, 0, 12000, 200],
        [0, 7800, 12000, 8000],
        [0, 0, 200, 8000],
        [11800, 0, 12000, 8000],
      ] as const
    ).map(([x0, y0, x1, y1], i) => ({
      type: 'polygon' as const,
      loops: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ] as Vec2[],
      ],
      cls: 'cut cut-wall m-concrete',
      id: `w-${i}`,
    })),
    ...[0, 12000].map((x, i) => ({
      type: 'line' as const,
      a: [x, -1500] as Vec2,
      b: [x, 9500] as Vec2,
      cls: 'grid',
      id: `g-${i}`,
    })),
    ...[0, 12000].map((x, i) => ({
      type: 'text' as const,
      at: [x, -1900] as Vec2,
      text: i ? 'B' : 'A',
      anchor: 'middle' as const,
      cls: 'grid-label',
    })),
  ],
  failed: [],
};
const choices = [
  ...(params.get('versions') === '3'
    ? [version(3), version(2), version(1)]
    : params.get('versions') === '2'
      ? [version(2), version(1)]
      : [version(1)]),
  ...(bimOn ? [building] : []),
];
const projector = new DrawingProjector(() => new ProjectWorker() as never);
const session = new EditorSession<DrawingDocument>(drawingStarter('Block drawing'));
// DW6b: issues kept in memory, as a Host keeps them beside its saved versions.
const issued: { info: DrawingIssueInfo; pdf: Uint8Array; content: DrawingDocument }[] = [];
const controller = new DrawingController({
  session,
  canEdit: () => !readOnly,
  issues: {
    list: () => issued.map((i) => i.info),
    pdf: (versionId) => issued.find((i) => i.info.versionId === versionId)?.pdf,
    async issue({ content, pdf, sheets }) {
      const info = {
        versionId: `issue-${issued.length + 1}`,
        issuedAt: new Date().toISOString(),
        sheets,
        byteLength: pdf.length,
      };
      issued.push({ info, pdf, content });
      Object.assign(window, { drawingIssued: issued });
      return undefined;
    },
  },
  // DW6: the Playground's fixed font, served from its public folder (?nofont=1: none).
  ...(params.get('nofont') === '1'
    ? {}
    : {
        pdfFont: async () => {
          const r = await fetch('/office-fonts/NotoSansCJKjp-Regular.otf');
          if (!r.ok) throw new Error('pdf-font-unavailable');
          return new Uint8Array(await r.arrayBuffer());
        },
      }),
  onApplied: (content) => Object.assign(window, { drawingApplied: content }),
  sources: {
    // The newest first, as a Host lists them.
    choices: () => choices,
    prepare: async (c, only = []) => {
      if (c.kind === 'bim') return c.contentHash === 'hb' ? {} : { code: 'source-missing' };
      const list = bodies.get(c.contentHash);
      if (!list) return { code: 'source-missing' };
      const lo: [number, number, number] = [Infinity, Infinity, Infinity];
      const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (const b of shown(list, only))
        for (let i = 0; i < b.positions.length; i++) {
          lo[i % 3] = Math.min(lo[i % 3]!, b.positions[i]!);
          hi[i % 3] = Math.max(hi[i % 3]!, b.positions[i]!);
        }
      return { box: [lo, hi] };
    },
  },
  derive: {
    key: (doc, v) =>
      drawingDeriveKey(doc, v, doc.sources.find((s) => s.id === v.sourceId)?.contentHash ?? ''),
    async run(doc, view, signal) {
      const hash = doc.sources.find((s) => s.id === view.sourceId)?.contentHash ?? '';
      if (view.kind === 'bim-framing')
        return view.levelId === 'l-2f'
          ? drawingBimViewState(view, towerFraming)
          : { status: 'failed', code: 'bim-level-missing' };
      if (view.kind === 'bim-elevation' || view.kind === 'bim-frame')
        return drawingBimViewState(view, towerPlan);
      if (view.kind === 'bim-view')
        return hash === 'hb' && view.bimViewId === 'v-1f'
          ? drawingBimViewState(view, towerPlan)
          : { status: 'failed', code: 'bim-view-missing' };
      const all = bodies.get(hash);
      if (!all) return { status: 'failed', code: 'source-missing' };
      const job = drawingProjectionJob(doc, view, hash);
      if ('code' in job) return { status: 'failed', code: job.code };
      const r = await projector.project(shown(all, job.spec.only), job.frame, job.options, signal);
      if ('code' in r) return { status: 'failed', code: r.code };
      return drawingViewState(
        view,
        job,
        r,
        pmiOn ? pmiOf(hash) : undefined,
        assemblyOn && hash === 'h1' ? assemblyParts : undefined,
      );
    },
  },
});
// For the browser tests.
Object.assign(window, { drawingController: controller, drawingSession: session });

function App() {
  const [, render] = useState(0);
  const history = (direction: 'undo' | 'redo') => {
    if (direction === 'undo' ? !session.canUndo : !session.canRedo) return;
    if (direction === 'undo') session.undo();
    else session.redo();
    controller.sync();
    render((n) => n + 1);
  };
  return (
    <DrawingSurface
      controller={controller}
      name="Block drawing"
      onUndo={() => history('undo')}
      onRedo={() => history('redo')}
    />
  );
}
const inputs = new EditorInputs();
createRoot(document.getElementById('root')!).render(
  <EditorInputsContext.Provider value={inputs}>
    <App />
  </EditorInputsContext.Provider>,
);
