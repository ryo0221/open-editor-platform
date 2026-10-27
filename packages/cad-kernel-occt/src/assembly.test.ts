import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  applyCadOperation,
  CadAssemblyPort,
  cadContentHash,
  f40CarAssembly,
  identityQuaternion,
  position,
  r2bParts,
  type CadDocument,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadPartKernelPort,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogKernelPort } from './catalog';
import { createKernelHost } from './host';
import type { WorkerLike } from './port';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('R2b-1 assembly with the development build (CAD50, CAD52)', () => {
  let buildHash = '';
  const posted: CadWorkerResponse[] = [];
  let handle: (m: CadWorkerRequest) => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  let n = 0;
  const run = async (request: CadEvaluateRequest): Promise<CadEvaluation> => {
    const requestId = `${request.requestId}-${n++}`;
    await handle({ type: 'evaluate', ...request, requestId, generation: 1 });
    const m = posted.find(
      (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
    );
    if (m?.type !== 'result') throw new Error(JSON.stringify(m));
    return m.evaluation;
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

  it('evaluates each reached version once on the real kernel, nested ones included', async () => {
    const f = r2bParts({ id: 'occt', buildHash });
    const jobs: string[] = [];
    const kernel: CadPartKernelPort = {
      evaluate: (request) => (jobs.push('own'), run(request)),
      evaluatePart: (request) => (jobs.push(request.candidateHash), run(request)),
      cancel: () => {},
    };
    const port = new CadAssemblyPort({ kernel, parts: (h) => f.closure.get(h) });
    const request = (doc: CadDocument, id: string): CadEvaluateRequest => ({
      requestId: id,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(doc),
      document: doc,
    });
    const result = await port.evaluate(request(f.assembly, 'rig'));
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    // Plate, shaft and pair once each, though the plate is reached three times (twice in the pair).
    expect(jobs.filter((j) => j !== 'own').sort()).toEqual([...f.closure.keys()].sort());
    const versions = result.assembly!.versions;
    expect(Object.values(versions).map((v) => v.state)).toEqual([
      'available',
      'available',
      'available',
    ]);
    const plate = versions[f.plate.contentHash]!;
    expect(plate.buildHash).toBe(buildHash);
    expect(plate.bodies?.plate?.bounds[1][2]).toBeGreaterThan(0);
    // A second evaluation of a moved component reuses every version.
    const before = jobs.length;
    const again = await port.evaluate(request(f.assembly, 'rig-2'));
    expect(again.status).toBe('ok');
    expect(jobs.length - before).toBe(1);
  }, 300_000);

  it('writes and reads an AP242 assembly through the XDE bindings (R2b kernel build, CAD52 groundwork)', () => {
    // A probe of the R2b-5 path, owned here: every object is deleted at the end.
    const own: { delete(): void }[] = [];
    const o = <T extends { delete(): void }>(x: T) => (own.push(x), x);
    const text = (s: string) => o(new oc.TCollection_ExtendedString_2(s, false));
    const progress = () => o(new oc.Message_ProgressRange_1());
    const xde = () => {
      const doc = o(new oc.Handle_TDocStd_Document_2(new oc.TDocStd_Document(text('MDTV-XCAF'))));
      const main = doc.get().Main();
      // No XCAFApp_Application: the tools are made on the document's main label on first use.
      return { doc, tool: o(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get() };
    };
    try {
      const out = xde();
      const box = o(new oc.BRepPrimAPI_MakeBox_2(80, 50, 5));
      const plate = out.tool.AddShape(box.Shape(), false, true);
      o(oc.TDataStd_Name.Set_1(plate, text('Plate')));
      const rig = out.tool.NewShape();
      o(oc.TDataStd_Name.Set_1(rig, text('Rig')));
      const trsf = o(new oc.gp_Trsf_1());
      trsf.SetTranslation_1(o(new oc.gp_Vec_4(0, 100, 0)));
      out.tool.AddComponent_1(rig, plate, o(new oc.TopLoc_Location_1()));
      out.tool.AddComponent_1(rig, plate, o(new oc.TopLoc_Location_2(trsf)));
      out.tool.UpdateAssemblies();
      const writer = o(new oc.STEPCAFControl_Writer_1());
      writer.SetNameMode(true);
      // The STEP statics exist once a writer (its controller) is made; 5 selects AP242.
      expect(oc.OCJS.setStaticInteger('write.step.schema', 5)).toBe(true);
      expect(oc.OCJS.staticInteger('write.step.schema')).toBe(5);
      expect(
        writer.Transfer_1(out.doc, oc.STEPControl_StepModelType.STEPControl_AsIs, '', progress()),
      ).toBe(true);
      const path = '/r2b-probe.step';
      expect(writer.Write(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      const step = new TextDecoder().decode(oc.FS.readFile(path) as Uint8Array);
      expect(step).toMatch(/AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/i);
      expect(step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(2);
      // Read back: one free assembly of two components, both the named plate.
      const reader = o(new oc.STEPCAFControl_Reader_1());
      reader.SetNameMode(true);
      expect(reader.ReadFile(path)).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      oc.FS.unlink(path);
      const back = xde();
      expect(reader.Transfer_1(back.doc, progress())).toBe(true);
      const free = o(new oc.TDF_LabelSequence_1());
      back.tool.GetFreeShapes(free);
      expect(free.Length()).toBe(1);
      const root = free.Value(1);
      expect(oc.XCAFDoc_ShapeTool.IsAssembly(root)).toBe(true);
      expect(o(oc.OCJS.labelName(root)).ToCString()).toBe('Rig');
      const components = o(new oc.TDF_LabelSequence_1());
      oc.XCAFDoc_ShapeTool.GetComponents(root, components, false);
      expect(components.Length()).toBe(2);
      const names = [1, 2].map((i) => {
        const referred = o(new oc.TDF_Label());
        expect(oc.XCAFDoc_ShapeTool.GetReferredShape(components.Value(i), referred)).toBe(true);
        return o(oc.OCJS.labelName(referred)).ToCString();
      });
      expect(names).toEqual(['Plate', 'Plate']);
    } finally {
      for (const x of own.reverse()) x.delete();
    }
  });

  it('adds a coarse display mesh without changing the evaluation or the standard mesh (R2b-4)', async () => {
    const f = r2bParts({ id: 'occt', buildHash });
    const shaft = f.shaft.content;
    const result = async (coarse: boolean) => {
      const requestId = `lod-${n++}`;
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: f.shaft.contentHash,
        candidateHash: f.shaft.contentHash,
        document: shaft,
        ...(coarse ? { coarse: true as const } : {}),
      });
      const m = posted.find((x) => x.type === 'result' && x.requestId === requestId);
      if (m?.type !== 'result') throw new Error(JSON.stringify(m));
      return m;
    };
    const plain = await result(false);
    const both = await result(true);
    expect(both.evaluation).toEqual(plain.evaluation);
    const standard = both.meshes.filter((m) => !m.lod);
    const coarse = both.meshes.filter((m) => m.lod === 'coarse');
    expect(standard.map((m) => [...m.indices])).toEqual(plain.meshes.map((m) => [...m.indices]));
    expect(standard.map((m) => [...m.positions])).toEqual(
      plain.meshes.map((m) => [...m.positions]),
    );
    expect(coarse.map((m) => m.bodyId)).toEqual(standard.map((m) => m.bodyId));
    // A revolved ring: 1% and 1 rad make far fewer triangles; the pick table is the standard's.
    expect(coarse[0]!.indices.length).toBeGreaterThan(0);
    expect(coarse[0]!.indices.length).toBeLessThan(standard[0]!.indices.length / 2);
    expect(coarse[0]!.topology.faces).toEqual([]);
    // The next evaluation meshes afresh: the same standard mesh again.
    const again = await result(false);
    expect(again.meshes.map((m) => [...m.positions])).toEqual(
      plain.meshes.map((m) => [...m.positions]),
    );
  });

  it('links the gp_Cylinder binding connectors will read (R2b-2)', () => {
    expect(typeof oc.gp_Cylinder_1).toBe('function');
  });

  it('F40: a wheel move sends no Worker job, a body edit only its own (CM-3b, CAD74)', async () => {
    const f = f40CarAssembly({ id: 'occt', buildHash });
    // The Worker in-process: the same loaded module behind the whole port stack.
    const sent: CadWorkerRequest[] = [];
    const spawn = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (m) => {
          sent.push(m);
          void host(m);
        },
        terminate: () => {},
      };
      const host = createKernelHost({
        load: async () => oc,
        post: (m) => worker.onmessage?.({ data: m }),
        yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
      });
      return worker;
    };
    const meshes: string[] = [];
    const kernel = new CatalogKernelPort(
      { current: { id: 'occt', buildHash, moduleUrl: '', wasmUrl: '' } },
      { spawn, jobTimeoutMs: 300_000, onMeshes: (hash) => void meshes.push(hash) },
    );
    const port = new CadAssemblyPort({ kernel, parts: (h) => f.closure.get(h) });
    const request = (doc: CadDocument, id: string): CadEvaluateRequest => ({
      requestId: id,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(doc),
      document: doc,
    });
    const jobs = () => sent.filter((m) => m.type === 'evaluate').map((m) => m.candidateHash);
    try {
      const first = await port.evaluate(request(f.assembly, 'car'));
      if (first.status !== 'ok') throw new Error(JSON.stringify(first));
      // The car's own bodies, then the wheel version once for its four placements.
      expect(jobs()).toEqual([cadContentHash(f.assembly), f.wheel.contentHash]);
      expect(first.assembly!.versions[f.wheel.contentHash]!.state).toBe('available');
      expect(Object.keys(first.bodies)).toHaveLength(5);

      const moved = applyCadOperation(f.assembly, {
        type: 'setComponentPlacement',
        componentId: 'wheel-RL',
        placement: { translation: position(3400, 700, 340), rotation: identityQuaternion() },
      });
      const after = await port.evaluate(request(moved, 'move'));
      if (after.status !== 'ok') throw new Error(JSON.stringify(after));
      expect(jobs()).toHaveLength(2);
      const { contentHash, assembly, ...shapes } = after;
      const { contentHash: before, assembly: beforeAssembly, ...kept } = first;
      expect(contentHash).toBe(cadContentHash(moved));
      expect(before).not.toBe(contentHash);
      // The same shapes and digest; the wheel's version is the cached one.
      expect(shapes).toEqual(kept);
      expect(assembly!.versions).toEqual(beforeAssembly!.versions);
      expect(meshes).toContain(contentHash);

      const axle = moved.parameters.find((p) => p.name === 'Rear axle X')!;
      const edited = applyCadOperation(moved, {
        type: 'setParameter',
        parameterId: axle.id,
        value: 3400,
      });
      const rebuilt = await port.evaluate(request(edited, 'axle'));
      if (rebuilt.status !== 'ok') throw new Error(JSON.stringify(rebuilt));
      // The car's own bodies again (the rear arch moved); no wheel job.
      expect(jobs()).toEqual([
        cadContentHash(f.assembly),
        f.wheel.contentHash,
        cadContentHash(edited),
      ]);
      expect(rebuilt.geometryDigest).not.toBe(first.geometryDigest);
    } finally {
      port.dispose();
      kernel.dispose();
    }
  }, 300_000);
});
