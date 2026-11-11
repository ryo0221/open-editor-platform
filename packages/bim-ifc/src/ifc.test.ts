import { mkdirSync, writeFileSync } from 'node:fs';
import {
  BimContext,
  bimSectionAxes,
  bimWallAxis,
  bimWallOpeningLoop,
  bimWallOpeningRise,
  loopArea,
  bimSlabPlanes,
  deriveBim,
  f31BoxBuilding,
  f37Office,
  f40Lattice,
  f47Taper,
  f49Pipes,
  f50Lean,
  f51Ramps,
  f52LeanOpenings,
  f54LeanJoins,
  f55RampOpenings,
  f55Stairs,
  f48Ramp,
  type BimDocument,
  type BimLoop,
  type BimWall,
  type Vec2,
} from '@editor-platform/bim-core';
import { describe, expect, it } from 'vitest';
import {
  bimIfcKinds,
  bimQtoNames,
  bimQtoScale,
  BimIfcExportError,
  writeIfc,
  type BimIfcExport,
  type BimIfcExportOptions,
  type BimIfcPartMesh,
} from './export';
import { compressGuid, formatReal, formatString, stableGuid } from './p21';
import {
  arcJoinsExport,
  cube,
  element,
  f35Export,
  f39Export,
  f54Export,
  hollow,
  opts,
  sheet,
  solidParts,
} from './fixtures';

