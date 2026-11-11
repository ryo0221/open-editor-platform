import { describe, expect, it } from 'vitest';
import { dependencyOrder, featureKind, featureReads, featureReferenceSources } from './graph';
import {
  f02Plate,
  f17Boundaries,
  f17Sheets,
  f17Surfaces,
  f18Hood,
  f18Sheets,
  f19Network,
  f20SheetFillet,
  f21OffsetSurface,
  f22Split,
  f23PressLine,
  f24Flare,
  f47Flange,
  f25B1Car,
  f26Panel,
  f27Windows,
} from './fixtures';
import { mm, position, type CadDocument } from './model';
import {
  applyCadOperation,
  dependencyClosure,
  duplicateClosureOf,
  type CadOperation,
} from './operations';
import { cutBoundaryName, remapTopoName, thickenSideName, formatFaceName } from './topology';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
type Loose = Record<string, unknown> & { features: Record<string, unknown>[] };
const changed = (doc: CadDocument, change: (d: Loose) => void) => {
  const out = structuredClone(doc) as unknown as Loose;
  change(out);
  return out;
};

describe('sheet bodies (R2a-1, CAD39)', () => {
  it('admits the surface features as sheet bodies', () => {
    for (const kind of ['extrude', 'closed', 'revolve'] as const) {
      const doc = f17Sheets(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'sheet')).toBe('sheet');
      expect(featureKind(doc, 'surface-placement')).toBe('sheet');
    }
    expect(f02Plate().bodies.every((b) => b.kind === 'solid')).toBe(true);
  });

  it('reports a mirror without arguments instead of throwing', () => {
    const doc = changed(f17Sheets('closed'), (d) =>
      d.features.push({
        id: 'm',
        name: 'Mirror',
        type: 'mirror',
        inputFeatureIds: ['surface-placement'],
        args: null,
      }),
    );
    expect(() => validateCad(doc)).not.toThrow();
    expect(codes(doc)).toContain('feature-args@$.features[2].args');
  });

  it('refuses a body whose kind is not its result’s', () => {
    expect(
      codes(changed(f17Sheets('extrude'), (d) => ((d.bodies as Loose[])[0]!.kind = 'solid'))),
    ).toEqual(['body-kind@$.bodies[0].kind']);
    expect(
      codes(changed(f17Sheets('extrude'), (d) => ((d.bodies as Loose[])[0]!.kind = 'shell'))),
    ).toEqual(['body-kind@$.bodies[0].kind']);
  });

  it('refuses a sheet where a solid is needed, and the operation leaves the document', () => {
    const sheet = f17Sheets('extrude');
    const plate = f02Plate();
    // A Boolean of the plate and the sheet: the sheet input is refused.
    const both = applyCadOperation(plate, {
      type: 'insertFeatures',
      sketches: sheet.sketches,
      features: sheet.features
        .filter((f) => f.id === 'sheet')
        .map((f) => ({ ...f, args: { ...f.args, distance: mm(30) } }) as typeof f),
      bodies: [
        {
          id: 'surface',
          name: 'surface',
          sourceFeatureId: 'sheet',
          placementFeatureId: 'surface-placement',
          appearance: { color: '#9aa4b1', opacity: 1 },
        },
      ],
    });
    const before = structuredClone(both);
    expect(() =>
      applyCadOperation(both, {
        type: 'booleanBodies',
        targetId: 'plate',
        toolId: 'surface',
        mode: 'cut',
        booleanFeatureId: 'u',
        placementFeatureId: 'u-placement',
      }),
    ).toThrow();
    expect(both).toEqual(before);
    const fillet = changed(sheet, (d) =>
      d.features.push({
        id: 'round',
        name: 'Round',
        type: 'shell',
        inputFeatureIds: ['surface-placement'],
        args: { openFaces: [], thickness: mm(1), side: 'inside' },
      }),
    );
    expect(codes(fillet)).toContain('sheet-not-solid@$.features[2].inputFeatureIds[0]');
  });

  // TS-1484, ST-247.
  it('admits a fillet on a sheet and checks its varying radius (CR1e)', () => {
    for (const kind of ['constant', 'linear', 'points', 'free'] as const) {
      const doc = f20SheetFillet(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'fillet')).toBe('sheet');
    }
    const doc = f20SheetFillet('points');
    const at = `$.features[${doc.features.findIndex((f) => f.id === 'fillet')}].args`;
    type Args = { radiusEnd?: unknown; radii?: { at: number; radius: unknown }[] };
    const args = (d: Loose) => d.features.find((f) => f.id === 'fillet')!.args as Args;
    const endless = changed(doc, (d) => void delete args(d).radiusEnd);
    expect(codes(endless)).toEqual([`fillet-radii-end@${at}.radii`]);
    const none = changed(doc, (d) => void (args(d).radii = []));
    expect(codes(none)).toEqual([`fillet-radii@${at}.radii`]);
    const seven = changed(
      doc,
      (d) =>
        void (args(d).radii = [1, 2, 3, 4, 5, 6, 7].map((k) => ({ at: k / 8, radius: mm(5) }))),
    );
    expect(codes(seven)).toEqual([`fillet-radii@${at}.radii`]);
    const back = changed(
      doc,
      (d) =>
        void (args(d).radii = [
          { at: 0.5, radius: mm(5) },
          { at: 0.25, radius: mm(5) },
          { at: 1, radius: mm(5) },
        ]),
    );
    expect(codes(back)).toEqual([
      `fillet-radii-at@${at}.radii[1].at`,
      `fillet-radii-at@${at}.radii[2].at`,
    ]);
    const zero = changed(doc, (d) => void (args(d).radii![0]!.radius = mm(0)));
    expect(codes(zero)).toEqual([`dimension-range@${at}.radii[0].radius`]);
    // The varying radii are lengths the feature reads, like its radius.
    const read = structuredClone(doc.features.find((f) => f.id === 'fillet')!) as Extract<
      CadDocument['features'][number],
      { type: 'fillet' }
    >;
    read.args.radiusEnd = { parameterId: 'End' };
    read.args.radii = [{ at: 0.5, radius: { parameterId: 'Mid' } }];
    expect(featureReads(read).parameters).toEqual(['End', 'Mid']);
  });

  // TS-1487, ST-248.
  it('admits a row of closed chains in one trim and refuses shared, open and stray chains (CR3c)', () => {
    // TS-1508, ST-255.
    const doc = f27Windows();
    expect(codes(doc)).toEqual([]);
    expect(codes(f27Windows('missed', 'skip'))).toEqual([]);
    const i = doc.features.findIndex((f) => f.id === 'windows-trim');
    type Args = { chains: unknown; ifMissed?: unknown; tool: unknown; keep: string };
    const args = (d: Loose) => d.features[i]!.args as Args;
    const at = `$.features[${i}].args`;
    const chains = (d: Loose) => args(d).chains as string[][];
    expect(codes(changed(doc, (d) => void chains(d)[0]!.pop()))).toEqual([
      `trim-tool-open@${at}.chains[0]`,
    ]);
    expect(
      codes(changed(doc, (d) => void (chains(d)[1] = ['w0s0', 'w0s1', 'w0s2', 'w0s3']))),
    ).toEqual([`trim-chains-shared@${at}.chains[1]`]);
    expect(codes(changed(doc, (d) => void (chains(d)[0] = ['w1s0', 'w1s2'])))).toEqual([
      `sweep-path-gap@${at}.chains[0][1]`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d).chains = [])))).toEqual([
      `trim-chains@${at}.chains`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d).ifMissed = 'refuse')))).toEqual([
      `trim-if-missed@${at}.ifMissed`,
    ]);
    // More chains and `ifMissed` need the tool's sketch.
    const planed = changed(doc, (d) => {
      args(d).tool = { plane: { origin: position(50, 0, 0), normal: [1, 0, 0] } };
      args(d).keep = 'front';
      args(d).ifMissed = 'skip';
    });
    expect(codes(planed)).toEqual([
      `trim-chains-tool@${at}.chains`,
      `trim-chains-tool@${at}.ifMissed`,
    ]);
  });

  it('admits a panel cut out with its trim in one edit and refuses gaps, tools and sources (CR3b)', () => {
    // TS-1505, ST-254.
    const doc = f26Panel();
    expect(codes(doc)).toEqual([]);
    expect(codes(f26Panel('channel'))).toEqual([]);
    expect(doc.bodies.map((b) => [b.id, b.kind])).toEqual([
      ['panel-body', 'sheet'],
      ['door-body', 'sheet'],
    ]);
    const door = doc.features.findIndex((f) => f.id === 'door');
    const trim = doc.features.findIndex((f) => f.id === 'trim');
    type Args = { gap: unknown; keep: string; tool: { elements: string[] } };
    const args = (d: Loose, i: number) => d.features[i]!.args as Args;
    expect(codes(changed(doc, (d) => void (args(d, door).gap = mm(12))))).toEqual([
      `panel-gap@$.features[${door}].args.gap`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d, trim).gap = mm(0.2))))).toEqual([
      `panel-gap@$.features[${trim}].args.gap`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d, door).keep = 'front')))).toEqual([
      `trim-keep@$.features[${door}].args.keep`,
    ]);
    expect(codes(changed(doc, (d) => void args(d, door).tool.elements.pop()))).toEqual([
      `trim-tool-open@$.features[${door}].args.tool.elements`,
    ]);
    // A gap needs a sketch chain: a plane cut has none.
    const planed = changed(doc, (d) => {
      (d.features[trim]!.args as { tool: unknown }).tool = {
        plane: { origin: position(50, 0, 0), normal: [1, 0, 0] },
      };
      (d.features[trim]!.args as { keep: string }).keep = 'front';
    });
    expect(codes(planed)).toEqual([`trim-gap-tool@$.features[${trim}].args.gap`]);
    // The panel reads the body's result before the trim; the source runs first.
    const graph = dependencyOrder(doc);
    if (!('order' in graph)) throw new Error('cycle');
    expect(graph.order.indexOf('door')).toBeGreaterThan(
      graph.order.indexOf('panel-body-placement'),
    );
    expect(featureReferenceSources(doc.features[door]!)).toEqual(['panel-body-placement']);
    // One edit: a panel without its trim, or from another source, is refused.
    const base = f22Split('closed', false);
    const op = (source: string): CadOperation => ({
      type: 'detailBody',
      bodyId: 'panel-body',
      placementFeatureId: 'trim-placement',
      feature: {
        id: 'trim',
        name: 'Trim',
        type: 'trim',
        inputFeatureIds: [base.bodies[0]!.resultFeatureId],
        args: { tool: { sketchId: 'cutter', elements: ['s0', 's1', 's2', 's3'] }, keep: 'outside' },
      },
      panel: {
        feature: {
          id: 'door',
          name: 'Door',
          type: 'panel',
          inputFeatureIds: [],
          args: {
            source: { featureId: source },
            tool: { sketchId: 'cutter', elements: ['s0', 's1', 's2', 's3'] },
            keep: 'inside',
            gap: mm(3.5),
          },
        },
        body: {
          id: 'door-body',
          name: 'Door',
          sourceFeatureId: 'door',
          placementFeatureId: 'door-placement',
          appearance: { color: '#888888', opacity: 1 },
        },
      },
    });
    expect(() => applyCadOperation(base, op('panel'))).toThrow('detail-panel');
    expect(codes(applyCadOperation(base, op(base.bodies[0]!.resultFeatureId)))).toEqual([]);
    // A copy keeps its panel's names with the copy's ID.
    expect(remapTopoName([['panel:door:inside', 'side:e:l']], { door: 'd2' })).toEqual([
      ['panel:d2:inside', 'side:e:l'],
    ]);
  });

  it('admits an offset surface of a sheet and refuses its distance, side and a solid (CR2b)', () => {
    const doc = f21OffsetSurface();
    expect(codes(doc)).toEqual([]);
    expect(doc.bodies.map((b) => b.kind)).toEqual(['sheet', 'sheet']);
    const i = doc.features.findIndex((f) => f.id === 'inner');
    const at = `$.features[${i}].args`;
    type Args = { distance: unknown; side: string; source: { featureId: string } };
    const args = (d: Loose) => d.features[i]!.args as Args;
    expect(codes(changed(doc, (d) => void (args(d).distance = mm(150))))).toEqual([
      `offset-distance@${at}.distance`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d).side = 'both')))).toEqual([
      `offset-side@${at}.side`,
    ]);
    expect(codes(changed(doc, (d) => void (args(d).source.featureId = 'nope')))).toEqual([
      `reference-feature@${at}.source.featureId`,
    ]);
    // The source is read, so it runs first; a solid's result is refused.
    const graph = dependencyOrder(doc);
    if (!('order' in graph)) throw new Error('cycle');
    expect(graph.order.indexOf('inner')).toBeGreaterThan(
      graph.order.indexOf(doc.bodies[0]!.resultFeatureId),
    );
    const plate = f02Plate();
    const solid = changed(plate, (d) =>
      d.features.push({
        id: 'skin',
        name: 'Skin',
        type: 'offsetSurface',
        inputFeatureIds: [],
        args: {
          source: { featureId: plate.bodies[0]!.resultFeatureId },
          distance: mm(1),
          side: 'front',
        },
      }),
    );
    expect(codes(solid)).toEqual([
      `solid-not-sheet@$.features[${plate.features.length}].args.source.featureId`,
    ]);
  });

  // TS-1490, ST-249.
  it('admits a split of a sheet along an open or closed chain and refuses a solid (CR2a)', () => {
    for (const kind of ['open', 'closed'] as const) {
      const doc = f22Split(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'split')).toBe('sheet');
      expect(featureReads(doc.features.find((f) => f.id === 'split')!).sketches).toEqual([
        'cutter',
      ]);
    }
    const doc = f22Split('open');
    const i = doc.features.findIndex((f) => f.id === 'split');
    const missing = changed(doc, (d) => {
      (d.features[i]!.args as { tool: { sketchId: string } }).tool.sketchId = 'nope';
    });
    expect(codes(missing)).toContain(`sketch-missing@$.features[${i}].args.tool.sketchId`);
    // A duplicated body's split names its pieces and edges by the copy's ID (Codex on #919).
    expect(
      remapTopoName(
        [
          ['split:split:left', 'side:e:l'],
          ['split:split', 'end'],
        ],
        { split: 'split-copy' },
      ),
    ).toEqual([
      ['split:split-copy', 'end'],
      ['split:split-copy:left', 'side:e:l'],
    ]);
    const plate = f02Plate();
    const solid = changed(plate, (d) =>
      d.features.push({
        id: 'cut',
        name: 'Cut',
        type: 'split',
        inputFeatureIds: [plate.bodies[0]!.resultFeatureId],
        args: { tool: { sketchId: 'nope', elements: ['x'] } },
      }),
    );
    expect(codes(solid)).toContain(
      `solid-not-sheet@$.features[${plate.features.length}].inputFeatureIds[0]`,
    );
  });

  // TS-1493, ST-250.
  it('admits a press line on a sheet and checks its side, depth and direction (CR2c)', () => {
    for (const kind of ['open', 'closed'] as const) {
      const doc = f23PressLine(kind);
      expect(codes(doc)).toEqual([]);
      expect(featureKind(doc, 'press')).toBe('sheet');
      const press = doc.features.find((f) => f.id === 'press')!;
      expect(featureReads(press).sketches).toEqual(['cutter']);
    }
    const doc = f23PressLine('open');
    const i = doc.features.findIndex((f) => f.id === 'press');
    const set = (patch: Record<string, unknown>) =>
      codes(changed(doc, (d) => Object.assign(d.features[i]!.args as object, patch)));
    // An open line has a left and a right, a closed one an inside and an outside.
    expect(set({ side: 'inside' })).toEqual([`press-line-side@$.features[${i}].args.side`]);
    const closed = f23PressLine('closed');
    expect(
      codes(changed(closed, (d) => Object.assign(d.features[i]!.args as object, { side: 'left' }))),
    ).toEqual([`press-line-side@$.features[${i}].args.side`]);
    expect(set({ depth: mm(0.05) })).toEqual([`press-line-depth@$.features[${i}].args.depth`]);
    expect(set({ depth: mm(21) })).toEqual([`press-line-depth@$.features[${i}].args.depth`]);
    expect(set({ depth: mm(20) })).toEqual([]);
    expect(set({ toward: 'up' })).toEqual([`press-line-toward@$.features[${i}].args.toward`]);
    // A duplicated body's press line names its pieces and walls by the copy's ID.
    const wall = `wall:${JSON.stringify([
      ['press:press:moved', 'side:e:l'],
      ['press:press:right', 'side:e:l'],
    ])}`;
    expect(remapTopoName([['press:press:end', 'start']], { press: 'p2' })).toEqual([
      ['press:p2:end', 'start'],
    ]);
    expect(remapTopoName([['press:press', wall]], { press: 'p2' })).toEqual([
      [
        'press:p2',
        `wall:${JSON.stringify([
          ['press:p2:moved', 'side:e:l'],
          ['press:p2:right', 'side:e:l'],
        ])}`,
      ],
    ]);
    const plate = f02Plate();
    const solid = changed(plate, (d) =>
      d.features.push({
        id: 'press',
        name: 'Press',
        type: 'pressLine',
        inputFeatureIds: [plate.bodies[0]!.resultFeatureId],
        args: {
          tool: { sketchId: 'nope', elements: ['x'] },
          side: 'left',
          depth: mm(1),
          toward: 'front',
          radius: mm(0.5),
        },
      }),
    );
    expect(codes(solid)).toContain(
      `solid-not-sheet@$.features[${plate.features.length}].inputFeatureIds[0]`,
    );
  });

  // TS-1496, ST-251.
  it('admits a flare on a sheet and checks its chain, arch, height and continuity (CR2d)', () => {
    const doc = f24Flare();
    expect(codes(doc)).toEqual([]);
    expect(featureKind(doc, 'flare')).toBe('sheet');
    const i = doc.features.findIndex((f) => f.id === 'flare');
    const flare = doc.features[i]!;
    expect(featureReads(flare).sketches).toEqual(['flare-line']);
    const set = (patch: Record<string, unknown>) =>
      codes(changed(doc, (d) => Object.assign(d.features[i]!.args as object, patch)));
    expect(set({ height: mm(0.5) })).toEqual([`flare-height@$.features[${i}].args.height`]);
    expect(set({ height: mm(101) })).toEqual([`flare-height@$.features[${i}].args.height`]);
    expect(set({ height: mm(100) })).toEqual([]);
    expect(set({ continuity: 'G0' })).toEqual([
      `flare-continuity@$.features[${i}].args.continuity`,
    ]);
    // The chain is open: the wheel's closed circle is no flare line.
    expect(set({ tool: { sketchId: 'wheel', elements: ['a0', 'a1'] } })).toEqual([
      `flare-chain-closed@$.features[${i}].args.tool`,
    ]);
    // A duplicated body's flare names its pieces and new edges by the copy's ID.
    expect(remapTopoName([['flare:flare:moved', 'end']], { flare: 'f2' })).toEqual([
      ['flare:f2:moved', 'end'],
    ]);
    expect(remapTopoName([['flare:flare:last', 'end']], { flare: 'f2' })).toEqual([
      ['flare:f2:last', 'end'],
    ]);
    expect(remapTopoName([['flare:flare', 'surface']], { flare: 'f2' })).toEqual([
      ['flare:f2', 'surface'],
    ]);
  });

  // TS-1536, ST-263.
  it('admits a flange on a sheet and checks its edges, width, angle and side (CR4c)', () => {
    const doc = f47Flange('tray');
    expect(codes(doc)).toEqual([]);
    expect(featureKind(doc, 'flange')).toBe('sheet');
    const i = doc.features.findIndex((f) => f.id === 'flange');
    const set = (patch: Record<string, unknown>) =>
      codes(changed(doc, (d) => Object.assign(d.features[i]!.args as object, patch)));
    const at = (k: string) => `$.features[${i}].args.${k}`;
    expect(set({ width: mm(0.5) })).toEqual([`flange-width@${at('width')}`]);
    expect(set({ width: mm(201) })).toEqual([`flange-width@${at('width')}`]);
    expect(set({ width: mm(200) })).toEqual([]);
    expect(set({ angle: { literalRad: Math.PI } })).toEqual([]);
    expect(set({ angle: { literalRad: Math.PI + 0.01 } })).toEqual([`flange-angle@${at('angle')}`]);
    expect(set({ angle: { literalRad: 0 } })).toEqual([`angle-range@${at('angle')}`]);
    expect(set({ toward: 'up' })).toEqual([`flange-toward@${at('toward')}`]);
    expect(set({ edges: [] })).toEqual([`reference-count@${at('edges')}`]);
    const edges = (doc.features[i]!.args as { edges: unknown[] }).edges;
    expect(set({ edges: [edges[0], edges[0]] })).toEqual([`reference-duplicate@${at('edges')}`]);
    // Its input is a sheet.
    const solid = changed(f02Plate(), (d) =>
      d.features.push({ ...doc.features[i]!, inputFeatureIds: [d.features.at(-1)!.id] }),
    );
    expect(codes(solid).some((c) => c.startsWith('solid-not-sheet@'))).toBe(true);
    // A duplicated body's flange names its sheet, walls and their new edges by the copy's ID.
    for (const tag of ['wall', 'far', 'start', 'end'])
      expect(remapTopoName([[`flange:flange:${tag}`, '0']], { flange: 'f2' })).toEqual([
        [`flange:f2:${tag}`, '0'],
      ]);
    expect(remapTopoName([['flange:flange', 'side:e:l']], { flange: 'f2' })).toEqual([
      ['flange:f2', 'side:e:l'],
    ]);
  });

  it('checks the surface features’ chains and axes', () => {
    const gap = changed(f17Sheets('closed'), (d) => {
      const f = d.features[0]!.args as { path: { elements: string[] } };
      f.path.elements = ['l0', 'l2'];
    });
    expect(codes(gap)).toEqual(['sweep-path-gap@$.features[0].args.path.elements[1]']);
    const crossing = changed(f17Sheets('revolve'), (d) => {
      (d.features[0]!.args as { axisOrigin: unknown }).axisOrigin = [mm(5), mm(0)];
    });
    expect(codes(crossing)).toEqual(['revolve-crosses-axis@$.features[0].args']);
    const missing = changed(f17Sheets('extrude'), (d) => {
      (d.features[0]!.args as { path: { sketchId: string } }).path.sketchId = 'nope';
    });
    expect(codes(missing)).toContain('sketch-missing@$.features[0].args.path.sketchId');
  });

  it('refuses an imported feature without a body kind', () => {
    const doc = changed(f17Sheets('closed'), (d) =>
      d.features.push({
        id: 'imp',
        name: 'x',
        type: 'imported',
        inputFeatureIds: [],
        args: { kind: 'surface' },
      }),
    );
    expect(codes(doc)).toContain('body-kind@$.features[2].args.kind');
  });
});

