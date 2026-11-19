import { describe, expect, it } from 'vitest';
import { deriveBim } from './derive';
import type { BimDrawing } from './drawing';
import type { BimDocument } from './model';
import { f31BoxBuilding, f37Office, f39Roofs, f40Lattice, f47Taper } from './fixtures';
import {
  bimElevationAxes,
  bimElevationView,
  bimFrameDrawing,
  bimFramingDrawing,
  bimMemberList,
  bimProfileText,
} from './framing';

// DW5b (docs/cad/drawing-editor.md, 施工図): elevations, framing plans and framing elevations of a
// building version. ST-711, TS-2435.

const lines = (d: BimDrawing, cls: string) =>
  d.items.filter((i) => i.type === 'line' && i.cls === cls) as Extract<
    BimDrawing['items'][number],
    { type: 'line' }
  >[];
const texts = (d: BimDrawing, cls: string) =>
  d.items.flatMap((i) => (i.type === 'text' && i.cls === cls ? [i.text] : []));

describe('building construction drawings (DW5b)', () => {
  it('stands each elevation just outside the building, looking across all of it', () => {
    const doc = f31BoxBuilding();
    const front = bimElevationView(doc, 'front', 100)!;
    expect(front).toMatchObject({ kind: 'section', name: '正面立面図', direction: 'left' });
    if (front.kind !== 'section') throw new Error('kind');
    // The walls' outside is y = −100 … 8,100: the line stands 100 mm in front, running past.
    const box = deriveBim(doc);
    expect(box.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(front.line[0][1]).toBeLessThan(-100);
    expect(front.line[0][0]).toBeLessThan(front.line[1][0]);
    expect(front.depthMm).toBeGreaterThan(8200);
    // Each side looks the other way, its x to the viewer's right.
    const rear = bimElevationView(doc, 'rear', 100)!;
    const right = bimElevationView(doc, 'right', 100)!;
    const leftSide = bimElevationView(doc, 'left', 100)!;
    if (rear.kind !== 'section' || right.kind !== 'section' || leftSide.kind !== 'section')
      throw new Error('kind');
    expect(rear.line[0][0]).toBeGreaterThan(rear.line[1][0]);
    expect(right.line[0][1]).toBeLessThan(right.line[1][1]);
    expect(right.line[0][0]).toBeGreaterThan(10_000);
    expect(leftSide.line[0][1]).toBeGreaterThan(leftSide.line[1][1]);
    // Nothing to see: none.
    expect(bimElevationView({ ...doc, elements: [] }, 'front', 100)).toBeUndefined();
    // A placed CAD part counts, by its type's bounds turned into place (Codex on #1238): a
    // kiosk 2 m deep turned a quarter, 5 m in front of the walls.
    const withPart: BimDocument = {
      ...doc,
      types: [
        ...doc.types,
        {
          id: 't-kiosk',
          kind: 'part',
          name: 'Kiosk',
          source: { artifactId: 'a', versionId: 'v', contentHash: 'h' },
          hintBounds: { min: [0, 0, 0], max: [3000, 2000, 2500] },
        },
      ],
      elements: [
        ...doc.elements,
        {
          id: 'p-kiosk',
          kind: 'part',
          typeId: 't-kiosk',
          at: { xy: [5000, -5000] },
          base: { level: 'l-1f', offsetMm: 0 },
          rotationRad: Math.PI / 2,
        },
      ],
    };
    const near = bimElevationView(withPart, 'front', 100)!;
    if (near.kind !== 'section') throw new Error('kind');
    expect(near.line[0][1]).toBeCloseTo(-5100, 6);
    const only = bimElevationView(
      { ...withPart, elements: withPart.elements.slice(-1) },
      'front',
      100,
    );
    expect(only).toBeDefined();
  });

  it('draws every grid axis across an elevation, standing past the axes’ ends', () => {
    const doc = f37Office();
    const front = bimElevationView(doc, 'front', 200)!;
    const items = bimElevationAxes(doc, front);
    const xs = items.flatMap((i) => (i.type === 'line' && i.cls === 'grid' ? [i.a[0]] : []));
    const labels = items.flatMap((i) =>
      i.type === 'text' && i.cls === 'grid-label' ? [i.text] : [],
    );
    expect(labels).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7']);
    // Evenly 7,200 apart, left to right as the viewer sees them.
    expect(xs.slice(1).map((x, i) => x - xs[i]!)).toEqual(Array(6).fill(7200));
    // From the rear, the same axes run the other way.
    const rear = bimElevationAxes(doc, bimElevationView(doc, 'rear', 200)!);
    expect(
      rear.flatMap((i) => (i.type === 'text' && i.cls === 'grid-label' ? [i.text] : [])),
    ).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7'].reverse());
  });

  it('draws a floor’s beams marked, the columns under it, and its grids (伏図)', () => {
    const doc = f37Office();
    const d = bimFramingDrawing(doc, 'l-2f', 100);
    expect(d.name).toBe('2F 伏図');
    // 6 × 5 beams along x and 7 × 4 along y, each marked with its type's name.
    expect(lines(d, 'member')).toHaveLength(58);
    expect(new Set(texts(d, 'member-mark'))).toEqual(new Set(['RC beam 400×700']));
    // The 35 columns of the storey below, as their 600 square at the floor.
    const cols = d.items.filter((i) => i.type === 'polygon');
    expect(cols).toHaveLength(35);
    const c = cols[0]!;
    if (c.type !== 'polygon') throw new Error('type');
    const xs = c.loops[0]!.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(600, 6);
    // The 12 grid axes with their chain dimensions (7,200 between neighbours).
    expect(lines(d, 'grid')).toHaveLength(12);
    expect(texts(d, 'dimension-text')).toContain('7200');
    // The ground floor holds no beams, and no column reaches it from below.
    const gl = bimFramingDrawing(doc, 'l-1f', 100);
    expect(lines(gl, 'member')).toHaveLength(0);
    expect(gl.items.filter((i) => i.type === 'polygon')).toHaveLength(0);
    expect(bimFramingDrawing(doc, 'l-none', 100).items).toEqual([]);
    // Round and hollow columns as they are, a box's void open (Codex on #1238).
    const taper = bimFramingDrawing(f47Taper(), 'l-1', 100);
    const sections = taper.items.filter((i) => i.type === 'polygon');
    expect(sections.length).toBeGreaterThan(0);
    const loopsOf = sections.map((p) => (p.type === 'polygon' ? p.loops : []));
    expect(loopsOf.some((l) => l.length === 1 && l[0]!.length > 8)).toBe(true);
    expect(loopsOf.some((l) => l.length === 2)).toBe(true);
    // A leaning column is cut where it meets the floor: longer than its 600 section along its
    // lean (Codex on #1238).
    const lattice = f40Lattice();
    lattice.levels.push({ id: 'l-mid', name: 'Mid', elevationMm: 3000 });
    const lean = bimFramingDrawing(lattice, 'l-mid', 100).items.find(
      (i) => i.type === 'polygon' && i.id === 'c-lean',
    );
    if (lean?.type !== 'polygon') throw new Error('lean');
    const lx = lean.loops[0]!.map((p) => p[0]);
    const ly = lean.loops[0]!.map((p) => p[1]);
    const spans = [Math.max(...lx) - Math.min(...lx), Math.max(...ly) - Math.min(...ly)].sort(
      (a, b) => a - b,
    );
    expect(spans[0]).toBeCloseTo(600, 3);
    expect(spans[1]).toBeCloseTo(632.456, 2);
    // At its top floor it ends at its cap, square to its axis (Codex on #1238).
    const capped = bimFramingDrawing(f40Lattice(), 'l-1', 100).items.find(
      (i) => i.type === 'polygon' && i.id === 'c-lean',
    );
    if (capped?.type !== 'polygon') throw new Error('capped');
    const cx = capped.loops[0]!.map((p) => p[0]);
    expect(Math.max(...cx)).toBeCloseTo(2000, 6);
    expect(Math.max(...cx) - Math.min(...cx)).toBeCloseTo(316.228, 2);
    // A short, steep, sharply tapered column: its section from its faces, not its profile's
    // points carried through a singular projection (Codex on #1238).
    const short = f40Lattice();
    const sc = short.elements.find((e) => e.id === 'c-lean');
    if (sc?.kind !== 'column') throw new Error('c-lean');
    sc.base = { level: 'l-gl', offsetMm: 5950 };
    sc.top = { heightMm: 100 };
    sc.topScale = 0.1;
    const ss = bimFramingDrawing(short, 'l-1', 100).items.find(
      (i) => i.type === 'polygon' && i.id === 'c-lean',
    );
    if (ss?.type !== 'polygon') throw new Error('short');
    const sx = ss.loops.flat().map((p) => p[0]);
    expect(Math.min(...sx)).toBeCloseTo(-2.5, 1);
    expect(Math.max(...sx)).toBeCloseTo(1893.82, 1);
    // A pipe cut by its tilted cap: one C-shaped loop, the void opened (Codex on #1238).
    const piped = f40Lattice();
    const square = piped.types.find((t) => t.id === 't-column-600')!;
    piped.types.push({
      ...square,
      id: 't-pipe',
      name: 'Pipe 600',
      profile: { shape: 'pipe', diameterMm: 600, wallMm: 50 },
    } as typeof square);
    const pc = piped.elements.find((e) => e.id === 'c-lean');
    if (pc?.kind !== 'column') throw new Error('c-lean');
    pc.typeId = 't-pipe';
    const ps = bimFramingDrawing(piped, 'l-1', 100).items.find(
      (i) => i.type === 'polygon' && i.id === 'c-lean',
    );
    if (ps?.type !== 'polygon') throw new Error('pipe');
    expect(ps.loops).toHaveLength(1);
    // No edge of it runs along the cut across the void (|y| < 250 at x = 2000).
    const ring = ps.loops[0]!;
    const across = ring.some((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return (
        Math.abs(p[0] - 2000) < 1e-6 &&
        Math.abs(q[0] - 2000) < 1e-6 &&
        Math.abs(p[1]) < 250 - 1e-6 &&
        Math.abs(q[1]) < 250 - 1e-6
      );
    });
    expect(across).toBe(false);
    // Its top a little under the floor: its tilted cap still reaches it (Codex on #1238).
    const under = f40Lattice();
    const low = under.elements.find((e) => e.id === 'c-lean');
    if (low?.kind !== 'column') throw new Error('c-lean');
    low.top = { level: 'l-1', offsetMm: -50 };
    expect(
      bimFramingDrawing(under, 'l-1', 100).items.some(
        (i) => i.type === 'polygon' && i.id === 'c-lean',
      ),
    ).toBe(true);
    // Ending below the floor (its cap too): not there, and no failure (Codex on #1238).
    low.top = { level: 'l-1', offsetMm: -100 };
    const ended = bimFramingDrawing(under, 'l-1', 100);
    expect(ended.items.some((i) => i.type === 'polygon' && i.id === 'c-lean')).toBe(false);
    expect(ended.failed).toEqual([]);
    // A column a roof cuts off below the floor is not there; under it, it is (Codex on #1238).
    const roofed = f39Roofs('gable');
    roofed.levels.push(
      { id: 'l-attic', name: 'Attic', elevationMm: 7000 },
      { id: 'l-high', name: 'High', elevationMm: 10000 },
    );
    const columnIn = (lv: string) =>
      bimFramingDrawing(roofed, lv, 100).items.some(
        (i) => i.type === 'polygon' && i.id === 'c-ridge',
      );
    expect(columnIn('l-attic')).toBe(true);
    expect(columnIn('l-high')).toBe(false);
    // A member's ends by their heights, however written: 6,000 above GL is on L1.
    const moved = f40Lattice();
    const flat = moved.elements.find((e) => e.id === 'm-flat');
    if (flat?.kind !== 'member') throw new Error('m-flat');
    flat.end.height = { level: 'l-gl', offsetMm: 6000 };
    expect(
      bimFramingDrawing(moved, 'l-1', 100).items.some(
        (i) => i.type === 'line' && i.id === 'm-flat',
      ),
    ).toBe(true);
    // A beam's by its heights too: 4,000 above 1F is on 2F (Codex on #1238).
    const offset = f37Office();
    const beam = offset.elements.find((e) => e.id === 'b-2-x1-1');
    if (beam?.kind !== 'beam') throw new Error('beam');
    beam.top = { level: 'l-1f', offsetMm: 4000 };
    const has = (lv: string) =>
      bimFramingDrawing(offset, lv, 100).items.some(
        (i) => i.type === 'line' && i.id === 'b-2-x1-1',
      );
    expect([has('l-2f'), has('l-1f')]).toEqual([true, false]);
  });

  it('draws the columns and beams along an axis in their heights (軸組図)', () => {
    const doc = f37Office();
    const d = bimFrameDrawing(doc, 'g-y1', 500, 100);
    expect(d.name).toBe('Y1 通り軸組図');
    // 7 columns × 5 storeys upright, 6 beams × 5 floors level; the y beams leave the axis.
    const members = lines(d, 'member');
    expect(members.filter((l) => l.a[0] === l.b[0])).toHaveLength(35);
    expect(members.filter((l) => l.a[1] === l.b[1])).toHaveLength(30);
    // A beam's centre line: 350 below its top at 4,000.
    expect(members.find((l) => l.a[1] === l.b[1])!.a[1]).toBe(3650);
    // The levels across with their heights; the X axes crossing it, upright.
    expect(texts(d, 'level-label')).toEqual([
      '1F ±0',
      '2F +4000',
      '3F +8000',
      '4F +12000',
      '5F +16000',
      'RF +20000',
    ]);
    // Along the axis from its start (3,000 before X1).
    expect(lines(d, 'grid').map((l) => l.a[0])).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => 3000 + i * 7200),
    );
    expect(texts(d, 'grid-label')).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7']);
  });

  it('draws a leaning column, a sloping beam and a diagonal member slanted, all with 0', () => {
    const doc = f40Lattice();
    const along1 = lines(bimFrameDrawing(doc, 'g-1', 500, 100), 'member');
    const byId = new Map(
      bimFrameDrawing(doc, 'g-1', 500, 100).items.flatMap((i) =>
        i.type === 'line' && i.cls === 'member' ? [[i.id!, i]] : [],
      ),
    );
    // On axis 1 (y = 0): the leaning column, the sloping beam, the upright member, the member
    // from A/1 rising off the axis is left out.
    expect([...byId.keys()].sort()).toEqual(['b-slope', 'c-lean', 'm-vert']);
    expect(along1).toHaveLength(3);
    expect(byId.get('c-lean')).toMatchObject({ a: [2000, 0], b: [4000, 6000] });
    // The beam's top rises 1,500 over its length; its centre line 350 below.
    expect(byId.get('b-slope')).toMatchObject({ a: [2000, 5650], b: [8000, 7150] });
    // With no band, every column, beam and member, seen along the axis.
    const all = bimFrameDrawing(doc, 'g-1', 0, 100);
    expect(lines(all, 'member')).toHaveLength(6);
    expect(bimFrameDrawing(doc, 'g-none', 0, 100).items).toEqual([]);
    // A column a roof cuts: its axis up to the roof's underside (Codex on #1238).
    const roofed = f39Roofs('gable');
    roofed.grids.push({ id: 'g-mid', label: 'M', start: [0, 4000], end: [10000, 4000] });
    const ridge = lines(bimFrameDrawing(roofed, 'g-mid', 500, 100), 'member').find(
      (l) => l.id === 'c-ridge',
    );
    expect(ridge?.a[1]).toBe(0);
    expect(ridge!.b[1]).toBeGreaterThan(7000);
    expect(ridge!.b[1]).toBeLessThan(12000);
  });
});