/** What an independent reader must find (scripts/bim-ifc/verify.py). */
function expectations(doc: BimDocument, out: BimIfcExport, options: BimIfcExportOptions) {
  const d = deriveBim(doc);
  const elements: Record<
    string,
    {
      kind: string;
      volume?: number;
      curved?: boolean;
      bounds?: number[][];
      qto?: Record<string, number>;
      /** OH-U1: each styled item's colour (0–1) and transparency, in item order. */
      styles?: number[][];
      /** Why the reader's mesh volume is not compared (its bounds still are). */
      volumeNotChecked?: string;
    }
  > = {};
  const box = (loop: BimLoop, z0: number, z1: number) => [
    [Math.min(...loop.map((v) => v[0])), Math.min(...loop.map((v) => v[1])), z0],
    [Math.max(...loop.map((v) => v[0])), Math.max(...loop.map((v) => v[1])), z1],
  ];
  const straight = (loop: BimLoop) => loop.every((v) => !v[2]);
  let leanFaceSets = 0;
  let rampFaceSets = 0;
  const types = new Map(doc.types.map((t) => [t.id, t]));
  for (const e of doc.elements) {
    if (e.kind === 'opening') continue;
    const s = d.shapes.get(e.id)!;
    const q = d.quantities.get(e.id)!;
    // Clipped elements keep only the analytic values in plan; the rest come from the kernel.
    const plan = ['length', 'width', 'footprintArea', 'crossSectionArea'].filter(
      (k) => e.kind === 'wall' || k === 'crossSectionArea',
    );
    const analytic =
      q.source === 'kernel'
        ? Object.fromEntries(Object.entries(q.values).filter(([k]) => plan.includes(k)))
        : q.values;
    const values = { ...analytic, ...options.kernelQuantities?.get(e.id) };
    const x: (typeof elements)[string] = { kind: e.kind };
    const names = bimQtoNames[e.kind];
    if (names)
      x.qto = Object.fromEntries(
        Object.entries(names)
          .filter(([k]) => values[k] !== undefined)
          .map(([k, [name, unit]]) => [
            `${bimIfcKinds[e.kind].qto}.${name}`,
            values[k] * bimQtoScale[unit],
          ]),
      );
    if (s.kind === 'wall' && s.footprintTop) {
      // LR2b: a leaning wall; exact as a slanted extrusion, faceted as a cone or a twisted one.
      x.volume = values.netVolume;
      const both = [...s.footprint, ...s.footprintTop];
      const d = [0, 1].map((k) => s.footprintTop![0]![k]! - s.footprint[0]![k]!);
      const moved = s.footprint.every(
        (v, i) =>
          Math.abs(s.footprintTop![i]![0] - v[0] - d[0]!) <= 1e-6 &&
          Math.abs(s.footprintTop![i]![1] - v[1] - d[1]!) <= 1e-6,
      );
      x.curved = !straight(both) || !moved;
      if (straight(both) && !s.clipBy) x.bounds = box(both, s.zBase, s.zTop);
      // A straight one that is not just moved is written as triangles (the fixtures' arcs are
      // cones, revolved).
      if (!moved && straight(both)) leanFaceSets++;
    } else if (s.kind === 'wall') {
      x.volume = values.netVolume;
      x.curved = !straight(s.footprint);
      if (!x.curved && !s.clipBy) x.bounds = box(s.footprint, s.zBase, s.zTop);
    } else if (s.kind === 'slab') {
      x.volume = values.netVolume;
      // TW5: a sloped slab runs from its lowest bottom to its highest top.
      const z = s.slope
        ? (({ zLow, zHigh }) => [zLow - (s.zTop - s.zBottom), zHigh])(bimSlabPlanes(s))
        : [s.zBottom, s.zTop];
      if (s.slope) x.curved = !straight(s.boundary);
      if (straight(s.boundary)) x.bounds = box(s.boundary, z[0]!, z[1]!);
    } else if (s.kind === 'column' || s.kind === 'beam' || s.kind === 'member') {
      x.volume = values.netVolume;
      x.curved = 'diameterMm' in s.profile;
      // TW2: rectangular sections along their axes, ends square to them.
      const p = s.profile;
      if ((p.shape === 'rect' || p.shape === 'box') && !(s.kind === 'column' && s.clipBy)) {
        const a = bimSectionAxes(s);
        // TW5: a tapered column's top section is scaled about the axis.
        const scale = (t: number) => (t && s.kind === 'column' ? (s.topScale ?? 1) : 1);
        const corners = [0, a.length].flatMap((t) =>
          [-1, 1].flatMap((i) =>
            [-1, 1].map((j) =>
              [0, 1, 2].map(
                (k) =>
                  a.origin[k]! +
                  a.z[k]! * t +
                  (a.x[k]! * i * p.widthMm * scale(t)) / 2 +
                  (a.y[k]! * j * p.depthMm * scale(t)) / 2,
              ),
            ),
          ),
        );
        x.bounds = [0, 1].map((m) =>
          [0, 1, 2].map((k) => (m ? Math.max : Math.min)(...corners.map((c) => c[k]!))),
        );
        // TW5: IfcOpenShell 0.9 meshes a tapered polygonal extrusion with its end faces twice
        // (the right vertices, the volume off); a tapered circle meshes right.
        if (s.kind === 'column' && s.topScale !== undefined)
          x.volumeNotChecked = 'IfcOpenShell 0.9 doubles the end faces of a tapered polygon';
      }
    } else if (s.kind === 'ramp' || s.kind === 'railing') {
      // LR3: faceted within 0.1 mm of its circles, so its volume within 1e-4 (curved). LS5: a
      // railing is a band of the same triangles.
      x.volume = values.netVolume;
      x.curved = true;
      rampFaceSets++;
    } else if (s.kind === 'stair') {
      // LS6: an extruded side, exact.
      x.volume = values.netVolume;
    } else if (s.kind === 'roof') {
      x.volume = values.grossVolume;
      x.curved = !straight(s.boundary);
      if (s.faces[0].slope === 0 && straight(s.boundary))
        x.bounds = box(s.boundary, s.zBase, s.zBase + s.thicknessMm);
    } else if (s.kind === 'space') {
      x.volume = values.netVolume;
      if (straight(s.boundary)) x.bounds = box(s.boundary, s.zBase, s.zTop);
    } else if (e.kind === 'door' || e.kind === 'window') {
      const t = types.get(e.typeId)!;
      const host = doc.elements.find((h) => h.id === e.hostId) as BimWall;
      const ctx = new BimContext(doc);
      if ('widthMm' in t && host.lean && bimWallAxis(ctx, host).arc) {
        // FU3b: on a cone the band about the wall's middle between the opening's angles, its
        // plan area linear in the height: the area halfway up times the rise.
        const sill = e.kind === 'window' ? e.sillMm : 0;
        const [z0, z1] = bimWallOpeningRise(host, sill, t.heightMm);
        const band = bimWallOpeningLoop(ctx, host, e.alongMm, t.widthMm, (z0 + z1) / 2, 25);
        x.volume = Math.abs(loopArea(band)) * (z1 - z0);
        x.curved = true;
      } else if ('widthMm' in t) x.volume = t.widthMm * 50 * t.heightMm;
    } else if (e.kind === 'part') {
      const mesh = options.parts!.get(e.id)!;
      x.volume = solidParts.get(mesh)?.volume;
      // Every fixture part with looks has one look, so one styled item.
      if (mesh.styles?.length)
        x.styles = mesh.styles.map((l) => [
          ...[1, 3, 5].map((i) => parseInt(l.color.slice(i, i + 2), 16) / 255),
          1 - l.opacity,
        ]);
    }
    elements[out.globalIds.get(e.id)!] = x;
  }
  const count = (k: string) => doc.elements.filter((e) => e.kind === k).length;
  return {
    storeys: doc.levels.length,
    counts: {
      IfcWall: count('wall'),
      IfcSlab: count('slab'),
      IfcColumn: count('column'),
      IfcBeam: count('beam'),
      IfcMember: count('member'),
      IfcRamp: count('ramp'),
      IfcRailing: count('railing'),
      IfcStair: count('stair'),
      IfcDoor: count('door'),
      IfcWindow: count('window'),
      IfcRoof: count('roof'),
      IfcSpace: count('space'),
      IfcBuildingElementProxy: count('part'),
      IfcOpeningElement: count('opening') + count('door') + count('window'),
      IfcRelConnectsPathElements: doc.joins.length,
      // LR3: a ramp is not typed by its slab type, LS5: nor a railing by its wall type, LS6: nor
      // a stair by its slab type.
      IfcRelDefinesByType: new Set(
        doc.elements
          .filter((e) => 'typeId' in e && !['ramp', 'railing', 'stair'].includes(e.kind))
          .map((e) => (e as { typeId: string }).typeId),
      ).size,
      IfcFacetedBrep: [...(options.parts?.values() ?? [])].reduce(
        (n, p) => n + (solidParts.get(p)?.breps ?? 0),
        0,
      ),
      IfcTriangulatedFaceSet: [...(options.parts?.values() ?? [])].reduce(
        (n, p) => n + (solidParts.get(p)?.faceSets ?? 0),
        leanFaceSets + rampFaceSets,
      ),
      IfcShellBasedSurfaceModel: [...(options.parts?.values() ?? [])].filter(
        (p) => p.kind === 'sheet',
      ).length,
    },
    elements,
  };
}