describe('lofted and swept sheets (R2a-2b, CAD41)', () => {
  type Chain = { sketchId: string; elements: string[] };
  const loftOf = (d: Loose) => d.features[0]!.args as { sections: Chain[] };
  const sweepOf = (d: Loose) => d.features[0]!.args as { profile: Chain; path: Chain };

  it('admits lofts through open or closed chains and sweeps of a chain as sheets', () => {
    for (const kind of ['loft', 'closed', 'sweep'] as const) {
      const doc = f17Surfaces(kind);
      expect(codes(doc)).toEqual([]);
      expect(doc.bodies[0]).toMatchObject({ kind: 'sheet' });
      expect(featureKind(doc, 'sheet')).toBe('sheet');
    }
    // A loft reads each section's sketch; a sweep its profile's and its path's.
    expect(featureReads(f17Surfaces('loft').features[0]!).sketches).toEqual(['curve', 'upper']);
    expect(featureReads(f17Surfaces('sweep').features[0]!).sketches).toEqual(['profile', 'rail']);
  });

  it('refuses a loft that mixes open and closed chains, repeats a sketch or has too few', () => {
    const mixed = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[1]!.elements = ['b-l0', 'b-l1'];
    });
    expect(codes(mixed)).toEqual(['loft-section-closure@$.features[0].args.sections[1].elements']);
    const same = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[1] = { sketchId: 'a', elements: ['a-l0', 'a-l1', 'a-l2', 'a-l3'] };
    });
    expect(codes(same)).toEqual(['loft-same-sketch@$.features[0].args.sections[1].sketchId']);
    const one = changed(f17Surfaces('loft'), (d) => {
      loftOf(d).sections.pop();
    });
    expect(codes(one)).toEqual(['loft-sections@$.features[0].args.sections']);
    const many = changed(f17Surfaces('loft'), (d) => {
      loftOf(d).sections = Array.from({ length: 33 }, () => loftOf(d).sections[0]!);
    });
    expect(codes(many)).toEqual(['limit-loft-sections@$.features[0].args.sections']);
    const gap = changed(f17Surfaces('closed'), (d) => {
      loftOf(d).sections[0]!.elements = ['a-l0', 'a-l2'];
    });
    expect(codes(gap)).toEqual(['sweep-path-gap@$.features[0].args.sections[0].elements[1]']);
  });

  it('refuses a sweep along a closed path or in its profile’s sketch', () => {
    const doc = f17Surfaces('sweep');
    const loop = changed(doc, (d) => {
      const rail = (d.sketches as { id: string; entities: unknown[] }[]).find(
        (s) => s.id === 'rail',
      )!;
      rail.entities.push({ type: 'line', id: 'back', start: 'e', end: 's' });
      sweepOf(d).path.elements = ['turn', 'back'];
    });
    expect(codes(loop)).toEqual(['sweep-path-closed@$.features[0].args.path.elements']);
    const same = changed(doc, (d) => {
      sweepOf(d).path = { sketchId: 'profile', elements: ['l0'] };
    });
    expect(codes(same)).toContain('sweep-same-sketch@$.features[0].args.path.sketchId');
    const orientation = changed(doc, (d) => {
      (d.features[0]!.args as { orientation: string }).orientation = 'twist';
    });
    expect(codes(orientation)).toEqual(['sweep-orientation@$.features[0].args.orientation']);
  });
});

