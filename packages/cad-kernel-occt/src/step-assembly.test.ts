import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  cadAssemblyPmiStates,
  cadAssetMediaTypes,
  readCadAssemblyPmiAsset,
  stepImportPlan,
  type CadAssetRef,
  type CadDocument,
  type CadPmiAsset,
  type CadPmiTarget,
  type CadEvaluation,
  type CadStepPlan,
} from '@editor-platform/cad-core';
import { readP21, type P21Value } from '@editor-platform/geometry-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import { shapeMetrics } from './metrics';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { writeAssemblyStep, writeAssemblyStepPmi } from './step-assembly';
import { importStepAssembly } from './step-assembly-import';
import { assemblyStepReport } from './formats';
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
    const brep = async (document: CadDocument, assets?: Record<string, Uint8Array>) => {
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
        ...(assets ? { assets } : {}),
      });
      const m = posted.find((x) => x.type === 'result' && x.requestId === requestId);
      if (m?.type !== 'result' || !m.brep) throw new Error(JSON.stringify(m?.type));
      return {
        evaluation: m.evaluation as Extract<CadEvaluation, { status: 'ok' }>,
        bytes: m.brep.bytes,
        pmi: m.brep.pmi,
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
    it("writes the parts' and the assembly's PMI into AP242, which reads back the same (PMI-5c, CAD86, TS-1444)", async () => {
      const file = new Uint8Array(
        readFileSync(new URL('../fixtures/f43/pmi-path.step', import.meta.url)),
      );
      const imported = importStepAssembly(oc, file, buildHash, { pmi: 'discard' });
      if (imported.status !== 'ok') throw new Error(`${imported.code} ${imported.detail}`);
      const { read, report } = imported;
      const sha = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
      const ref = (kind: CadAssetRef['kind'], bytes: Uint8Array): CadAssetRef => ({
        id: kind === 'source-step' ? 'source' : kind === 'pmi' ? 'pmi' : 'brep',
        kind,
        sha256: sha(bytes),
        byteLength: bytes.byteLength,
        mediaType: cadAssetMediaTypes[kind],
      });
      const assets: Record<string, Uint8Array> = { [sha(file)]: file };
      for (const b of [...imported.breps, ...(imported.pmis ?? [])]) if (b) assets[sha(b)] = b;
      const kernel = { id: 'occt', buildHash };
      let id = 0;
      const planned = stepImportPlan(
        kernel,
        read,
        {
          source: ref('source-step', file),
          breps: imported.breps.map((b) => ref('normalized-brep', b)),
          pmis: (imported.pmis ?? []).map((b) => b && ref('pmi', b)),
        },
        { sourceUnit: report.sourceUnit, scaleToMm: report.scaleToMm },
        (prefix) => `${prefix}-${id++}`,
      );
      if (planned.status !== 'ok') throw new Error(planned.code);
      assets[planned.assemblyPmi!.ref.sha256] = planned.assemblyPmi!.bytes;
      const root = applyCadOperation(emptyCad(kernel), {
        type: 'insertComponents',
        parts: planned.parts,
        components: planned.components,
        assemblyPmi: planned.assemblyPmi!.ref,
      });
      const versions = new Map(planned.versions.map((v) => [cadContentHash(v), v]));
      const rootHash = cadContentHash(root);
      const plan = assemblyStepPlan(root, rootHash, (h) => versions.get(h), 'F43');
      if (plan.status !== 'ok') throw new Error(plan.code);
      const breps = new Map<string, Uint8Array>();
      const products: Record<string, NonNullable<Awaited<ReturnType<typeof brep>>['pmi']>> = {};
      for (const p of plan.plan.products) {
        const hash = p.shape?.contentHash;
        if (!hash || breps.has(hash)) continue;
        const r = await brep(versions.get(hash)!, assets);
        breps.set(hash, r.bytes);
        if (r.pmi) products[hash] = r.pmi;
      }
      const asset = readCadAssemblyPmiAsset(planned.assemblyPmi!.bytes)!;
      const partHash = new Map(root.parts.map((p) => [p.id, p.source.contentHash]));
      const written = writeAssemblyStepPmi(oc, plan.plan, breps, {
        products,
        assembly: {
          asset,
          states: [...cadAssemblyPmiStates(root, asset)],
          components: Object.fromEntries(
            root.components.map((c) => [c.id, partHash.get(c.partId)!]),
          ),
        },
      });
      // F43 with paths: the plate's part PMI is written on its product. Of the assembly's own
      // items, the block's two flatnesses are written on the block (placed once); the plate's
      // three are not (the plate is placed twice), nor the distance across the parts, nor the
      // block's datum A (the plate's A already holds the name in the file).
      expect(written.pmi).toEqual({
        written: { dimension: 2, 'geometric-tolerance': 1, datum: 2, 'datum-target': 0 },
        stale: 0,
        unwritable: 0,
        presented: 0,
        presentationLost: 0,
        views: 0,
        unsupportedBuild: 0,
        assembly: { written: 2, shared: 3, across: 1, stale: 0, unwritable: 1 },
        presentationOneFrame: 0,
      });
      // The files the independent reader checks (scripts/cad-kernel/pmi-readback.py).
      const dir = process.env.CAD_PMI_STEP_DIR ?? '/tmp/cad-pmi-step';
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/pmi-5c-assembly.step`, written.step);

      // Read back with this kernel as a new import: complete, and every item by its meaning.
      const back = importStepAssembly(oc, written.step, buildHash, { pmi: 'discard' });
      if (back.status !== 'ok') throw new Error(`${back.code} ${back.detail}`);
      expect(back.report.pmi).toMatchObject({ complete: true, lossless: true });
      expect(back.read.assemblyPmi).toBeUndefined();
      const owned: { delete(): void }[] = [];
      const own = <T>(x: T) => (owned.push(x as never), x);
      /** The centroid of face `index` of a BRep (mm, 4 decimals). */
      const centroid = (bytes: Uint8Array, index: number) => {
        oc.FS.writeFile('/pmi-5c.brep', bytes);
        const body = own(new oc.TopoDS_Shape());
        oc.BRepTools.Read_2(
          body,
          '/pmi-5c.brep',
          own(new oc.BRep_Builder()),
          own(new oc.Message_ProgressRange_1()),
        );
        oc.FS.unlink('/pmi-5c.brep');
        const map = own(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(body, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
        const props = own(new oc.GProp_GProps_1());
        oc.BRepGProp.SurfaceProperties_1(map.FindKey(index), props, false, false);
        const c = own(props.CentreOfMass());
        return [c.X(), c.Y(), c.Z()].map((v) => Math.round(v * 1e4) / 1e4 + 0).join(',');
      };
      type Item = CadPmiAsset['items'][number];
      /** Items by meaning: values, datums by name, each target as its face's centroid. */
      const meaning = (items: Item[], brepOf: (t: CadPmiTarget) => Uint8Array) => {
        const names = new Map(
          items.flatMap((i) => (i.kind === 'datum' ? [[i.id, i.name] as const] : [])),
        );
        const where = (ts: CadPmiTarget[] = []) =>
          ts.map((t) => `${t.shape}@${centroid(brepOf(t), t.index)}`).sort();
        return items
          .map((i) =>
            JSON.stringify({
              ...i,
              id: undefined,
              targets: where(i.targets),
              ...(i.kind === 'dimension' && i.targets2 ? { targets2: where(i.targets2) } : {}),
              ...(i.kind === 'geometric-tolerance'
                ? {
                    references: i.references.map((r) => ({
                      ...r,
                      datums: r.datums.map((d) => names.get(d)),
                    })),
                  }
                : {}),
            }),
          )
          .sort();
      };
      try {
        const assetOf = (b: Uint8Array | undefined) =>
          JSON.parse(new TextDecoder().decode(b)) as CadPmiAsset;
        const plate = read.shapes.findIndex((x) => x.pmi);
        const block = read.instances.find((x) => x.shape !== plate)!.shape;
        // Back, the plate is the shape whose PMI has the datums.
        const backPlate = back.read.shapes.findIndex(
          (x, k) => x.pmi && assetOf(back.pmis![k]).items.some((i) => i.kind === 'datum'),
        );
        const backBlock = back.read.shapes.findIndex((_, k) => k !== backPlate);
        expect(back.read.shapes.filter((x) => x.pmi)).toHaveLength(2);
        // The plate's part PMI, as it was imported.
        const plateItems = assetOf(imported.pmis![plate]).items;
        expect(meaning(assetOf(back.pmis![backPlate]).items, () => back.breps[backPlate]!)).toEqual(
          meaning(plateItems, () => imported.breps[plate]!),
        );
        // The block's flatnesses, now the block part's own PMI on the same faces.
        const instanceShape = (t: CadPmiTarget) =>
          read.instances[planned.components.findIndex((c) => c.id === t.component)]!.shape;
        const onBlock = asset.items.filter(
          (i) =>
            i.kind === 'geometric-tolerance' && i.targets.every((t) => instanceShape(t) === block),
        );
        expect(onBlock).toHaveLength(2);
        expect(meaning(assetOf(back.pmis![backBlock]).items, () => back.breps[backBlock]!)).toEqual(
          meaning(
            onBlock.map((i) => ({ ...i, targets: i.targets.map(({ component: _, ...t }) => t) })),
            () => imported.breps[block]!,
          ),
        );
      } finally {
        for (const x of owned.reverse()) x.delete();
      }

      // The report names what is written and what is not.
      const losses = assemblyStepReport(
        written.step,
        plan.plan,
        { sourceContentHash: rootHash, buildHash },
        written.pmi,
      ).losses.join('\n');
      expect(losses).toMatch(/semantic GD&T.*2 dimensions, 1 geometric tolerance, 2 datums/);
      expect(losses).toMatch(/2 of the assembly's own PMI items are written/);
      expect(losses).toMatch(
        /3 assembly PMI items are not written: the component's part is placed more than once/,
      );
      expect(losses).toMatch(
        /1 assembly PMI item is not written: its faces, edges and datums are not all on one component/,
      );
      expect(losses).toMatch(
        /1 assembly PMI item is not written: a datum whose name the file already holds/,
      );
      expect(losses).not.toMatch(/named views, PMI and/);

      // A body's own PMI and the assembly's on one product are two specs: each tolerance keeps
      // its own datum (the block given datum D and a perpendicularity to D of its own).
      // Datum names like the writer's placeholders stay as they are (only product and usage
      // names are renamed).
      const D = 'R2B5P0';
      const E = 'R2B5P999';
      const blockHash = Object.keys(products).find((h) => !products[h]!.bodies[0]!.pmi)!;
      const blockBody = products[blockHash]!.bodies[0]!;
      const withD = {
        ...products,
        [blockHash]: {
          ...products[blockHash]!,
          bodies: [
            {
              ...blockBody,
              pmi: {
                featureId: blockBody.tracking[0]!.featureId,
                asset: {
                  version: 1 as const,
                  items: [
                    {
                      id: 'd',
                      kind: 'datum' as const,
                      name: D,
                      targets: [{ shape: 'face' as const, index: 1 }],
                    },
                    {
                      id: 't',
                      kind: 'geometric-tolerance' as const,
                      type: 'Perpendicularity',
                      value: 0.1,
                      modifiers: [],
                      references: [{ datums: ['d'], modifiers: [] }],
                      targets: [{ shape: 'face' as const, index: 2 }],
                    },
                  ],
                },
                states: [
                  ['d', { current: true }],
                  ['t', { current: true }],
                ] as [string, { current: true }][],
                placements: [],
              },
            },
          ],
        },
      };
      // The block's assembly datum renamed E (a free name), and an angularity to it.
      const plateShape = read.shapes.findIndex((x) => x.pmi);
      const block = read.instances.find((x) => x.shape !== plateShape)!.shape;
      const instanceOf = (t: CadPmiTarget) =>
        read.instances[planned.components.findIndex((c) => c.id === t.component)]!.shape;
      const blockA = asset.items.find(
        (i) => i.kind === 'datum' && i.targets.every((t) => instanceOf(t) === block),
      )!;
      const withE = {
        ...asset,
        items: [
          ...asset.items.map((i) => (i === blockA ? { ...blockA, name: E } : i)),
          {
            id: 'angle',
            kind: 'geometric-tolerance' as const,
            type: 'Angularity',
            value: 0.2,
            modifiers: [],
            references: [{ datums: [blockA.id], modifiers: [] }],
            targets: [{ ...blockA.targets[0]!, index: 3 }],
          },
        ],
      } as typeof asset;
      const two = writeAssemblyStepPmi(oc, plan.plan, breps, {
        products: withD,
        assembly: {
          asset: withE,
          states: [...cadAssemblyPmiStates(root, withE)],
          components: Object.fromEntries(
            root.components.map((c) => [c.id, partHash.get(c.partId)!]),
          ),
        },
      });
      expect(two.pmi?.assembly.written).toBe(4);
      const again = importStepAssembly(oc, two.step, buildHash, { pmi: 'discard' });
      if (again.status !== 'ok') throw new Error(`${again.code} ${again.detail}`);
      expect(again.report.pmi).toMatchObject({ complete: true, lossless: true });
      const blockAgain = again.read.shapes.findIndex(
        (x, k) =>
          x.pmi &&
          (JSON.parse(new TextDecoder().decode(again.pmis![k])) as CadPmiAsset).items.some(
            (i) => i.kind === 'datum' && i.name === D,
          ),
      );
      const items = (JSON.parse(new TextDecoder().decode(again.pmis![blockAgain])) as CadPmiAsset)
        .items;
      expect(items.map((i) => ('type' in i ? i.type : i.kind)).sort()).toEqual([
        'Angularity',
        'Flatness',
        'Flatness',
        'Perpendicularity',
        'datum',
        'datum',
      ]);
      // Each tolerance names its own datum: joined, the angularity's first datum would be D.
      const named = (n: string) => items.find((i) => i.kind === 'datum' && i.name === n)!.id;
      expect(items.find((i) => 'type' in i && i.type === 'Perpendicularity')).toMatchObject({
        references: [{ datums: [named(D)] }],
      });
      expect(items.find((i) => 'type' in i && i.type === 'Angularity')).toMatchObject({
        references: [{ datums: [named(E)] }],
      });
    }, 300_000);
  },
);
