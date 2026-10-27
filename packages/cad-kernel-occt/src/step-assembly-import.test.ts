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
  },
);