describe('boundary surfaces, fills and lofts from edges (R2a-2c, CAD41)', () => {
  const kinds = ['hypar', 'quarter', 'fill', 'cap', 'dome', 'edgeLoft'] as const;
  type Curve = Record<string, unknown>;
  const argsOf = (d: Loose, id: string) =>
    d.features.find((f) => f.id === id)!.args as {
      curves: Curve[];
      boundary: { curve: Curve; continuity: string }[];
      sections: unknown[];
    };

  it('admits every F17 boundary as a sheet that reads the results its edges come from', () => {
    for (const kind of kinds) {
      const doc = f17Boundaries(kind);
      expect(codes(doc)).toEqual([]);
      for (const b of doc.bodies) expect(b).toMatchObject({ kind: 'sheet' });
    }
    const hypar = f17Boundaries('hypar');
    expect(featureKind(hypar, 'sheet')).toBe('sheet');
    expect([...featureReads(hypar.features[0]!).sketches].sort()).toEqual([
      'east',
      'floor',
      'north',
    ]);
    // The cap reads the tube's placement by its edges: after it in order, and removed with it.
    const cap = f17Boundaries('cap');
    const fill = cap.features.find((f) => f.id === 'cap')!;
    expect(featureKind(cap, 'cap')).toBe('sheet');
    expect(featureReferenceSources(fill)).toEqual(['surface-placement']);
    const order = dependencyOrder(cap);
    if (!('order' in order)) throw new Error('cycle');
    expect(order.order.indexOf('surface-placement')).toBeLessThan(order.order.indexOf('cap'));
    expect(dependencyClosure(cap, ['sheet']).features.has('cap')).toBe(true);
    const loft = f17Boundaries('edgeLoft');
    expect(featureReferenceSources(loft.features.find((f) => f.id === 'cap')!)).toEqual([
      'surface-placement',
    ]);
    expect(dependencyClosure(loft, ['surface']).features.has('cap')).toBe(true);
  });

  it('refuses curves that are too few or many, not one curve, repeated or missing', () => {
    const hypar = f17Boundaries('hypar');
    const at = '$.features[0].args';
    const few = changed(hypar, (d) => void argsOf(d, 'sheet').curves.splice(2));
    expect(codes(few)).toEqual([`boundary-curves@${at}.curves`]);
    const many = changed(hypar, (d) => {
      const curves = argsOf(d, 'sheet').curves;
      curves.push(curves[0]!);
    });
    expect(codes(many)).toEqual([`boundary-curves@${at}.curves`]);
    const twice = changed(hypar, (d) => {
      const curves = argsOf(d, 'sheet').curves;
      curves[3] = curves[0]!;
    });
    expect(codes(twice)).toEqual([`boundary-curve-duplicate@${at}.curves[3]`]);
    const point = changed(hypar, (d) => void (argsOf(d, 'sheet').curves[0]!.element = 'a'));
    expect(codes(point)).toEqual([`boundary-curve@${at}.curves[0].element`]);
    const lost = changed(hypar, (d) => void (argsOf(d, 'sheet').curves[1]!.sketchId = 'west'));
    expect(codes(lost)).toEqual([`sketch-missing@${at}.curves[1].sketchId`]);
  });

  // TS-1482, ST-246.
  it('admits a curve network and refuses its counts, tolerance and a curve used twice (CR1d)', () => {
    const net = f19Network();
    expect(codes(net)).toEqual([]);
    const at = '$.features[0].args';
    const ways = (d: Loose) =>
      d.features.find((f) => f.id === 'net')!.args as unknown as {
        u: Curve[];
        v: Curve[];
        toleranceMm: number;
      };
    const one = changed(net, (d) => void ways(d).v.splice(1));
    expect(codes(one)).toEqual([`curve-network-curves@${at}.v`]);
    const loose = changed(net, (d) => void (ways(d).toleranceMm = 2));
    expect(codes(loose)).toEqual([`curve-network-tolerance@${at}.toleranceMm`]);
    const twice = changed(net, (d) => void (ways(d).v[2] = ways(d).u[0]!));
    expect(codes(twice)).toEqual([`boundary-curve-duplicate@${at}.v[2]`]);
    // An edge in either direction is read like a boundary curve's edge (CR1d review).
    const edges = featureReferenceSources({
      type: 'curveNetwork',
      args: {
        u: [{ edge: { featureId: 'a', kind: 'edge', name: 'x' } }, { sketchId: 's', element: 'e' }],
        v: [{ edge: { featureId: 'b', kind: 'edge', name: 'y' } }],
        toleranceMm: 0.01,
      },
    } as never);
    expect(edges).toEqual(['a', 'b']);
  });

  it('refuses a fill’s boundary count, its continuity, and G1 where no face is beside', () => {
    const at = '$.features[0].args';
    const fill = f17Boundaries('fill');
    const two = changed(fill, (d) => void argsOf(d, 'sheet').boundary.splice(2));
    expect(codes(two)).toEqual([`fill-boundary@${at}.boundary`]);
    const g3 = changed(
      fill,
      (d) => void (argsOf(d, 'sheet').boundary[1]!.continuity = 'G3' as 'G2'),
    );
    expect(codes(g3)).toEqual([`fill-continuity@${at}.boundary[1].continuity`]);
    // CR1b: G2, like G1, needs the face beside a referenced edge.
    const g2 = changed(fill, (d) => void (argsOf(d, 'sheet').boundary[0]!.continuity = 'G2'));
    expect(codes(g2)).toEqual([`fill-no-adjacent-face@${at}.boundary[0].continuity`]);
    const g1 = changed(fill, (d) => void (argsOf(d, 'sheet').boundary[0]!.continuity = 'G1'));
    expect(codes(g1)).toEqual([`fill-no-adjacent-face@${at}.boundary[0].continuity`]);
    // A referenced edge reads its feature: one that does not exist is refused at the reference,
    // and the fill's own result is a cycle.
    const cap = f17Boundaries('cap');
    const index = cap.features.findIndex((f) => f.id === 'cap');
    const refTo = (featureId: string) =>
      changed(cap, (d) => {
        const ref = argsOf(d, 'cap').boundary[2]!.curve.edge as { featureId: string };
        ref.featureId = featureId;
      });
    expect(codes(refTo('ghost'))).toEqual([
      `reference-feature@$.features[${index}].args.boundary[2].curve.edge.featureId`,
    ]);
    expect(codes(refTo('cap-body-placement'))).toEqual(['cad-dependency-cycle@$']);
    const loft = f17Boundaries('edgeLoft');
    const empty = changed(loft, (d) => void (argsOf(d, 'cap').sections[0] = { edges: [] }));
    expect(codes(empty)).toEqual([`reference-count@$.features[${index}].args.sections[0].edges`]);
  });
});