/** FU3b: a window in a ring wall leaning in hard (Codex): its panel keeps the cut's angles. */
function leanArcWindow(): BimDocument {
  const d = f50Lean();
  d.types.push({ id: 't-window-900', kind: 'window', name: 'W', widthMm: 900, heightMm: 1500 });
  const ring = d.elements.find((e) => e.id === 'w-ring-1') as BimWall;
  d.elements = [
    { ...ring, typeId: 't-wall-200', lean: -0.6 },
    {
      id: 'win-ring',
      kind: 'window',
      typeId: 't-window-900',
      hostId: 'w-ring-1',
      alongMm: 1000,
      sillMm: 1000,
      flipFacing: false,
    },
  ];
  d.joins = [];
  return d;
}

const cases = () =>
  [
    ['f31', f31BoxBuilding(), opts],
    ['f37', f37Office(), opts],
    ['f35', ...Object.values(f35Export())],
    ['f39-gable', ...Object.values(f39Export('gable'))],
    ['f39-hip', ...Object.values(f39Export('hip'))],
    ['arc-joins', ...Object.values(arcJoinsExport())],
    ['f40', f40Lattice(), opts],
    ['f47', f47Taper(), opts],
    ['f48', f48Ramp(), opts],
    ['f49', f49Pipes(), opts],
    ['f50', f50Lean(), opts],
    ['f51', f51Ramps(), opts],
    ['f52', f52LeanOpenings(), opts],
    ['f52-arc', leanArcWindow(), opts],
    ['f54', ...Object.values(f54Export())],
    ['f54-joins', f54LeanJoins(), opts],
    ['f55', f55RampOpenings(), opts],
    ['f55s', f55Stairs(), opts],
  ] as [string, BimDocument, BimIfcExportOptions][];