// DW5c: the member list and the dimensions of elevations and frames. ST-712, TS-2440.
describe('member lists and chained dimensions (DW5c)', () => {
  it('lists each column, beam and member type with how many and their length', () => {
    expect(bimMemberList(f37Office())).toEqual([
      { mark: 'RC column 600', kind: '柱', section: '600×600', count: 175, lengthMm: 700000 },
      { mark: 'RC beam 400×700', kind: '梁', section: '400×700', count: 290, lengthMm: 2088000 },
    ]);
    const lattice = bimMemberList(f40Lattice());
    expect(lattice.map((r) => [r.kind, r.section, r.count])).toEqual([
      ['柱', '600×600', 1],
      ['梁', '400×700', 1],
      ['部材', '□-300×300×12', 2],
      ['部材', 'φ400', 2],
    ]);
    // A building with no columns, beams or members: none.
    expect(bimMemberList(f31BoxBuilding())).toEqual([]);
    expect(
      bimProfileText({ shape: 'h', depthMm: 700, widthMm: 300, webMm: 13, flangeMm: 24 }),
    ).toBe('H-700×300×13×24');
    expect(bimProfileText({ shape: 'pipe', diameterMm: 508, wallMm: 12.7 })).toBe('φ508×12.7');
  });

  it('chains the axes’ spacings with the overall, and the storey heights', () => {
    const doc = f37Office();
    const dims = (items: BimDrawing['items']) =>
      items.flatMap((i) => (i.type === 'text' && i.cls === 'dimension-text' ? [i.text] : []));
    const want = [...Array(6).fill('7200'), '43200', ...Array(5).fill('4000')];
    expect(dims(bimFrameDrawing(doc, 'g-y1', 500, 100).items)).toEqual(want);
    expect(dims(bimElevationAxes(doc, bimElevationView(doc, 'front', 200)!))).toEqual(want);
    // With no axis across it, the storeys' heights still, left of the building (Codex on #1240).
    const box = f31BoxBuilding();
    const front = bimElevationView(box, 'front', 100)!;
    const heights = bimElevationAxes({ ...box, grids: [] }, front);
    expect(dims(heights)).toEqual(['3000', '3000']);
    const x = heights.find((i) => i.type === 'line')!;
    expect(x.type === 'line' && x.a[0]).toBeLessThan(0);
  });
});
