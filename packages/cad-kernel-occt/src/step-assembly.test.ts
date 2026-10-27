import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  applyCadOperation,
  assemblyStepPlan,
  cadContentHash,
  cadLimits,
  emptyCad,
  expandAssembly,
  f05Dependencies,
  f17Sheets,
  fixtureComponent,
  identityQuaternion,
  mm,
  position,
  fixturePart,
  fixtureVersion,
  r2bBom,
  type CadDocument,
  type CadEvaluation,
  type CadStepPlan,
} from '@editor-platform/cad-core';
import { readP21, type P21Value } from '@editor-platform/geometry-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import { shapeMetrics } from './metrics';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { writeAssemblyStep } from './step-assembly';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)(
  'R2b-5 STEP AP242 assembly export with the development build (CAD52)',
  () => {
    let buildHash = '';
    const posted: CadWorkerResponse[] = [];
    let handle: (m: CadWorkerRequest) => Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oc: any;
    let n = 0;
    /** A version's evaluation and its active bodies as one BRep compound. */
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
    }, 300_000);

    it('writes F22 as nested AP242 products and instances that another reader reads back', async () => {
      const f = r2bBom({ id: 'occt', buildHash });
      const lookup = (h: string) => f.closure.get(h);
      const rootHash = cadContentHash(f.assembly);
      const planned = assemblyStepPlan(f.assembly, rootHash, lookup, 'Cart');
      if (planned.status !== 'ok') throw new Error(planned.code);
      const plan: CadStepPlan = planned.plan;
      const breps = new Map<string, Uint8Array>();
      /** Each shaped version's volume, area and bounds as the editor evaluated it. */
      const measures = new Map<string, { volume: number; area: number; bounds: number[][] }>();
      for (const p of plan.products) {
        if (!p.shape || breps.has(p.shape.contentHash)) continue;
        const doc = p.shape.contentHash === rootHash ? f.assembly : lookup(p.shape.contentHash)!;
        const { evaluation, bytes } = await brep(doc);
        breps.set(p.shape.contentHash, bytes);
        const bodies = Object.values(evaluation.bodies);
        measures.set(p.shape.contentHash, {
          volume: bodies.reduce((v, b) => v + (b.kind === 'solid' ? b.volumeMm3 : 0), 0),
          area: bodies.reduce((v, b) => v + b.areaMm2, 0),
          bounds: [0, 1].map((m) =>
            [0, 1, 2].map((k) => (m ? Math.max : Math.min)(...bodies.map((b) => b.bounds[m]![k]!))),
          ),
        });
      }
      /** A product's volume and area: its shape, or what it places. */
      const total = (key: string): { volume: number; area: number } => {
        const p = plan.products.find((x) => x.key === key)!;
        if (p.shape) return measures.get(p.shape.contentHash)!;
        return p.instances.reduce(
          (sum, i) => {
            const t = total(i.product);
            return { volume: sum.volume + t.volume, area: sum.area + t.area };
          },
          { volume: 0, area: 0 },
        );
      };
      // The statics exist once a writer is made.
      new oc.STEPCAFControl_Writer_1().delete();
      const schema = oc.OCJS.staticInteger('write.step.schema');
      const bytes = writeAssemblyStep(oc, plan, breps);
      // The single-body STEP keeps its AP214 default.
      expect(oc.OCJS.staticInteger('write.step.schema')).toBe(schema);

      // An independent reader (the repository's ISO 10303-21 parser): schema, products, usages.
      const file = readP21(bytes, {
        bytes: cadLimits.stepBytes,
        entities: cadLimits.stepBytes,
        depth: 64,
      });
      const schemaArgs = JSON.stringify(file.header.find((h) => h.type === 'FILE_SCHEMA')?.args);
      expect(schemaArgs).toMatch(/AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/i);
      const of = (type: string) => [...file.entities.values()].filter((e) => e.type === type);
      const str = (v: P21Value | undefined) => (v?.t === 'str' ? v.v : undefined);
      const products = of('PRODUCT').map((e) => [str(e.args[0]), str(e.args[1])]);
      expect(products).toHaveLength(plan.products.length);
      expect(products).toContainEqual(['CART-1', 'Cart']);
      expect(products).toContainEqual(['W-1', 'Wheel']);
      expect(products).toContainEqual(['=B-M8', 'Bolt "M8", long']);
      expect(of('NEXT_ASSEMBLY_USAGE_OCCURRENCE')).toHaveLength(plan.instances);
      // Root: its own plate, 2 plates, 4 wheels, 2 bolts, the jig, ring 8 and row 6.
      const root = plan.products.find((p) => p.key === 'root')!;
      expect(root.instances).toHaveLength(1 + 2 + 4 + 2 + 1 + 8 + 6);

      // Read back through XDE: one free assembly, its placements and the volume of every instance.
      const own: { delete(): void }[] = [];
      const o = <T extends { delete(): void }>(x: T) => (own.push(x), x);
      try {
        const path = '/r2b5.step';
        oc.FS.writeFile(path, bytes);
        const reader = o(new oc.STEPCAFControl_Reader_1());
        reader.SetNameMode(true);
        expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
        oc.FS.unlink(path);
        const text = (s: string) => o(new oc.TCollection_ExtendedString_2(s, false));
        const doc = o(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
        expect(reader.Transfer_1(doc, o(new oc.Message_ProgressRange_1()))).toBe(true);
        const tool = o(oc.XCAFDoc_DocumentTool.ShapeTool(doc.get().Main())).get();
        const free = o(new oc.TDF_LabelSequence_1());
        tool.GetFreeShapes(free);
        expect(free.Length()).toBe(1);
        const top = free.Value(1);
        expect(o(oc.OCJS.labelName(top)).ToCString()).toBe('Cart');
        const components = o(new oc.TDF_LabelSequence_1());
        oc.XCAFDoc_ShapeTool.GetComponents(top, components, false);
        expect(components.Length()).toBe(root.instances.length);
        const close = (a: number, b: number, relative: number) =>
          Math.abs(a - b) <= relative * Math.max(1, Math.abs(b));
        // Each component's placement is its instance's pose (relative 1e-9; a quaternion and its
        // negation agree), and the product it places measures as the version evaluated.
        for (let i = 1; i <= components.Length(); i++) {
          const component = components.Value(i);
          const trsf = o(o(oc.XCAFDoc_ShapeTool.GetLocation(component)).Transformation());
          // gp_XYZ is not bound: the translation is the matrix's last column.
          const t = [1, 2, 3].map((r) => trsf.Value(r, 4) as number);
          const q = o(trsf.GetRotation_2());
          const instance = root.instances[i - 1]!;
          const want = instance.pose;
          expect(t.every((v, k) => close(v, want.translationMm[k]!, 1e-9))).toBe(true);
          const dot =
            q.X() * want.rotation[0] +
            q.Y() * want.rotation[1] +
            q.Z() * want.rotation[2] +
            q.W() * want.rotation[3];
          expect(Math.abs(Math.abs(dot) - 1)).toBeLessThan(1e-9);
          const referred = o(new oc.TDF_Label());
          expect(oc.XCAFDoc_ShapeTool.GetReferredShape(component, referred)).toBe(true);
          const shape = o(oc.XCAFDoc_ShapeTool.GetShape_2(referred));
          const got = shapeMetrics(oc, shape, o as never, true);
          const expected = total(instance.product);
          expect(close(got.volumeMm3!, expected.volume, 1e-6)).toBe(true);
          expect(close(got.areaMm2, expected.area, 1e-6)).toBe(true);
          const product = plan.products.find((p) => p.key === instance.product)!;
          if (product.shape) {
            // The product's own frame: its bounds are the version's.
            const box = o(new oc.Bnd_Box_1());
            oc.BRepBndLib.AddOptimal(shape, box, false, false);
            const corners = [o(box.CornerMin()), o(box.CornerMax())].map((c) => [
              c.X(),
              c.Y(),
              c.Z(),
            ]);
            const { bounds } = measures.get(product.shape.contentHash)!;
            expect(corners.flat().every((v, k) => Math.abs(v - bounds.flat()[k]!) < 1e-6)).toBe(
              true,
            );
          }
        }
        // The whole assembly measures as every placed body: own, nested and copied.
        const whole = oc.XCAFDoc_ShapeTool.GetShape_2(top);
        o(whole);
        const measured = shapeMetrics(oc, whole, o as never, true).volumeMm3!;
        const expected =
          measures.get(rootHash)!.volume +
          expandAssembly(f.assembly, lookup).occurrences.reduce(
            (v, occ) => v + (measures.get(occ.part.source.contentHash)?.volume ?? 0),
            0,
          );
        expect(Math.abs(measured - expected) / expected).toBeLessThan(1e-6);
      } finally {
        for (const x of own.reverse()) x.delete();
      }
    }, 300_000);

    it('writes every name as given, even one that looks like a placeholder or is not ASCII', async () => {
      const kernel = { id: 'occt', buildHash };
      const sheet = fixtureVersion('sheet', 'v1', {
        ...f17Sheets('extrude'),
        kernelProfile: { ...emptyCad(kernel).kernelProfile },
      });
      const doc = applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: [fixturePart('p-sheet', 'Sheet', sheet)],
        components: [
          fixtureComponent('s-1', 'p-sheet'),
          fixtureComponent('s-2', 'p-sheet', [0, 0, 50]),
        ],
      });
      const planned = assemblyStepPlan(
        doc,
        cadContentHash(doc),
        (h) => (h === sheet.contentHash ? sheet.content : undefined),
        'Rig',
      );
      if (planned.status !== 'ok') throw new Error(planned.code);
      const [part, root] = planned.plan.products;
      // Names like the writer's placeholders, and Japanese ones, for products and instances.
      const plan: CadStepPlan = {
        ...planned.plan,
        products: [
          { ...part!, id: 'R2B5P1', name: 'R2B5I0' },
          {
            ...root!,
            id: 'R2B5P0',
            name: 'ボルト台',
            instances: root!.instances.map((i, k) => ({
              ...i,
              name: k ? 'R2B5P0' : 'ボルト 1',
            })),
          },
        ],
      };
      const { bytes: brepBytes } = await brep(sheet.content);
      const bytes = writeAssemblyStep(oc, plan, new Map([[sheet.contentHash, brepBytes]]));
      const file = readP21(bytes, {
        bytes: cadLimits.stepBytes,
        entities: cadLimits.stepBytes,
        depth: 64,
      });
      const of = (type: string) => [...file.entities.values()].filter((e) => e.type === type);
      const str = (v: P21Value | undefined) => (v?.t === 'str' ? v.v : undefined);
      expect(of('PRODUCT').map((e) => [str(e.args[0]), str(e.args[1])])).toEqual([
        ['R2B5P0', 'ボルト台'],
        ['R2B5P1', 'R2B5I0'],
      ]);
      expect(
        of('NEXT_ASSEMBLY_USAGE_OCCURRENCE')
          .map((e) => str(e.args[1]))
          .sort(),
      ).toEqual(['R2B5P0', 'ボルト 1'].sort());
    });

    it('colours each solid of a body of several solids by its own body (K1, CM-5)', async () => {
      const kernel = { id: 'occt', buildHash };
      // Body `a`: two posts apart (two solids), red; then a blue ball apart from both.
      let content = applyCadOperation(
        { ...f05Dependencies(0), kernelProfile: emptyCad(kernel).kernelProfile },
        {
          type: 'booleanBodies',
          targetId: 'a',
          toolId: 'b',
          mode: 'union',
          booleanFeatureId: 'u',
          placementFeatureId: 'u-placement',
        },
      );
      content = applyCadOperation(content, {
        type: 'insertFeatures',
        parameters: [],
        profiles: [],
        features: [
          {
            id: 'ball-sphere',
            name: 'Ball',
            type: 'sphere',
            inputFeatureIds: [],
            args: { radius: mm(5), origin: position(0, 200, 0), orientation: identityQuaternion() },
          },
        ],
        bodies: [
          {
            id: 'ball',
            name: 'Ball',
            sourceFeatureId: 'ball-sphere',
            placementFeatureId: 'ball-placement',
            appearance: { color: '#0000ff', opacity: 1 },
          },
        ],
      });
      content.bodies.find((b) => b.id === 'a')!.appearance.color = '#ff0000';
      const part = fixtureVersion('posts', 'v1', content);
      const doc = applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: [fixturePart('p-posts', 'Posts', part)],
        components: [fixtureComponent('c-1', 'p-posts')],
      });
      const planned = assemblyStepPlan(
        doc,
        cadContentHash(doc),
        (h) => (h === part.contentHash ? part.content : undefined),
        'Posts',
      );
      if (planned.status !== 'ok') throw new Error(planned.code);
      const { evaluation, bytes: brepBytes } = await brep(part.content);
      expect(evaluation.bodies.a).toMatchObject({ solids: 2 });
      const bytes = writeAssemblyStep(oc, planned.plan, new Map([[part.contentHash, brepBytes]]));
      const { entities } = readP21(bytes, {
        bytes: cadLimits.stepBytes,
        entities: cadLimits.stepBytes,
        depth: 64,
      });
      // Every one of the three solids carries a style (STYLED_ITEM's item is its third argument).
      const styled = [...entities.values()].filter((e) => {
        const item = e.args[2];
        return (
          e.type === 'STYLED_ITEM' &&
          item?.t === 'ref' &&
          entities.get(item.id)?.type === 'MANIFOLD_SOLID_BREP'
        );
      });
      expect(styled).toHaveLength(3);
    });

    it('writes a sheet part as a shell-based surface model that reads back placed', async () => {
      const kernel = { id: 'occt', buildHash };
      const sheet = fixtureVersion('sheet', 'v1', {
        ...f17Sheets('extrude'),
        kernelProfile: { ...emptyCad(kernel).kernelProfile },
      });
      const doc = applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: [fixturePart('p-sheet', 'Sheet', sheet)],
        components: [
          fixtureComponent('s-1', 'p-sheet'),
          fixtureComponent('s-2', 'p-sheet', [0, 0, 50]),
        ],
      });
      const planned = assemblyStepPlan(
        doc,
        cadContentHash(doc),
        (h) => (h === sheet.contentHash ? sheet.content : undefined),
        'Sheets',
      );
      if (planned.status !== 'ok') throw new Error(planned.code);
      const { evaluation, bytes: brepBytes } = await brep(sheet.content);
      const area = Object.values(evaluation.bodies).reduce((v, b) => v + b.areaMm2, 0);
      const bytes = writeAssemblyStep(oc, planned.plan, new Map([[sheet.contentHash, brepBytes]]));
      const text = new TextDecoder('latin1').decode(bytes);
      expect(text).toContain('SHELL_BASED_SURFACE_MODEL');
      expect(text).not.toContain('MANIFOLD_SOLID_BREP');
      const own: { delete(): void }[] = [];
      const o = <T extends { delete(): void }>(x: T) => (own.push(x), x);
      try {
        const path = '/r2b5-sheet.step';
        oc.FS.writeFile(path, bytes);
        const reader = o(new oc.STEPCAFControl_Reader_1());
        expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
        oc.FS.unlink(path);
        const name = o(new oc.TCollection_ExtendedString_2('MDTV-XCAF', false));
        const read = o(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(name)));
        expect(reader.Transfer_1(read, o(new oc.Message_ProgressRange_1()))).toBe(true);
        const tool = o(oc.XCAFDoc_DocumentTool.ShapeTool(read.get().Main())).get();
        const free = o(new oc.TDF_LabelSequence_1());
        tool.GetFreeShapes(free);
        const components = o(new oc.TDF_LabelSequence_1());
        oc.XCAFDoc_ShapeTool.GetComponents(free.Value(1), components, false);
        expect(components.Length()).toBe(2);
        const whole = o(oc.XCAFDoc_ShapeTool.GetShape_2(free.Value(1)));
        const got = shapeMetrics(oc, whole, o as never, false).areaMm2;
        expect(Math.abs(got - 2 * area) / (2 * area)).toBeLessThan(1e-6);
      } finally {
        for (const x of own.reverse()) x.delete();
      }
    }, 300_000);
  },
);