describe('IFC export (R2c-4a, CAD66)', () => {
  it('writes F31, F35, F37 and F39 for the independent reader', () => {
    const dir = process.env.BIM_IFC_OUT;
    for (const [name, doc, options] of cases()) {
      const out = writeIfc(doc, options);
      expect(out.text.startsWith('ISO-10303-21;\nHEADER;\n')).toBe(true);
      expect(out.text).toContain("FILE_SCHEMA(('IFC4'));");
      expect(out.text).toContain("'2026-10-24T12:00:00'");
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(`${dir}/${name}.ifc`, out.bytes);
        writeFileSync(
          `${dir}/${name}.expected.json`,
          JSON.stringify(expectations(doc, out, options)),
        );
      }
    }
  });

  it("writes a stair's steps and its common properties in one Pset_StairCommon (LS6, Codex)", () => {
    const doc = f55Stairs();
    doc.elements.find((e) => e.id === 'st-main')!.common = { fireRating: 'REI 60' };
    const text = writeIfc(doc, opts).text;
    // One set a stair: names are unique on an object.
    expect(text.match(/IFCPROPERTYSET\([^;]*'Pset_StairCommon'/g)).toHaveLength(2);
    expect(text).toContain("IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 60'),$)");
  });

  it('samples an arc whose sweep changes with height alike at base and top (LS2, Codex)', () => {
    // An upright quarter of 8,000 mm whose end follows a wall leaning 0.03 rad: within 1 mm,
    // its sweep 2 mrad shorter at the top. Written as triangles, edge for edge.
    const doc = f54LeanJoins();
    const { lean: _, ...base } = element<BimWall>(doc, 'w-lean');
    doc.elements = [
      {
        ...base,
        id: 'w-arc',
        start: { xy: [8000, 0] },
        end: { xy: [0, 8000] },
        bulge: Math.tan(Math.PI / 8),
      },
      { ...base, id: 'w-st', start: { xy: [0, 8000] }, end: { xy: [0, 12000] }, lean: 0.03 },
    ];
    doc.joins = [{ id: 'j', walls: ['w-arc', 'w-st'], kind: 'butt', through: 'w-st' }];
    const d = deriveBim(doc);
    expect(d.diagnostics).toEqual([]);
    expect(d.quantities.get('w-arc')?.source).toBe('kernel');
    const kernelQuantities = new Map([
      ['w-arc', { grossVolume: 1, netVolume: 1 }],
      ['w-st', { grossVolume: 1, netVolume: 1 }],
    ]);
    const out = writeIfc(doc, { ...opts, kernelQuantities });
    // Every triangle names points that exist.
    const list = out.text.match(/IFCCARTESIANPOINTLIST3D\(\((.*)\)\);/)![1]!.split('),(').length;
    const faces = out.text.match(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\.,\((.*?)\),\$\)/);
    expect(faces).not.toBeNull();
    const used = [...faces![1]!.matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(Math.max(...used)).toBeLessThanOrEqual(list);
    expect(used.every((k) => k >= 1)).toBe(true);
  });

  it('gives a panel in a leaning wall its own body, level at its ends like the cut (FU3b, Codex)', () => {
    const out = writeIfc(f52LeanOpenings(), opts);
    const lines = new Map(
      [...out.text.matchAll(/^#(\d+)=(\w+)\((.*)\);$/gm)].map((m) => [`#${m[1]}`, [m[2]!, m[3]!]]),
    );
    const refs = (id: string) => [...lines.get(id)![1].matchAll(/#\d+/g)].map((m) => m[0]);
    const nums = (id: string) =>
      lines
        .get(id)![1]
        .match(/-?[\d.]+(?:E-?\d+)?/g)!
        .map(Number);
    for (const [id, lean, side] of [
      ['win-free', Math.PI / 12, 1],
      ['door-free', Math.PI / 12, 1],
      ['win-sq', 0.2, -1],
    ] as const) {
      const gid = out.globalIds.get(id)!;
      const product = [...lines].find(([, [, args]]) => args.startsWith(`'${gid}'`))![0];
      // ObjectPlacement, then Representation → its Body → the one item.
      const [placement, shape] = refs(product);
      const rep = refs(shape!).at(-1)!;
      expect(lines.get(rep)![1]).toContain("'Body','SweptSolid'");
      const item = refs(rep).at(-1)!;
      expect(lines.get(item)![0]).toBe('IFCEXTRUDEDAREASOLID');
      const [profile, direction] = refs(item);
      const d = nums(direction!);
      [0, -side * Math.sin(lean), Math.cos(lean)].forEach((v, k) => expect(d[k]).toBeCloseTo(v, 6));
      expect(nums(profile!).at(-1)).toBeCloseTo(50 / Math.cos(lean), 6);
      // The placement stands level: its axis is the vertical.
      const axis = lines.get(refs(placement!).at(-1)!)![1].split(',')[1]!;
      if (axis !== '$') expect(nums(axis)).toEqual([0, 0, 1]);
    }
  });
  it('gives a panel in a leaning arc wall the band between the angles of its cut (FU3b, Codex)', () => {
    const out = writeIfc(leanArcWindow(), opts);
    const gid = out.globalIds.get('win-ring')!;
    const product = out.text.split('\n').find((l) => l.includes(`IFCWINDOW('${gid}'`))!;
    const shape = product.match(/#\d+/g)![2]!;
    const line = (id: string) => out.text.match(new RegExp(`^${id}=(.*)$`, 'm'))![1]!;
    const rep = line(shape).match(/#\d+/g)!.at(-1)!;
    expect(line(rep)).toContain("'Body','SweptSolid'");
    expect(line(line(rep).match(/#\d+/g)!.at(-1)!)).toMatch(/^IFCREVOLVEDAREASOLID\(/);
  });
  it('gives the same bytes and GlobalIds for the same content', () => {
    for (const [, doc, options] of cases()) {
      const a = writeIfc(doc, options);
      const b = writeIfc(structuredClone(doc), options);
      expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
      expect([...a.globalIds]).toEqual([...b.globalIds]);
    }
    const doc = f31BoxBuilding();
    const first = writeIfc(doc, opts).globalIds.get('w-south');
    // Another Artifact gets other IDs; an edit keeps them; a kept IFC GlobalId wins.
    expect(writeIfc(doc, { ...opts, artifactId: 'art-2' }).globalIds.get('w-south')).not.toBe(
      first,
    );
    element<BimWall>(doc, 'w-south').name = 'South';
    expect(writeIfc(doc, opts).globalIds.get('w-south')).toBe(first);
    element<BimWall>(doc, 'w-south').ifcGlobalId = '2O2Fr$t4X7Zf8NOew3FLOH';
    const kept = writeIfc(doc, opts);
    expect(kept.globalIds.get('w-south')).toBe('2O2Fr$t4X7Zf8NOew3FLOH');
    expect(kept.text).toContain("IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH'");
    const ids = [
      ...writeIfc(f37Office(), opts).text.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm),
    ].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes members as IfcMember braces and keeps their constraints (TW2)', () => {
    const t = writeIfc(f40Lattice(), opts).text;
    expect(t).toMatch(/IFCMEMBERTYPE\('[^']+',\$,'Steel box 300'.*\.BRACE\.\);/);
    expect(t.match(/^#\d+=IFCMEMBER\(.*\.BRACE\.\);$/gm)).toHaveLength(4);
    expect(t).toContain("IFCPROPERTYSET('");
    expect(t).toContain("'Qto_MemberBaseQuantities'");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Rotation',$,IFCPLANEANGLEMEASURE(0.3),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('TopAtX',$,IFCLENGTHMEASURE(2000.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('EndTopOffset',$,IFCLENGTHMEASURE(1500.),$)");
  });

  it('writes tapered columns as tapered extrusions to the same profile scaled (TW5)', () => {
    const t = writeIfc(f47Taper(), opts).text;
    expect(t.match(/^#\d+=IFCEXTRUDEDAREASOLIDTAPERED\(/gm)).toHaveLength(4);
    // The ends: every size scaled, walls too (Ø1,200 by 0.25; the 800 box of 40 walls by 0.75).
    expect(t).toContain('=IFCCIRCLEPROFILEDEF(.AREA.,$,$,150.);');
    expect(t).toContain('=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,$,600.,600.,30.,$,$);');
    expect(t).toContain('=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,300.,300.);');
    expect(t).not.toContain('IFCDERIVEDPROFILEDEF');
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('TopScale',$,IFCREAL(0.6),$)");
    expect(writeIfc(f40Lattice(), opts).text).not.toContain('TAPERED');
  });

  it('writes steel pipes as circular hollow sections, a tapered one with its wall scaled (#936)', () => {
    const t = writeIfc(f49Pipes(), opts).text;
    expect(t).toContain(
      "=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,'Steel pipe column 600x25',$,300.,25.);",
    );
    expect(t).toContain("=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,'Steel pipe 300x12',$,150.,12.);");
    // The tapered column's top: Ø600 × 25 scaled by 0.5.
    expect(t).toContain('=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,$,150.,12.5);');
    expect(t.match(/^#\d+=IFCEXTRUDEDAREASOLIDTAPERED\(/gm)).toHaveLength(1);
  });

  it('writes leaning walls slanted, revolved or as ruled triangles, by their shape (LR2b)', () => {
    const t = writeIfc(f50Lean(), opts).text;
    // The free wall: its footprint extruded slanted, 15° from the vertical across its axis.
    const c = Math.cos(Math.PI / 12);
    const s = Math.sin(Math.PI / 12);
    const trunc = (v: number) => String(Math.floor(v * 1e6) / 1e6).replace('.', '\\.');
    expect(t).toMatch(
      new RegExp(`=IFCDIRECTION\\(\\(0\\.,-${trunc(s)}\\d*,${trunc(c)}\\d*\\)\\);`),
    );
    // The ring's four cones: the section revolved a quarter turn about the centre.
    expect(t.match(/^#\d+=IFCREVOLVEDAREASOLID\(/gm)).toHaveLength(4);
    // The mitred square and the L: ruled faces as triangles.
    expect(t.match(/'Body','Tessellation',/g)).toHaveLength(6);
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Lean',$,IFCPLANEANGLEMEASURE(0.3),$)");
  });

  it('refuses a ramp too large to tessellate before writing it (Codex)', () => {
    const doc = f51Ramps();
    const r = doc.elements.find((e) => e.id === 'r-spiral')!;
    if (r.kind !== 'ramp') throw new Error('not a ramp');
    r.innerRadiusMm = 1;
    r.outerRadiusMm = 1_000_000;
    r.sweepRad = 6 * Math.PI;
    r.top = { level: r.base.level, offsetMm: 900_000 };
    expect(() => writeIfc(doc, opts)).toThrow('ramp-too-detailed: r-spiral');
  });

  it('writes spiral ramps as IfcRamp SPIRAL_RAMP of closed triangles, untyped (LR3b)', () => {
    const out = writeIfc(f51Ramps(), opts);
    const t = out.text;
    expect(t.match(/^#\d+=IFCRAMP\(.*,\.SPIRAL_RAMP\.\);$/gm)).toHaveLength(3);
    expect(t.match(/'Body','Tessellation',/g)).toHaveLength(3);
    expect(t).not.toContain('IFCRELDEFINESBYTYPE');
    expect(t).toContain(
      `IFCPROPERTYSINGLEVALUE('Type',$,IFCIDENTIFIER('${out.globalIds.get('t-slab-200')}'),$)`,
    );
    expect(t).toContain(
      "IFCPROPERTYSINGLEVALUE('Sweep',$,IFCPLANEANGLEMEASURE(-1.5707963267948966),$)",
    );
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('OuterRadius',$,IFCLENGTHMEASURE(5000.),$)");
    expect(t).toContain("IFCPROPERTYSET('");
    expect(t).not.toContain('Qto_Ramp');
    // Each ramp's points: within its circle and its heights, each written once.
    for (const id of ['r-spiral', 'r-quarter', 'r-down']) {
      const gid = out.globalIds.get(id)!;
      expect(t).toMatch(new RegExp(`IFCRAMP\\('${gid.replace(/\$/g, '\\$')}'`));
    }
  });

  it('writes railings as IfcRailing GUARDRAIL bands of triangles, host and side kept (LS5)', () => {
    const out = writeIfc(f55RampOpenings(), opts);
    const t = out.text;
    expect(t.match(/^#\d+=IFCRAILING\(.*,\.GUARDRAIL\.\);$/gm)).toHaveLength(3);
    // Three ramps and three railings, all of closed triangles; neither typed by its wall type.
    expect(t.match(/'Body','Tessellation',/g)).toHaveLength(6);
    expect(t).not.toContain('IFCRELDEFINESBYTYPE');
    expect(t).toContain(
      `IFCPROPERTYSINGLEVALUE('Type',$,IFCIDENTIFIER('${out.globalIds.get('t-rail-50')}'),$)`,
    );
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Host',$,IFCIDENTIFIER('r-spiral'),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Side',$,IFCLABEL('outer'),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(1200.),$)");
    expect(t).toMatch(/IFCMATERIALLAYERSETUSAGE\(#\d+,\.AXIS2\.,\.POSITIVE\.,0\.,\$\)/);
    expect(t).toContain("'Qto_RailingBaseQuantities'");
  });

  it('writes sloped slabs as extrusions clipped by their top and bottom planes (TW5)', () => {
    const t = writeIfc(f48Ramp(), opts).text;
    expect(t.match(/^#\d+=IFCSHAPEREPRESENTATION\(#\d+,'Body','Clipping',/gm)).toHaveLength(2);
    expect(t.match(/^#\d+=IFCBOOLEANCLIPPINGRESULT\(/gm)).toHaveLength(4);
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('SlopeEdge',$,IFCINTEGER(3),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('SlopeEndTopOffset',$,IFCLENGTHMEASURE(-1000.),$)");
    expect(writeIfc(f31BoxBuilding(), opts).text).not.toContain('SlopeEdge');
  });

  it('maps types, joins, properties and constraints', () => {
    const { doc, options } = f35Export();
    const t = writeIfc(doc, options).text;
    expect(t).toMatch(/IFCWALLTYPE\('[^']+',\$,'RC 180 \+ plaster 20'/);
    expect(t).toContain("IFCPROPERTYSET('");
    expect(t).toContain("'Fire safety'");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Minutes',$,IFCREAL(60.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Tested',$,IFCBOOLEAN(.T.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Cover',$,IFCLENGTHMEASURE(30.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('EW-1'),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('TopHeight',$,IFCLENGTHMEASURE(9000.),$)");
    expect(t).toContain("IFCPROPERTYSINGLEVALUE('ClipBy',$,IFCIDENTIFIER('r-roof'),$)");
    expect(t).toContain(
      `IFCPROPERTYSINGLEVALUE('ContentHash',$,IFCIDENTIFIER('${'c0ffee'.repeat(10)}c0ff'),$)`,
    );
    expect(t).toContain("'EP_PartReference'");
    expect(t).toMatch(
      /IFCRELCONNECTSPATHELEMENTS\('[^']+',\$,'butt','j-se',\$,#\d+,#\d+,\(1\),\(0\),\.ATSTART\.,\.ATEND\.\)/,
    );
    expect(t).toContain('IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.');
    expect(t).toContain('IFCARCINDEX((');
    expect(t).toContain("'Clipping'");
    for (const k of [
      'IFCISHAPEPROFILEDEF',
      'IFCLSHAPEPROFILEDEF',
      'IFCUSHAPEPROFILEDEF',
      'IFCRECTANGLEHOLLOWPROFILEDEF',
      'IFCCIRCLEPROFILEDEF',
    ])
      expect(t).toContain(`=${k}(`);
    // Units: mm, m², m³, rad; quantities in them.
    expect(t).toContain('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
    expect(t).toContain("IFCQUANTITYLENGTH('Length',$,$,10000.,$)");
  });

  it('keeps GlobalIds unique and texts within their IFC types', () => {
    const doc = f31BoxBuilding();
    // Entity IDs that look like the writer's own keys.
    element(doc, 'd-entrance').id = '~site';
    const renamed: Record<string, string> = {
      'l-1f': 'project',
      'l-2f': 'agg:project',
      'l-rf': 'w-south:constraints',
    };
    for (const l of doc.levels) l.id = renamed[l.id];
    for (const e of doc.elements)
      for (const k of ['base', 'top'] as const) {
        const h = (e as unknown as Record<string, { level?: string } | undefined>)[k];
        if (h?.level) h.level = renamed[h.level];
      }
    doc.propertySets.push({
      id: 'ps-note',
      name: 'Notes',
      properties: [{ name: 'Text', type: 'string' }],
    });
    // Another definition with the same name, on the same element.
    doc.propertySets.push({
      id: 'ps-note-2',
      name: 'Notes',
      properties: [{ name: 'Text', type: 'string' }],
    });
    element<BimWall>(doc, 'w-south').properties = {
      'ps-note': { Text: 'n'.repeat(1000) },
      'ps-note-2': { Text: 'second' },
    };
    const t = writeIfc(doc, opts).text;
    const ids = [...t.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(t).toContain(`IFCTEXT('${'n'.repeat(1000)}')`);
    // Two sets and their two templates.
    expect(t.match(/'Notes'/g)).toHaveLength(4);
    // A set with no values is refused, not dropped (IfcPropertySet needs one property).
    element<BimWall>(doc, 'w-north').properties = { 'ps-note': {} };
    expect(() => writeIfc(doc, opts)).toThrow('invalid-document');
    // A grid's constraint set and an element named `grid`.
    const grid = f31BoxBuilding();
    grid.grids = [
      { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
      { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0] },
    ];
    element(grid, 'win-e1').id = 'grid';
    const gt = writeIfc(grid, opts).text;
    expect(gt).toContain('IFCGRID(');
    const gids = [...gt.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]);
    expect(new Set(gids).size).toBe(gids.length);
    // Two long grid-axis IDs are kept whole.
    const axis = (c: string) => c.repeat(128);
    for (const a of grid.grids) a.id = axis(a.label === 'A' ? 'a' : 'b');
    grid.elements.push({
      id: 'c-long',
      kind: 'column',
      typeId: 't-column-600',
      at: { grid: [axis('a'), axis('b')] },
      rotationRad: 0,
      base: { level: 'l-1f', offsetMm: 0 },
      top: { level: 'l-2f', offsetMm: 0 },
    });
    const long = writeIfc(grid, opts).text;
    for (const c of ['a', 'b']) expect(long).toContain(`IFCIDENTIFIER('${axis(c)}')`);
    // Axes 30° apart are two directions: the grid is written.
    const skew = f31BoxBuilding();
    skew.grids = [
      { id: 'g,a', label: 'A', start: [0, 0], end: [10000, 0] },
      { id: 'g', label: '1', start: [0, 0], end: [10000 * Math.cos(Math.PI / 6), 5000] },
    ];
    expect(writeIfc(skew, opts).text.match(/=IFCGRIDAXIS\(/g)).toHaveLength(2);
    // A GlobalId kept from an import must stay unique.
    const kept = f31BoxBuilding();
    element(kept, 'w-south').ifcGlobalId = '0123456789012345678901';
    element(kept, 'w-north').ifcGlobalId = '0123456789012345678901';
    expect(() => writeIfc(kept, opts)).toThrow('global-id-duplicate');
    // A door's opening is named after it, within IfcLabel's 255 characters.
    const door = f31BoxBuilding();
    element(door, 'd-entrance').name = 'd'.repeat(255);
    expect(writeIfc(door, opts).text).toContain(`'${'d'.repeat(247)} opening'`);
  });

  it('keeps an opening in a tight arc wall clear of the centre', () => {
    const doc = f31BoxBuilding();
    const wall: BimWall = {
      ...element<BimWall>(doc, 'w-south'),
      start: { xy: [0, 0] },
      end: { xy: [210, 0] },
      bulge: 1,
    };
    // A 200 mm wall on a 105 mm radius: the inner face's radius is 5 mm.
    doc.elements = [
      wall,
      {
        id: 'o-tight',
        kind: 'opening',
        hostId: wall.id,
        wall: { alongMm: 50, sillMm: 0, widthMm: 100, heightMm: 1000 },
      },
    ];
    doc.joins = [];
    const t = writeIfc(doc, opts).text;
    const lists = [...t.matchAll(/IFCCARTESIANPOINTLIST2D\(\((.*)\)\)/g)].map((m) =>
      [...m[1].matchAll(/\(([-\d.E]+),([-\d.E]+)\)/g)].map((p) => [+p[1], +p[2]] as Vec2),
    );
    // The wall turns through y < 0; a negative inner radius would put points on the other side.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const points of lists) for (const [, y] of points) expect(y).toBeLessThan(1e-9);
  });

  it('writes a solid body as a triangulated face set, each point once at 0.001 mm (TW0a)', () => {
    const { doc, options } = f35Export();
    const nudged: BimIfcPartMesh = {
      ...cube,
      positions: cube.positions.map((v, i) => (i === 0 ? v + 0.000_4 : i === 1 ? v + 1 / 3 : v)),
    };
    const out = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', nudged]]),
    }).text;
    const set = out.match(/=IFCTRIANGULATEDFACESET\((#\d+),\$,\.T\.,\((.*)\),\$\);$/m)!;
    expect(set).toBeTruthy();
    // 12 triangles over the cube's 8 corners, by 1-based index.
    const triangles = [...set[2]!.matchAll(/\((\d+),(\d+),(\d+)\)/g)].map((m) =>
      m.slice(1).map(Number),
    );
    expect(triangles).toHaveLength(12);
    expect(new Set(triangles.flat())).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    const list = out.match(
      new RegExp(`^${set[1]}=IFCCARTESIANPOINTLIST3D\\(\\((.*)\\)\\);$`, 'm'),
    )!;
    const points = [...list[1]!.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]!.split(',').map(Number));
    expect(points).toHaveLength(8);
    // Rounded to 0.001 mm: 0.0004 is gone, 1/3 keeps three decimals.
    expect(points[0]).toEqual([0, 0.333, 0]);
    // The face set's representation is a tessellation; no point is written on its own.
    expect(out).toContain("'Body','Tessellation'");
    expect(out).not.toContain('IFCCARTESIANPOINT((0.,0.333');
  });

  it('writes each body of a part mesh as its own shell', () => {
    const { doc, options } = f35Export();
    const twoCubes: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v, i) => (i % 3 === 0 ? v + 3000 : v))],
      triangles: [...cube.triangles, ...cube.triangles.map((v) => v + 8)],
    };
    const one = writeIfc(doc, options).text;
    const two = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', twoCubes]]),
    }).text;
    const faceSets = (t: string) => t.match(/=IFCTRIANGULATEDFACESET\(/g)?.length ?? 0;
    expect(faceSets(two)).toBe(faceSets(one) + 1);
    // Cubes touching at a corner are still two bodies.
    const corner: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v) => v + 1000)],
      triangles: twoCubes.triangles,
    };
    const c = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', corner]]),
    }).text;
    expect(faceSets(c)).toBe(faceSets(one) + 1);
    // F35's hollow part is the cube with its cavity cut out.
    expect(one).toMatch(/=IFCBOOLEANRESULT\(\.DIFFERENCE\.,#\d+,#\d+\)/);
    // A cavity goes to the body it lies inside, not to a ring whose bounds merely contain it.
    const box = (lo: number[], hi: number[], inward = false): BimIfcPartMesh => ({
      ...cube,
      positions: cube.positions.map((v, i) => lo[i % 3] + (v / 1000) * (hi[i % 3] - lo[i % 3])),
      triangles: inward ? hollow.triangles.slice(36).map((v) => v - 8) : cube.triangles,
    });
    const join = (...meshes: BimIfcPartMesh[]): BimIfcPartMesh => ({
      ...cube,
      positions: meshes.flatMap((m) => [...m.positions]),
      triangles: meshes.flatMap((m, i) => m.triangles.map((v) => v + 8 * i)),
    });
    const ringed = join(
      box([0, 0, 0], [1000, 50, 1000]),
      box([0, 950, 0], [1000, 1000, 1000]),
      box([0, 50, 0], [50, 950, 1000]),
      box([950, 50, 0], [1000, 950, 1000]),
      box([100, 100, 100], [900, 900, 900]),
      box([300, 300, 300], [700, 700, 700], true),
    );
    const r = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-box', ringed]]),
    }).text;
    const entity = (ref: string) => r.match(new RegExp(`^${ref}=(\\w+)\\((.*)\\);$`, 'm'))!;
    const differences = [...r.matchAll(/=IFCBOOLEANRESULT\(\.DIFFERENCE\.,(#\d+),#\d+\)/g)];
    const cut = differences
      .map((m) => entity(entity(m[1])[2])[2])
      .map((shell) => shell.split(',').length);
    // F35's hollow cube, and the 800 mm cube here: both outer shells of 12 triangles.
    expect(cut).toEqual([12, 12]);
    // A cavity outside every body is refused.
    const stray: BimIfcPartMesh = {
      ...cube,
      positions: [...cube.positions, ...cube.positions.map((v) => v + 5000)],
      triangles: hollow.triangles,
    };
    expect(() =>
      writeIfc(doc, { ...options, parts: new Map([...options.parts!, ['p-box', stray]]) }),
    ).toThrow('part-cavity');
  });

  it("colours a part's items by its CAD bodies' looks (OH-U1)", () => {
    const { doc, options } = f35Export();
    const count = (t: string, name: string) => t.match(new RegExp(`=${name}\\(`, 'g'))?.length ?? 0;
    // Two sheets apart, each its own look: a surface model each, styled apart.
    const glass = { color: '#38bdf8', opacity: 0.4 };
    const tile = { color: '#F2EFE6', opacity: 1 };
    const two: BimIfcPartMesh = {
      ...sheet,
      positions: [...sheet.positions, ...sheet.positions.map((v, i) => (i % 3 === 2 ? 500 : v))],
      triangles: [...sheet.triangles, ...sheet.triangles.map((v) => v + 4)],
      styles: [glass, tile],
      triangleStyles: [0, 0, 1, 1],
    };
    const out = writeIfc(doc, {
      ...options,
      parts: new Map([...options.parts!, ['p-sheet', two]]),
    }).text;
    expect(count(out, 'IFCSHELLBASEDSURFACEMODEL')).toBe(2);
    expect(out).toContain("IFCSURFACESTYLE('#f2efe6',.BOTH.,");
    expect(out).toMatch(/=IFCSURFACESTYLERENDERING\(#\d+,0\.6,\$,\$,\$,\$,\$,\$,\.NOTDEFINED\.\);/);
    // The same look on both: one surface model; a look already written is shared.
    const same = writeIfc(doc, {
      ...options,
      parts: new Map([
        ...options.parts!,
        ['p-sheet', { ...two, styles: [glass, glass] }],
        ['p-box', { ...cube, styles: [glass], triangleStyles: Array<number>(12).fill(0) }],
      ]),
    }).text;
    expect(count(same, 'IFCSHELLBASEDSURFACEMODEL')).toBe(1);
    expect(count(same, 'IFCSURFACESTYLE')).toBe(2);
    expect(count(same, 'IFCSTYLEDITEM')).toBe(3);
    // Without looks (or with a colour that is not #rrggbb), no style.
    const plain = writeIfc(doc, {
      ...options,
      parts: new Map([
        ['p-box', cube],
        ['p-hollow', { ...hollow, styles: undefined }],
        ['p-sheet', { ...sheet, styles: [{ color: 'white', opacity: 1 }] }],
      ]),
    }).text;
    expect(count(plain, 'IFCSTYLEDITEM')).toBe(0);
  });

  it('relates a butt join through the wall derivation runs through', () => {
    const doc = f31BoxBuilding();
    // A T without `through`: the stopping wall listed first.
    doc.elements.push({
      ...element<BimWall>(doc, 'w-south'),
      id: 'w-inner',
      start: { xy: [4000, 0] },
      end: { xy: [4000, 3000] },
    });
    doc.joins.push({ id: 'j-tee', walls: ['w-inner', 'w-south'], kind: 'butt' });
    const out = writeIfc(doc, opts);
    const line = (start: string) => out.text.split('\n').find((l) => l.includes(start))!;
    const rel = line(`IFCRELCONNECTSPATHELEMENTS('${out.globalIds.get('j-tee')}'`);
    const ref = (id: string) => line(`=IFCWALL('${out.globalIds.get(id)}'`).split('=')[0];
    expect(rel).toContain(`,${ref('w-south')},${ref('w-inner')},(1),(0),`);
  });

  it('keeps only plan quantities of clipped elements from the analysis', () => {
    const { doc, options } = f35Export();
    const t = writeIfc(doc, options).text;
    const south = deriveBim(doc).quantities.get('w-south')!;
    expect(south.source).toBe('kernel');
    // The unclipped height would be 9,000 mm; the clipped one is the kernel's to report.
    expect(t).not.toContain("IFCQUANTITYLENGTH('Height',$,$,9000.,$)");
    expect(t).toContain(`IFCQUANTITYLENGTH('Length',$,$,${south.values.length}`);
  });

  it('refuses what it cannot write faithfully', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (err) {
        expect(err).toBeInstanceOf(BimIfcExportError);
        return [(err as BimIfcExportError).code, (err as BimIfcExportError).ids];
      }
      return undefined;
    };
    const { doc, options } = f35Export();
    expect(code(() => writeIfc(doc, { ...options, kernelQuantities: undefined }))).toEqual([
      'evaluation-required',
      ['w-south', 'w-east', 'w-north', 'w-west', 'c-clip'],
    ]);
    expect(code(() => writeIfc(doc, { ...options, parts: new Map([['p-box', cube]]) }))).toEqual([
      'evaluation-required',
      ['p-hollow', 'p-sheet'],
    ]);
    expect(
      code(() =>
        writeIfc(doc, {
          ...options,
          parts: new Map([
            ['p-box', { ...cube, kind: 'mixed' }],
            ['p-hollow', hollow],
            ['p-sheet', sheet],
          ]),
        }),
      ),
    ).toEqual(['part-mixed-kinds', ['p-box']]);
    const broken = f31BoxBuilding();
    element<BimWall>(broken, 'w-east').top = { level: 'l-1f', offsetMm: 0 };
    expect(code(() => writeIfc(broken, opts))?.[0]).toBe('invalid-document');
  });
});

describe('P21 values', () => {
  it('writes reals, strings and GUIDs in the exchange form', () => {
    expect(formatReal(4000)).toBe('4000.');
    expect(formatReal(-0)).toBe('0.');
    expect(formatReal(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(formatReal(1e-7)).toBe('1.E-7');
    expect(formatReal(1.5e21)).toBe('1.5E21');
    expect(() => formatReal(Number.NaN)).toThrow();
    expect(formatString("it's a\\b")).toBe("'it''s a\\\\b'");
    expect(formatString('壁 A')).toBe("'\\X2\\58C1\\X0\\ A'");
    // Reference values from IfcOpenShell's ifcopenshell.guid.compress.
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(compressGuid(hex('00000000000000000000000000000000'))).toBe('0000000000000000000000');
    expect(compressGuid(hex('ffffffffffffffffffffffffffffffff'))).toBe('3$$$$$$$$$$$$$$$$$$$$$');
    expect(compressGuid(hex('3a1b2c3d4e5f60718293a4b5c6d7e8f9'))).toBe('0w6omzJbzWSOAJfBN6r_Zv');
    expect(stableGuid('x')).toBe(stableGuid('x'));
    expect(stableGuid('x')).not.toBe(stableGuid('y'));
  });
});
