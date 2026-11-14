import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  evaluateGeometry,
  type GeometryEvaluation,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';
import {
  loopArea,
  pcbModel3d,
  pcbPartsSample,
  pcbZoneFills,
  type PcbDocument,
} from '@editor-platform/pcb-core';
import { describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { readPcbGlbJson, writePcbGlb } from './glb';
import { WorkerPcbKernel, type PcbWorkerLike, type PcbWorkerResponse } from './kernel';
import { pcbSideArt } from './layer-art';
import { pcbFaceSheet, pcbFinishOf, pcbMeshRequests, pcbPieces, pcbStepRequest } from './scene3d';

// PB7b (ST-468): face pictures TS-1942, sheets and GLB TS-1943, Worker port TS-1944.

/** The sample with a GND pour on both faces, a track on the bottom and a via. */
function board(): PcbDocument {
  const doc = pcbPartsSample();
  return {
    ...doc,
    nets: [{ id: 'gnd', name: 'GND', class: 'nc-default', pins: [] }],
    tracks: [{ id: 't1', net: 'gnd', layer: 'B.Cu', widthMm: 0.4, from: [40, 40], to: [60, 40] }],
    vias: [{ id: 'v1', net: 'gnd', at: [60, 40], diameterMm: 0.6, drillMm: 0.3 }],
  };
}

describe('PB7b 3D view', () => {
  it('TS-1942: draws each face: mask, copper under it, open pads, silkscreen, clear holes', () => {
    const doc = board();
    const fills = pcbZoneFills(doc);
    const top = pcbSideArt(doc, fills, 'top');
    const bottom = pcbSideArt(doc, fills, 'bottom');
    expect(top.bounds).toEqual([0, 0, 85, 56]);
    // The mask first, over the outline.
    expect(top.shapes[0]).toMatchObject({ kind: 'polygon', color: '#1f6b3a' });
    const count = (art: typeof top, kind: string, color?: string) =>
      art.shapes.filter((s) => s.kind === kind && (!color || ('color' in s && s.color === color)))
        .length;
    // The bottom track is on the bottom only; the via shows on both faces.
    expect(top.shapes.some((s) => s.kind === 'line' && s.widthMm === 0.4)).toBe(false);
    expect(bottom.shapes.some((s) => s.kind === 'line' && s.widthMm === 0.4)).toBe(true);
    expect(count(top, 'disc') && count(bottom, 'disc')).toBeTruthy();
    // Pads where the mask opens: SMD pads on their side, through pads on both.
    const pads = (side: 'top' | 'bottom') =>
      doc.components.flatMap((c) =>
        doc.footprints
          .find((f) => f.id === c.footprint)!
          .pads.filter((p) => p.type === 'thru' || (p.type === 'smd' && c.side === side)),
      ).length;
    expect(count(top, 'polygon', '#c9cbcf')).toBe(pads('top'));
    expect(count(bottom, 'polygon', '#c9cbcf')).toBe(pads('bottom'));
    // Silkscreen of the parts on that face only, in the board's silk colour.
    expect(count(top, 'line', '#f2f2ec')).toBeGreaterThan(count(bottom, 'line', '#f2f2ec'));
    // Every drill is clear on both faces: parts, mounting holes and the via.
    const holes =
      4 +
      1 +
      doc.components.flatMap((c) =>
        doc.footprints.find((f) => f.id === c.footprint)!.pads.filter((p) => p.type !== 'smd'),
      ).length;
    expect(count(top, 'hole')).toBe(holes);
    expect(count(bottom, 'hole')).toBe(holes);
  });

  it('TS-1943: covers each face with a sheet and writes every piece to GLB', async () => {
    const doc = board();
    for (const side of ['top', 'bottom'] as const) {
      const s = pcbFaceSheet(doc, side);
      // The sheet's triangles cover the outline and face away from the board.
      let area = 0;
      for (let i = 0; i < s.indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => s.indices[i + k]! * 3);
        area +=
          ((s.positions[b!]! - s.positions[a!]!) * (s.positions[c! + 1]! - s.positions[a! + 1]!) -
            (s.positions[b! + 1]! - s.positions[a! + 1]!) * (s.positions[c!]! - s.positions[a!]!)) /
          2;
      }
      // Chords inside the corners' arcs (0.005 mm) take a little less.
      expect(loopArea(doc.board.outline) - Math.abs(area)).toBeGreaterThanOrEqual(0);
      expect(loopArea(doc.board.outline) - Math.abs(area)).toBeLessThan(0.1);
      expect(Math.sign(area)).toBe(side === 'top' ? 1 : -1);
      expect(s.positions[2]).toBeCloseTo(side === 'top' ? 1.61 : -0.01, 6);
      for (const u of s.uvs) expect(u >= -1e-6 && u <= 1 + 1e-6).toBe(true);
    }
    // A run's pieces (a mesh per part) become GLB nodes, in metres and Y up.
    const model = pcbModel3d(doc);
    const mesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 5]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      faceIndices: new Uint32Array([0]),
    };
    const outcome: GeometryEvaluation = {
      status: 'ok',
      results: model.parts.map((p, i) =>
        i === 3
          ? { status: 'error', node: p.node, code: 'empty-result' }
          : { status: 'ok', node: p.node, mesh },
      ),
    };
    const result = pcbPieces(model, outcome);
    if ('error' in result) throw new Error(result.error);
    expect(result.failed).toEqual([model.parts[3]!.name]);
    expect(result.pieces).toHaveLength(model.parts.length - 1);
    expect(pcbPieces(model, { status: 'timeout' })).toEqual({ error: 'timeout' });
    const sheet = pcbFaceSheet(doc, 'top');
    const bytes = writePcbGlb(
      [
        ...result.pieces.map((p) => ({
          ...p.mesh,
          name: p.name,
          color: p.color,
          ...pcbFinishOf[p.material],
        })),
        {
          ...sheet,
          name: 'Board top face',
          color: '#ffffff',
          metalness: 0,
          roughness: 0.5,
          texture: { uvs: sheet.uvs, png: new Uint8Array([137, 80, 78, 71]) },
        },
      ],
      'sample',
    );
    expect(bytes.byteLength % 4).toBe(0);
    const json = readPcbGlbJson(bytes) as {
      nodes: { name: string }[];
      accessors: { min?: number[]; max?: number[] }[];
      materials: { pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number } }[];
      images: unknown[];
    };
    expect(json.nodes.map((n) => n.name)).toEqual([
      ...result.pieces.map((p) => p.name),
      'Board top face',
    ]);
    // (10, 20, 5) mm → (0.01, 0.005, −0.02) m.
    expect(json.accessors[0]!.max).toEqual([0.01, 0.005, 0].map(Math.fround));
    expect(json.accessors[0]!.min).toEqual([0, 0, -0.02].map(Math.fround));
    expect(json.materials[1]!.pbrMetallicRoughness.metallicFactor).toBe(
      pcbFinishOf[result.pieces[1]!.material].metalness,
    );
    expect(json.images).toHaveLength(1);
    // The face's texture coordinates: v up in the view, written as glTF's v down (1 − v).
    const glb = json as unknown as {
      meshes: { primitives: { attributes: Record<string, number> }[] }[];
      accessors: { bufferView: number; count: number }[];
      bufferViews: { byteOffset: number; byteLength: number }[];
    };
    const faceUv = glb.accessors[glb.meshes.at(-1)!.primitives[0]!.attributes.TEXCOORD_0!]!;
    const viewAt = glb.bufferViews[faceUv.bufferView]!;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const binStart = 20 + dv.getUint32(12, true) + 8;
    const written = new Float32Array(
      bytes.slice(
        binStart + viewAt.byteOffset,
        binStart + viewAt.byteOffset + viewAt.byteLength,
      ).buffer,
    );
    expect(written).toHaveLength(sheet.uvs.length);
    sheet.uvs.forEach((t, k) => expect(written[k]).toBeCloseTo(k % 2 ? 1 - t : t, 6));
    // The same pieces give the same bytes.
    expect(
      writePcbGlb([{ ...mesh, name: 'a', color: '#123456', metalness: 0, roughness: 1 }], 'x'),
    ).toEqual(
      writePcbGlb([{ ...mesh, name: 'a', color: '#123456', metalness: 0, roughness: 1 }], 'x'),
    );
  });

  it('TS-1944: runs jobs in a Worker, stops one past its time and recovers from a crash', async () => {
    const spawned: FakeWorker[] = [];
    class FakeWorker implements PcbWorkerLike {
      onmessage: ((event: { data: PcbWorkerResponse }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      terminated = false;
      runs: string[] = [];
      constructor(readonly mode: 'ok' | 'hang' | 'crash' | 'no-load') {
        spawned.push(this);
      }
      postMessage(m: Parameters<PcbWorkerLike['postMessage']>[0]) {
        queueMicrotask(() => {
          if (m.type === 'init')
            this.onmessage?.({
              data:
                this.mode === 'no-load'
                  ? { type: 'init-failed', code: 'kernel-load-failed' }
                  : { type: 'ready', buildHash: 'h' },
            });
          else if (m.type === 'run') {
            this.runs.push(m.requestId);
            if (this.mode === 'ok')
              this.onmessage?.({
                data: {
                  type: 'result',
                  requestId: m.requestId,
                  evaluation: { status: 'ok', results: [] },
                },
              });
            else if (this.mode === 'crash') this.onerror?.(new Error('boom'));
          }
        });
      }
      terminate() {
        this.terminated = true;
      }
    }
    const modes: FakeWorker['mode'][] = ['no-load', 'hang', 'crash', 'ok'];
    const kernel = new WorkerPcbKernel({
      spawn: () => new FakeWorker(modes.shift()!),
      build: { moduleUrl: 'm', wasmUrl: 'w', buildHash: 'sha256:h' } as never,
      jobTimeoutMs: 50,
    });
    const graph = { nodes: {} };
    // A build that fails to load is tried again with a fresh Worker on the next job.
    expect(await kernel.run(graph, [])).toEqual({ status: 'error', code: 'kernel-load-failed' });
    expect(spawned[0]!.terminated).toBe(true);
    spawned.shift();
    expect(await kernel.run(graph, [])).toEqual({ status: 'timeout' });
    expect(spawned[0]!.terminated).toBe(true);
    expect(await kernel.run(graph, [])).toEqual({ status: 'error', code: 'kernel-crashed' });
    expect(await kernel.run(graph, [])).toEqual({ status: 'ok', results: [] });
    // A job cancelled before it starts never reaches the Worker.
    const abort = new AbortController();
    abort.abort();
    expect(await kernel.run(graph, [], abort.signal)).toEqual({ status: 'cancelled' });
    expect(spawned[2]!.runs).toHaveLength(1);
    kernel.dispose();
    expect(spawned[2]!.terminated).toBe(true);
    expect(await kernel.run(graph, [])).toEqual({ status: 'cancelled' });
    // Without a build the view says the kernel is missing.
    const none = new WorkerPcbKernel({ spawn: () => new FakeWorker('ok'), build: undefined });
    expect(await none.run(graph, [])).toEqual({ status: 'error', code: 'kernel-unavailable' });
  });
});