describe('trim, sew and thicken (R2a-3, CAD42)', () => {
  const index = (doc: CadDocument | Loose, id: string) =>
    (doc.features as { id: string }[]).findIndex((f) => f.id === id);
  const argsOf = (d: Loose, id: string) =>
    d.features[index(d, id)]!.args as Record<string, unknown>;

  it('admits the F18 hood: sew consumes its tools, trim keeps a sheet, thicken gives a solid', () => {
    for (const stage of ['sheets', 'sew', 'trim', 'thicken'] as const)
      expect(codes(f18Hood(stage))).toEqual([]);
    const sew = f18Hood('sew');
    expect(sew.bodies.map((b) => [b.id, b.kind, b.state])).toEqual([
      ['left', 'sheet', 'active'],
      ['right', 'sheet', 'consumed'],
      ['crown', 'sheet', 'consumed'],
    ]);
    expect(featureKind(sew, 'sew')).toBe('sheet');
    const hood = f18Hood('thicken');
    expect(featureKind(hood, 'window-cut')).toBe('sheet');
    expect(featureKind(hood, 'skin')).toBe('solid');
    expect(hood.bodies.find((b) => b.id === 'left')).toMatchObject({ kind: 'solid' });
    // The window's sketch is read like any sketch, and goes with what reads it.
    expect(featureReads(hood.features[index(hood, 'window-cut')]!).sketches).toEqual(['window']);
    expect(dependencyClosure(hood, ['window']).features.has('skin')).toBe(true);
    const box = f18Sheets({ kind: 'box' });
    expect(codes(box)).toEqual([]);
    expect(featureKind(box, 'sew')).toBe('solid');
    expect(box.bodies.find((b) => b.id === 'surface')).toMatchObject({ kind: 'solid' });
    // Turning the sew's `solid` off and on again carries the body's kind with it, one edit each.
    const toggled = (doc: CadDocument, solid: boolean) =>
      applyCadOperation(doc, {
        type: 'updateFeature',
        featureId: 'sew',
        args: { ...(argsOf(doc as unknown as Loose, 'sew') as { toleranceMm: number }), solid },
      } as CadOperation);
    const open = toggled(box, false);
    expect(codes(open)).toEqual([]);
    expect(open.bodies.find((b) => b.id === 'surface')).toMatchObject({ kind: 'sheet' });
    expect(toggled(open, true).bodies.find((b) => b.id === 'surface')).toMatchObject({
      kind: 'solid',
    });
    for (const tool of ['circle', 'plane', 'wall', 'partial', 'miss'] as const)
      expect(
        codes(f18Sheets({ kind: 'trim', tool, keep: tool === 'circle' ? 'inside' : 'front' })),
      ).toEqual([]);
    // Another sheet a trim cuts with is read, not consumed, and removed with what reads it.
    const wall = f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' });
    expect(featureReferenceSources(wall.features[index(wall, 'cut')]!)).toEqual([
      'blade-placement',
    ]);
    expect(wall.bodies.find((b) => b.id === 'blade')).toMatchObject({ state: 'active' });
    expect(dependencyClosure(wall, ['blade']).features.has('cut')).toBe(true);
  });

  it('refuses a trim’s tool and side, and a trim, sew or thicken of a solid', () => {
    const circle = f18Sheets({ kind: 'trim', tool: 'circle', keep: 'inside' });
    const at = `$.features[${index(circle, 'cut')}].args`;
    const side = changed(circle, (d) => void (argsOf(d, 'cut').keep = 'front'));
    expect(codes(side)).toEqual([`trim-keep@${at}.keep`]);
    const open = changed(circle, (d) => {
      (argsOf(d, 'cut').tool as { elements: string[] }).elements = ['a0'];
    });
    expect(codes(open)).toEqual([`trim-tool-open@${at}.tool.elements`]);
    const plane = f18Sheets({ kind: 'trim', tool: 'plane', keep: 'front' });
    const skew = changed(plane, (d) => {
      (argsOf(d, 'cut').tool as { plane: { normal: number[] } }).plane.normal = [1, 1, 0];
    });
    expect(codes(skew)).toEqual([`trim-normal@${at}.tool.plane.normal`]);
    const odd = changed(plane, (d) => void (argsOf(d, 'cut').keep = 'inside'));
    expect(codes(odd)).toEqual([`trim-keep@${at}.keep`]);
    const nothing = changed(plane, (d) => void (argsOf(d, 'cut').tool = { line: [] }));
    expect(codes(nothing)).toEqual([`trim-tool@${at}.tool`]);
    const wall = f18Sheets({ kind: 'trim', tool: 'wall', keep: 'front' });
    const wat = `$.features[${index(wall, 'cut')}].args`;
    const toolTo = (featureId: string) =>
      changed(wall, (d) => void (argsOf(d, 'cut').tool = { featureId }));
    expect(codes(toolTo('ghost'))).toEqual([`reference-feature@${wat}.tool.featureId`]);
    expect(codes(toolTo('surface-placement'))).toEqual([`trim-tool-self@${wat}.tool.featureId`]);
    expect(codes(toolTo('cut-placement'))).toEqual(['cad-dependency-cycle@$']);
    // A solid is not a sheet: as the trimmed input, as the cutting sheet, sewn or thickened.
    const withBox = changed(wall, (d) => {
      d.features.push({
        id: 'cube',
        name: 'cube',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(5), mm(5), mm(5)],
          origin: [mm(0), mm(0), mm(0)],
          orientation: [0, 0, 0, 1],
        },
      });
    });
    const cube = index(withBox, 'cube');
    const asTool = changed(withBox as unknown as CadDocument, (d) => {
      argsOf(d, 'cut').tool = { featureId: 'cube' };
    });
    expect(codes(asTool)).toContain(`solid-not-sheet@${wat}.tool.featureId`);
    const box = f02Plate();
    const plate = box.bodies[0]!;
    const onSolid = (feature: Record<string, unknown>) =>
      changed(
        box,
        (d) => void d.features.push({ ...feature, inputFeatureIds: [plate.resultFeatureId] }),
      );
    const n = box.features.length;
    expect(
      codes(
        onSolid({ id: 'k', name: 'k', type: 'thicken', args: { thickness: mm(1), side: 'front' } }),
      ),
    ).toEqual([`solid-not-sheet@$.features[${n}].inputFeatureIds[0]`]);
    expect(
      codes(
        onSolid({
          id: 'k',
          name: 'k',
          type: 'trim',
          args: {
            tool: { plane: { origin: [mm(0), mm(0), mm(0)], normal: [1, 0, 0] } },
            keep: 'front',
          },
        }),
      ),
    ).toEqual([`solid-not-sheet@$.features[${n}].inputFeatureIds[0]`]);
    expect(cube).toBeGreaterThan(0);
  });

  it('refuses a sew’s distance, a repeated input, a thicken’s side, and sews only sheets', () => {
    const sew = f18Hood('sew');
    const at = `$.features[${index(sew, 'sew')}]`;
    for (const t of [0, 0.0000009, 0.00011, -1])
      expect(codes(changed(sew, (d) => void (argsOf(d, 'sew').toleranceMm = t)))).toEqual([
        `sew-tolerance@${at}.args.toleranceMm`,
      ]);
    expect(codes(changed(sew, (d) => void (argsOf(d, 'sew').solid = 'yes')))).toEqual([
      `sew-solid@${at}.args.solid`,
    ]);
    const twice = changed(sew, (d) => {
      const f = d.features[index(d, 'sew')]! as { inputFeatureIds: string[] };
      f.inputFeatureIds[2] = f.inputFeatureIds[1]!;
    });
    expect(codes(twice)).toContain(`sew-same-input@${at}.inputFeatureIds`);
    const hood = f18Hood('thicken');
    const skin = `$.features[${index(hood, 'skin')}].args.side`;
    expect(codes(changed(hood, (d) => void (argsOf(d, 'skin').side = 'inside')))).toEqual([
      `thicken-side@${skin}`,
    ]);
    // The operation refuses before the document: a body twice, the target among the tools.
    const op = (toolIds: string[]): CadOperation => ({
      type: 'sewBodies',
      targetId: 'left',
      toolIds,
      toleranceMm: 0.0001,
      solid: false,
      sewFeatureId: 's2',
      placementFeatureId: 's2-placement',
    });
    const sheets = f18Hood('sheets');
    expect(() => applyCadOperation(sheets, op(['right', 'right']))).toThrow('sew-inputs');
    expect(() => applyCadOperation(sheets, op(['left']))).toThrow('sew-same-body');
    expect(() => applyCadOperation(sew, op(['right']))).toThrow('body-consumed');
    // A sew of a solid is refused at its input.
    const cube = (id: string) => ({
      id,
      name: id,
      type: 'box' as const,
      inputFeatureIds: [] as [],
      args: {
        size: [mm(5), mm(5), mm(5)] as [
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
        ],
        origin: [mm(0), mm(0), mm(0)] as [
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
          ReturnType<typeof mm>,
        ],
        orientation: [0, 0, 0, 1] as [number, number, number, number],
      },
    });
    const solids = applyCadOperation(sheets, {
      type: 'insertFeatures',
      features: [cube('c1'), cube('c2')],
      bodies: ['c1', 'c2'].map((id) => ({
        id: `${id}-body`,
        name: id,
        sourceFeatureId: id,
        placementFeatureId: `${id}-placement`,
        appearance: { color: '#9aa4b1', opacity: 1 },
      })),
    });
    expect(() =>
      applyCadOperation(solids, { ...op(['c2-body']), targetId: 'c1-body' } as CadOperation),
    ).toThrow(/solid-not-sheet/);
  });

  it('names pieces, cuts and sides with the IDs a duplicate maps (命名)', () => {
    expect(formatFaceName(cutBoundaryName({ sketchId: 'window', element: 'e0' }))).toBe(
      'sketch:window/cut:e:e0',
    );
    expect(cutBoundaryName({ plane: true })).toEqual(['cut:plane']);
    const fromSheet = cutBoundaryName({ featureId: 'blade-placement', face: ['side:e:l'] });
    expect(formatFaceName(fromSheet)).toBe('from:blade-placement/cut:(side:e:l)');
    const side = thickenSideName([['sketch:floor', 'boundary:e:ab'], ['surface']]);
    expect(formatFaceName(side)).toBe('side:(sketch:floor/boundary:e:ab | surface)');
    const map = { cut: 'cut2', 'blade-placement': 'b2', window: 'w2', 'left-placement': 'l2' };
    expect(
      remapTopoName([['trim:cut:front', 'sew:left-placement', 'surface'], [...fromSheet]], map),
    ).toEqual([
      ['from:b2', 'cut:[["side:e:l"]]'],
      ['trim:cut2:front', 'sew:l2', 'surface'],
    ]);
    // The whole hood copies, its sew, window and skin included.
    const hood = f18Hood('thicken');
    const { ids } = duplicateClosureOf(hood, ['left']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `${id}-2`]));
    const copy = applyCadOperation(hood, { type: 'duplicateClosure', bodyIds: ['left'], idMap });
    expect(codes(copy)).toEqual([]);
    expect(copy.bodies.filter((b) => b.state === 'consumed')).toHaveLength(4);
  });

  it('keeps the B1 sample valid at any wheelbase and roof height (CR2e)', () => {
    // TS-1499, ST-252: every feature of the sample, the parameters only moving sketches.
    const car = f25B1Car();
    expect(codes(car)).toEqual([]);
    expect(car.features.map((f) => f.type)).toEqual(
      expect.arrayContaining(['curveNetwork', 'trim', 'flare', 'pressLine', 'offsetSurface']),
    );
    expect(car.features.filter((f) => f.type === 'flare')).toHaveLength(2);
    expect(car.sketches.length).toBeLessThanOrEqual(64);
    let longer = applyCadOperation(car, {
      type: 'setParameter',
      parameterId: 'wheelbase',
      value: 2500,
    });
    longer = applyCadOperation(longer, { type: 'setParameter', parameterId: 'roof', value: 1400 });
    expect(codes(longer)).toEqual([]);
    expect(longer.features).toEqual(car.features);
    expect(longer.parameters.map((p) => p.value)).toEqual([2500, 1400]);
  });
});
