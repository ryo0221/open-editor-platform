import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  assemblyStepPlan,
  cadContentHash,
  expandAssembly,
  r2bBom,
  type CadDocument,
  type CadEvaluation,
  type CadStepPlan,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { writeAssemblyStep } from './step-assembly';
import { importStepAssembly, renameEntities } from './step-assembly-import';
import { shapeMetrics } from './metrics';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

describe('PRODUCT names for the assembly reader (R2b-5)', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const rename = (s: string) =>
    new TextDecoder().decode(
      renameEntities(utf8(s), (type, n) =>
        n === 2 ? undefined : `'${type === 'PRODUCT' ? 'P' : 'N'}${n}'`,
      ),
    );
  it('replaces each simple PRODUCT name by token, comments and spacing included', () => {
    expect(rename("#1 /* product */ = PRODUCT('PN-1','Bolt','',());")).toBe(
      "#1 /* product */ = PRODUCT('PN-1','P1','',());",
    );
    expect(rename("#7=product (\n 'a''b' , 'It''s' ,'',(#8));")).toBe(
      "#7=product (\n 'a''b' , 'P7' ,'',(#8));",
    );
    // An entity it is not asked about, a string or a comment that only looks like one, and
    // other entities stay as they are.
    for (const kept of [
      "#2=PRODUCT('x','y','',());",
      "#3=NAME('#4=PRODUCT(''x'',''y''');",
      "/* #5=PRODUCT('x','y' */ #6=PRODUCT_CONTEXT('','x','');",
    ])
      expect(rename(kept)).toBe(kept);
  });
  it('replaces usage names too and keeps every other byte, raw UTF-8 included', () => {
    const file =
      "#1=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','日本語','',#2,#3,$);\n#9=PRODUCT('id','名前','',());";
    expect(rename(`/* 日本語 */ ${file}`).startsWith('/* 日本語 */ ')).toBe(true);
    expect(rename(file)).toBe(
      "#1=NEXT_ASSEMBLY_USAGE_OCCURRENCE('1','N1','',#2,#3,$);\n#9=PRODUCT('id','P9','',());",
    );
  });
});

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)(
  'R2b-5 STEP AP242 assembly import with the development build (CAD52)',
  () => {
    let buildHash = '';
    const posted: CadWorkerResponse[] = [];
    let handle: (m: CadWorkerRequest) => Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oc: any;
    let n = 0;
    const brep = async (document: CadDocument) => {
      const requestId = `brep-${n++}`;
      const hash = cadContentHash(document);
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: hash,
        candidateHash: hash,
        document,
        brep: true,
      });
      const m = posted.find((x) => x.type === 'result' && x.requestId === requestId);
      if (m?.type !== 'result' || !m.brep) throw new Error(JSON.stringify(m?.type));
      return {
        evaluation: m.evaluation as Extract<CadEvaluation, { status: 'ok' }>,
        bytes: m.brep.bytes,
      };
    };
    /** F22 and every shaped version's BRep and volume. */
    let f22: {
      plan: CadStepPlan;
      breps: Map<string, Uint8Array>;
      volumes: Map<string, number>;
      file: Uint8Array;
      fixture: ReturnType<typeof r2bBom>;
    };
    beforeAll(async () => {
      const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
      const sha = createHash('sha256').update(wasm).digest('hex');
      if (sha !== cadKernelBuild.wasmSha256)
        throw new Error(`kernel Wasm ${sha} is not the pinned build`);
      buildHash = `sha256:${sha}`;
      globalThis.require ??= createRequire(import.meta.url);
      handle = createKernelHost({
        load: async () => {
          const { default: factory } = await import(
            pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
          );
          return (oc = await factory({ wasmBinary: wasm }));
        },
        post: (m) => void posted.push(m),
        yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
      });
      await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
      const fixture = r2bBom({ id: 'occt', buildHash });
      const lookup = (h: string) => fixture.closure.get(h);
      const rootHash = cadContentHash(fixture.assembly);
      const planned = assemblyStepPlan(fixture.assembly, rootHash, lookup, 'Cart');
      if (planned.status !== 'ok') throw new Error(planned.code);
      const breps = new Map<string, Uint8Array>();
      const volumes = new Map<string, number>();
      for (const p of planned.plan.products) {
        if (!p.shape || breps.has(p.shape.contentHash)) continue;
        const doc =
          p.shape.contentHash === rootHash ? fixture.assembly : lookup(p.shape.contentHash)!;
        const { evaluation, bytes } = await brep(doc);
        breps.set(p.shape.contentHash, bytes);
        volumes.set(
          p.shape.contentHash,
          Object.values(evaluation.bodies).reduce(
            (v, b) => v + (b.kind === 'solid' ? b.volumeMm3 : 0),
            0,
          ),
        );
      }
      f22 = {
        plan: planned.plan,
        breps,
        volumes,
        file: writeAssemblyStep(oc, planned.plan, breps),
        fixture,
      };
    }, 300_000);

    it('reads F22 back as its distinct shapes and every instance flattened in place', () => {
      const result = importStepAssembly(oc, f22.file, buildHash);
      if (result.status !== 'ok') throw new Error(`${result.code} ${result.detail}`);
      const { read, report, breps } = result;
      expect(report.source.schema).toBe('AP242');
      expect(report.sourceUnit).toBe('mm');
      // The root's own plate, the two plates (the hub is the first) and the bolt.
      expect(read.shapes.map((s) => [s.name, s.product.id])).toEqual([
        ['Cart bodies', 'CART-1-bodies'],
        ['Plate', 'PL-100'],
        ['Plate', 'PL-100'],
        ['Bolt "M8", long', '=B-M8'],
      ]);
      expect(read.shapes.every((s) => s.kind === 'solid')).toBe(true);
      expect(breps).toHaveLength(read.shapes.length);
      // 1 + 2 + 4 × (hub + 2 bolts) + 2 + jig + 8 + 6, the wheels flattened into the root.
      expect(read.instances).toHaveLength(1 + 2 + 4 * 3 + 2 + 1 + 8 + 6);
      expect(report.depth).toBe(2);
      expect(report.losses).toContain('nesting');
      expect(read.skipped).toEqual([]);
      // The nested path stays in the name.
      expect(read.instances.map((i) => i.path.join(' / '))).toContain(
        'Cart / c-wheel-2 / w-bolt-1',
      );

      // Every placed shape where F22 places its version, with that version's volume.
      const lookup = (h: string) => f22.fixture.closure.get(h);
      const expected = [
        {
          volume: f22.volumes.get(cadContentHash(f22.fixture.assembly))!,
          at: [0, 0, 0],
          q: [0, 0, 0, 1],
        },
        ...expandAssembly(f22.fixture.assembly, lookup).occurrences.flatMap((o) => {
          const v = f22.volumes.get(o.part.source.contentHash);
          return v === undefined
            ? []
            : [{ volume: v, at: o.pose.translationMm, q: o.pose.rotation }];
        }),
      ];
      // Each shape's BRep measures as the version it came from.
      const volumes = breps.map((bytes) => {
        const own: { delete(): void }[] = [];
        const o = <T extends { delete(): void }>(x: T) => (own.push(x), x);
        try {
          oc.FS.writeFile('/m.brep', bytes);
          const shape = o(new oc.TopoDS_Shape());
          oc.BRepTools.Read_2(
            shape,
            '/m.brep',
            o(new oc.BRep_Builder()),
            o(new oc.Message_ProgressRange_1()),
          );
          oc.FS.unlink('/m.brep');
          return shapeMetrics(oc, shape, o as never, true).volumeMm3!;
        } finally {
          for (const x of own.reverse()) x.delete();
        }
      });
      // A quaternion and its negation are one rotation.
      const key = (x: { volume: number; at: readonly number[]; q: readonly number[] }) => {
        const sign = Math.sign(x.q.find((v) => Math.abs(v) > 1e-9) ?? 1);
        return [
          x.volume.toPrecision(9),
          ...x.at.map((v) => v.toFixed(6)),
          ...x.q.map((v) => (sign * v + 0).toFixed(6)),
        ].join(',');
      };
      const got = read.instances.map((i) => ({
        volume: volumes[i.shape]!,
        at: i.pose.translationMm,
        q: i.pose.rotation,
      }));
      expect(got.map(key).sort()).toEqual(expected.map(key).sort());
    }, 300_000);

    /** A file of `plan` with the bolt's BRep as product `bolt` (and others as given). */
    const boltPlan = (
      root: CadStepPlan['products'][number]['instances'],
      extra: CadStepPlan['products'] = [],
    ) => {
      const bolt = f22.fixture.bolt.contentHash;
      const plan: CadStepPlan = {
        products: [
          {
            key: 'bolt',
            name: 'Bolt',
            id: 'B-1',
            shape: { contentHash: bolt, bodies: [{ kind: 'solid', color: '#888888' }] },
            instances: [],
          },
          ...extra,
          { key: 'root', name: 'Rig', id: 'R-1', instances: root },
        ],
        root: 'root',
        instances: root.length,
      };
      return writeAssemblyStep(oc, plan, f22.breps);
    };
    const at = (x: number) => ({
      translationMm: [x, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
    });

    it('takes 1,024 instances and refuses 1,025 before anything is written', () => {
      const row = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          product: 'bolt',
          name: `b${i}`,
          pose: at(i * 50),
        }));
      const ok = importStepAssembly(oc, boltPlan(row(1024)), buildHash);
      expect(ok.status === 'ok' && ok.read.instances.length).toBe(1024);
      expect(ok.status === 'ok' && ok.read.shapes.length).toBe(1);
      expect(importStepAssembly(oc, boltPlan(row(1025)), buildHash)).toEqual({
        status: 'rejected',
        code: 'step-instance-limit',
        detail: '1024',
      });
    }, 300_000);

    it('keeps each product its own id when two products share a name', () => {
      const plate = f22.fixture.plate1.contentHash;
      const file = boltPlan(
        [
          { product: 'bolt', name: 'ボルト 1', pose: at(0) },
          { product: 'other', name: 'o', pose: at(100) },
        ],
        [
          {
            key: 'other',
            name: 'Bolt',
            id: 'B-2',
            shape: { contentHash: plate, bodies: [{ kind: 'solid', color: '#888888' }] },
            instances: [],
          },
        ],
      );
      const result = importStepAssembly(oc, file, buildHash);
      if (result.status !== 'ok') throw new Error(`${result.code} ${result.detail}`);
      const idAt = (x: number) =>
        result.read.shapes[result.read.instances.find((i) => i.pose.translationMm[0] === x)!.shape]!
          .product;
      expect(idAt(0)).toMatchObject({ id: 'B-1', name: 'Bolt' });
      expect(idAt(100)).toMatchObject({ id: 'B-2', name: 'Bolt' });
      expect(result.read.shapes.map((s) => s.name)).toEqual(['Bolt', 'Bolt']);
      // A name outside ASCII reads back as written.
      expect(result.read.instances.find((i) => i.pose.translationMm[0] === 0)!.path).toEqual([
        'Rig',
        'ボルト 1',
      ]);
    }, 300_000);

    it('reads a tree nested 8 deep and refuses 9', () => {
      // Sub-assemblies s1..sn, each placing the next; the root places s1, sn places the bolt.
      const nested = (levels: number) => {
        const subs = Array.from({ length: levels - 1 }, (_, i) => ({
          key: `s${i + 1}`,
          name: `Sub ${i + 1}`,
          id: `S-${i + 1}`,
          instances: [
            { product: i === levels - 2 ? 'bolt' : `s${i + 2}`, name: 'next', pose: at(10) },
          ],
        }));
        // Written children first, as a plan orders them.
        return boltPlan([{ product: 's1', name: 'top', pose: at(0) }], subs.reverse());
      };
      const deep = importStepAssembly(oc, nested(8), buildHash);
      if (deep.status !== 'ok') throw new Error(`${deep.code} ${deep.detail}`);
      expect(deep.report.depth).toBe(8);
      expect(deep.report.losses).toContain('nesting');
      expect(deep.read.instances).toHaveLength(1);
      expect(deep.read.instances[0]!.path).toHaveLength(9);
      expect(deep.read.instances[0]!.pose.translationMm[0]).toBeCloseTo(70, 9);
      expect(importStepAssembly(oc, nested(9), buildHash)).toEqual({
        status: 'rejected',
        code: 'step-depth-limit',
        detail: '8',
      });
    }, 300_000);

    it('splits a product of several solids, skips one without a shape and refuses external files', () => {
      // A product holding the plate and the bolt as one compound: two solids.
      const own: { delete(): void }[] = [];
      const o = <T extends { delete(): void }>(x: T) => (own.push(x), x);
      let two: Uint8Array;
      try {
        const builder = o(new oc.BRep_Builder());
        const compound = o(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        for (const hash of [f22.fixture.plate1.contentHash, f22.fixture.bolt.contentHash]) {
          oc.FS.writeFile('/p.brep', f22.breps.get(hash)!);
          const shape = o(new oc.TopoDS_Shape());
          oc.BRepTools.Read_2(shape, '/p.brep', builder, o(new oc.Message_ProgressRange_1()));
          builder.Add(compound, shape);
        }
        oc.BRepTools.Write_3(compound, '/p.brep', o(new oc.Message_ProgressRange_1()));
        two = oc.FS.readFile('/p.brep') as Uint8Array;
        oc.FS.unlink('/p.brep');
      } finally {
        for (const x of own.reverse()) x.delete();
      }
      const plan: CadStepPlan = {
        products: [
          {
            key: 'pair',
            name: 'Pair',
            id: 'P-2',
            shape: {
              contentHash: 'pair',
              bodies: [
                { kind: 'solid', color: '#888888' },
                { kind: 'solid', color: '#888888' },
              ],
            },
            instances: [],
          },
          { key: 'empty', name: 'Empty', id: 'E-0', instances: [] },
          {
            key: 'root',
            name: 'Rig',
            id: 'R-1',
            instances: [
              { product: 'pair', name: 'pair-1', pose: at(0) },
              { product: 'empty', name: 'empty-1', pose: at(100) },
              { product: 'pair', name: 'pair-2', pose: at(200) },
            ],
          },
        ],
        root: 'root',
        instances: 3,
      };
      const file = writeAssemblyStep(oc, plan, new Map([['pair', two]]));
      const result = importStepAssembly(oc, file, buildHash);
      if (result.status !== 'ok') throw new Error(`${result.code} ${result.detail}`);
      // One part per solid, in file order, each placed by both instances.
      expect(result.read.shapes.map((s) => [s.name, s.product.id])).toEqual([
        ['Pair (1)', 'P-2'],
        ['Pair (2)', 'P-2'],
      ]);
      expect(result.report.split).toEqual([{ name: 'Pair', count: 2 }]);
      expect(result.read.skipped).toEqual(['Empty']);
      expect(result.read.instances.map((i) => [i.shape, i.pose.translationMm[0]])).toEqual([
        [0, 0],
        [1, 0],
        [0, 200],
        [1, 200],
      ]);
      expect(result.report.depth).toBe(1);

      // A file that points to another file is refused, never read in part.
      const text = new TextDecoder('latin1').decode(file);
      const external = text.replace(
        'ENDSEC;\nEND-ISO',
        "#999999 = DOCUMENT_FILE('other.step','',$,#1,'','');\nENDSEC;\nEND-ISO",
      );
      expect(external).not.toBe(text);
      const refused = importStepAssembly(oc, new TextEncoder().encode(external), buildHash);
      expect(refused).toMatchObject({ status: 'rejected', code: 'step-external-reference' });
    }, 300_000);

    it('keeps the PMI of a part on that part and refuses a dimension across two parts unless agreed (PMI-2, CAD81)', () => {
      const file = new Uint8Array(
        readFileSync(new URL('../fixtures/f43/pmi-assembly.step', import.meta.url)),
      );
      // The distance from the plate's top to the block's top is on two parts: not kept.
      const refused = importStepAssembly(oc, file, buildHash);
      if (refused.status !== 'rejected' || !refused.pmi) throw new Error(JSON.stringify(refused));
      expect(refused).toMatchObject({ code: 'step-pmi-partial', detail: 'not-kept' });
      const result = importStepAssembly(oc, file, buildHash, { pmi: 'discard' });
      if (result.status !== 'ok') throw new Error(`${result.code} ${result.detail}`);
      expect(result.report.losses).toContain('pmi');
      expect(result.report.pmi).toMatchObject({
        lossless: false,
        kept: {
          dimension: 2,
          'geometric-tolerance': 1,
          datum: 2,
          'datum-target': 0,
          callout: 0,
          view: 0,
        },
      });
      const plate = result.read.shapes.findIndex((s) => s.pmi);
      expect(result.read.shapes.filter((s) => s.pmi)).toHaveLength(1);
      // The plate is one part placed twice; its asset is shared by both instances.
      expect(result.read.instances.filter((i) => i.shape === plate)).toHaveLength(2);
      const bytes = result.pmis?.[plate];
      if (!bytes) throw new Error('no pmi bytes');
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
        result.read.shapes[plate].pmi!.sha256,
      );
      const asset = JSON.parse(new TextDecoder().decode(bytes)) as {
        items: { kind: string; type?: string; references?: { datums: string[] }[] }[];
      };
      expect(asset.items.map((i) => i.kind)).toEqual([
        'datum',
        'datum',
        'dimension',
        'dimension',
        'geometric-tolerance',
      ]);
      expect(asset.items[4]).toMatchObject({
        type: 'Position',
        references: [{ datums: ['pmi-1'] }, { datums: ['pmi-2'] }],
      });
    }, 300_000);

    it('keeps the PMI through assembly paths on the instances they name (PMI-5a, CAD86, TS-1437)', () => {
      const file = new Uint8Array(
        readFileSync(new URL('../fixtures/f43/pmi-path.step', import.meta.url)),
      );
      const expected = JSON.parse(
        readFileSync(new URL('../fixtures/f43/path.json', import.meta.url), 'utf8'),
      ) as {
        items: {
          kind: string;
          type: string;
          value?: number;
          values?: number[];
          targets: { instance: number; part: string; centroid: number[] }[];
          targets2?: { instance: number; part: string; centroid: number[] }[];
        }[];
        datums: { kind: 'datum'; name: string; targets: unknown[] }[];
      };
      // F43's distance across two parts is still not kept (no path): refused unless agreed.
      const refused = importStepAssembly(oc, file, buildHash);
      expect(refused).toMatchObject({ status: 'rejected', code: 'step-pmi-partial' });
      const result = importStepAssembly(oc, file, buildHash, { pmi: 'discard' });
      if (result.status !== 'ok') throw new Error(`${result.code} ${result.detail}`);
      const report = result.report.pmi!;
      // The paths' four tolerances, one distance and the block's datum, on top of F43's part PMI
      // (the plate's datum A copied for the parallelism is not counted again).
      expect(report.kept).toMatchObject({ dimension: 3, 'geometric-tolerance': 5, datum: 3 });
      expect(report.pathProblems).toBeUndefined();
      const rows = (axis: string) =>
        report.axes.filter((a) => a.axis === axis).map((a) => [a.family, a.inFile, a.read]);
      expect(rows('path')).toEqual([
        ['component-path', 2, 2],
        ['dimension', 1, 1],
        ['geometric-tolerance', 4, 4],
        ['datum', 1, 1],
      ]);
      // Every item is read (the across-parts distance by the kernel's reader, not kept).
      expect(rows('semantic')).toEqual(
        expect.arrayContaining([
          ['dimension', 4, 4],
          ['geometric-tolerance', 5, 5],
          ['datum', 3, 3],
          ['datum-system', 2, 2],
        ]),
      );
      expect(report.complete).toBe(true);
      expect(report.lossless).toBe(false);
      const asset = result.read.assemblyPmi!;
      expect(asset.items.map((i) => i.kind)).toEqual([
        'datum',
        'geometric-tolerance',
        'geometric-tolerance',
        'dimension',
        'geometric-tolerance',
        'datum',
        'geometric-tolerance',
      ]);
      // The parallelism references the plate's own A on its instance, never the block's A.
      const [blockA, , , , , plateA, parallelism] = asset.items;
      expect(parallelism).toMatchObject({ references: [{ datums: [plateA!.id] }] });
      expect(plateA!.id).not.toBe(blockA!.id);
      const partAsset = JSON.parse(
        new TextDecoder().decode(result.pmis![result.read.instances[1]!.shape]!),
      ) as { items: { kind: string; name?: string; targets: object[] }[] };
      const partA = partAsset.items.find((i) => i.kind === 'datum' && i.name === 'A')!;
      expect(plateA).toMatchObject({
        name: 'A',
        targets: partA.targets.map((t) => ({ ...t, component: '1' })),
      });
      // Instances in the file's order: the plates (1, 2), then the block (3).
      expect(result.read.instances.map((i) => i.path.join(' / '))).toHaveLength(3);
      const plate = result.read.instances[0]!.shape;
      expect(result.read.instances[1]!.shape).toBe(plate);
      const block = result.read.instances[2]!.shape;
      // Each face's centroid in its part, from the part's BRep.
      const owned: { delete(): void }[] = [];
      const own = <T>(x: T) => (owned.push(x as never), x);
      const centroid = (shape: number, index: number) => {
        oc.FS.writeFile('/f46.brep', result.breps[shape]!);
        const body = own(new oc.TopoDS_Shape());
        oc.BRepTools.Read_2(
          body,
          '/f46.brep',
          own(new oc.BRep_Builder()),
          own(new oc.Message_ProgressRange_1()),
        );
        oc.FS.unlink('/f46.brep');
        const map = own(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(body, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
        const props = own(new oc.GProp_GProps_1());
        oc.BRepGProp.SurfaceProperties_1(map.FindKey(index), props, false, false);
        const c = own(props.CentreOfMass());
        return [c.X(), c.Y(), c.Z()].map((v) => Math.round(v * 1e6) / 1e6 + 0);
      };
      try {
        const where = (t: { shape: string; index: number; component?: string }) => {
          expect(t.shape).toBe('face');
          const instance = Number(t.component);
          const shape = result.read.instances[instance]!.shape;
          return {
            instance: instance + 1,
            part: shape === block ? 'block' : shape === plate ? 'plate' : '?',
            centroid: centroid(shape, t.index),
          };
        };
        expect(
          asset.items
            .filter((i) => i.kind !== 'datum')
            .map((i) => ({
              kind: i.kind,
              type: 'type' in i ? i.type : undefined,
              ...(i.kind === 'geometric-tolerance' ? { value: i.value } : {}),
              ...(i.kind === 'dimension' ? { values: i.values } : {}),
              targets: i.targets.map(where),
              ...(i.kind === 'dimension' && i.targets2 ? { targets2: i.targets2.map(where) } : {}),
            })),
        ).toEqual(expected.items);
        expect({ ...blockA!, id: undefined, targets: blockA!.targets.map(where) }).toEqual({
          ...expected.datums[0],
          id: undefined,
        });
      } finally {
        for (const x of owned.reverse()) x.delete();
      }
      // Never on the first plate: the item names the second instance only.
      expect(
        asset.items
          .flatMap((i) => [...i.targets, ...(i.kind === 'dimension' ? (i.targets2 ?? []) : [])])
          .some((t) => t.component === '0'),
      ).toBe(false);
      // F43's part PMI stays on the plate's part version, as before.
      expect(result.read.shapes.filter((x) => x.pmi)).toHaveLength(1);
      // The kernel's model numbers entities by rank, not by `#id`: the same file with other ids
      // (a name's `#1` changes too, harmlessly) keeps the same items on the same faces.
      const renumbered = new TextEncoder().encode(
        new TextDecoder('latin1')
          .decode(file)
          .replace(/#(\d+)/g, (_, n: string) => `#${Number(n) * 3 + 1000}`),
      );
      const again = importStepAssembly(oc, renumbered, buildHash, { pmi: 'discard' });
      if (again.status !== 'ok') throw new Error(`${again.code} ${again.detail}`);
      expect(again.read.assemblyPmi).toEqual(asset);
    }, 300_000);
  },
);