const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('PB7b with the development build', () => {
  it('TS-1944: meshes every piece of the sample at the view quality', async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    const oc: OcModule = await factory({
      wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`),
    });
    const model = pcbModel3d(board());
    const result = pcbPieces(
      model,
      await evaluateGeometry(oc, model.graph, pcbMeshRequests(model)),
    );
    if ('error' in result) throw new Error(result.error);
    expect(result.failed).toEqual([]);
    expect(result.pieces).toHaveLength(model.parts.length);
    for (const p of result.pieces) expect(p.mesh.indices.length, p.name).toBeGreaterThan(0);
    // PB7c (TS-1949): the whole sample as AP242, one product per piece under the file's.
    const written = await evaluateGeometry(oc, model.graph, [], {
      step: pcbStepRequest(model, 'sample', 'ap242'),
    });
    if (written.status !== 'ok' || written.step?.status !== 'ok')
      throw new Error(JSON.stringify(written.status === 'ok' ? written.step : written));
    const text = new TextDecoder().decode(written.step.bytes);
    expect(text).toMatch(/AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/);
    expect(text.match(/PRODUCT\('/g)).toHaveLength(model.parts.length + 1);
    for (const p of model.parts) expect(text).toContain(`PRODUCT('${p.name}','${p.name}'`);
  }, 120_000);
});
