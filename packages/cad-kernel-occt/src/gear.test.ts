import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  cadBuilder,
  cadContentHash,
  spurGearFlankEnd,
  spurGearHalfAngle,
  spurGearRadii,
  type CadDocument,
  type CycloidalGearSpec,
  type InvoluteGearSpec,
  type SpurGearSpec,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

/** Signed volume of a closed triangle mesh (divergence theorem). */
function volume(m: CadMesh): number {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!].map((k) => 3 * k);
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
      6;
  }
  return Math.abs(v);
}
/** The outline's area from a fine polygon of the exact involute (independent of the splines). */
function outlineArea(g: SpurGearSpec): number {
  const { base, root } = spurGearRadii(g);
  const end = spurGearFlankEnd(g);
  const tip = end.radius;
  const pts: [number, number][] = [];
  const pitch = (2 * Math.PI) / g.teeth;
  const start = Math.max(root, base);
  const rs = Array.from({ length: 200 }, (_, i) => start + ((tip - start) * i) / 199);
  const halfStart = spurGearHalfAngle(g, start);
  // A pointed tip closes on the centre line.
  const half = (r: number) => (end.pointed && r === tip ? 0 : spurGearHalfAngle(g, r));
  for (let k = 0; k < g.teeth; k++) {
    const c = k * pitch;
    const at = (r: number, a: number) => pts.push([r * Math.cos(a), r * Math.sin(a)]);
    if (root < base) at(root, c - halfStart);
    for (const r of rs) at(r, c - half(r));
    if (!end.pointed)
      for (let i = 1; i < 50; i++) at(tip, c - half(tip) + (2 * half(tip) * i) / 50);
    for (const r of [...rs].reverse()) at(r, c + half(r));
    if (root < base) at(root, c + halfStart);
    const a0 = c + halfStart;
    const a1 = c + pitch - halfStart;
    for (let i = 1; i < 50; i++) at(root, a0 + ((a1 - a0) * i) / 50);
  }
  let s = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    s += (p[0] * q[1] - p[1] * q[0]) / 2;
  });
  return s;
}

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('WM1a spur gear in the kernel (ST-440, TS-1881)', () => {
  const host = { evaluate: undefined as unknown as (d: CadDocument) => Promise<CadWorkerResponse> };
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    globalThis.require ??= createRequire(import.meta.url);
    const posted: CadWorkerResponse[] = [];
    const handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({
      type: 'init',
      build: { buildHash: `sha256:${sha}`, moduleUrl: '', wasmUrl: '' },
    });
    let n = 0;
    host.evaluate = async (document) => {
      const requestId = `gear-${n++}`;
      await handle({
        type: 'evaluate',
        requestId,
        generation: n,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
      } as CadWorkerRequest);
      return posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      )!;
    };
  }, 120_000);

  const deg = (d: number) => (d * Math.PI) / 180;
  const gear = (g: SpurGearSpec, faceWidth: number) => {
    const b = cadBuilder({ id: 'occt', buildHash: `sha256:${cadKernelBuild.wasmSha256}` });
    b.spurGear('Gear', {
      module: g.module,
      teeth: g.teeth,
      faceWidth,
      ...(g.profile === 'cycloidal'
        ? {
            profile: 'cycloidal',
            matingTeeth: g.matingTeeth,
            toothThickness: g.toothThickness,
            addendum: g.addendum,
            dedendum: g.dedendum,
          }
        : { pressureAngle: g.pressureAngle, profileShift: g.profileShift }),
      bore: g.bore,
      ...(g.spokes && { spokes: g.spokes }),
    });
    return b.build().document;
  };
  const spec = (o: Partial<InvoluteGearSpec>): InvoluteGearSpec => ({
    module: 0.15,
    teeth: 48,
    pressureAngle: deg(20),
    profileShift: 0,
    addendum: 1,
    dedendum: 1.25,
    bore: 0,
    ...o,
  });

  it('extrudes the exact involute outline: volume and radius match the formula', async () => {
    for (const g of [
      spec({}),
      spec({ teeth: 12, profileShift: 0.3 }),
      spec({ teeth: 120, module: 0.1 }),
    ]) {
      const m = await host.evaluate(gear(g, 0.5));
      if (m.type !== 'result' || m.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(m).slice(0, 2000));
      expect(m.meshes).toHaveLength(1);
      const mesh = m.meshes[0]!;
      const expected = outlineArea(g) * 0.5;
      expect(Math.abs(volume(mesh) - expected) / expected).toBeLessThan(0.002);
      let rmax = 0;
      for (let i = 0; i < mesh.positions.length; i += 3)
        rmax = Math.max(
          rmax,
          Math.hypot(mesh.positions[i]! + mesh.origin[0], mesh.positions[i + 1]! + mesh.origin[1]),
        );
      expect(rmax).toBeCloseTo(spurGearRadii(g).tip, 3);
    }
  }, 300_000);

  it('extrudes cycloidal watch teeth, rounded and ogival (WM1b, TS-1884)', async () => {
    const watch = (o: Partial<CycloidalGearSpec>): CycloidalGearSpec => ({
      profile: 'cycloidal',
      module: 0.1,
      teeth: 80,
      matingTeeth: 10,
      toothThickness: 0.5,
      addendum: 1.3,
      dedendum: 1.6,
      bore: 0,
      ...o,
    });
    for (const g of [
      watch({}),
      watch({ addendum: 2 }),
      watch({ teeth: 10, matingTeeth: 80, toothThickness: 0.4, addendum: 0.7 }),
    ]) {
      const m = await host.evaluate(gear(g, 0.3));
      if (m.type !== 'result' || m.evaluation.status !== 'ok')
        throw new Error(JSON.stringify(m).slice(0, 2000));
      const expected = outlineArea(g) * 0.3;
      expect(Math.abs(volume(m.meshes[0]!) - expected) / expected).toBeLessThan(0.002);
    }
  }, 300_000);

  it('cuts the bore and spoke windows in the same extrusion', async () => {
    const plain = spec({});
    const spokes = { count: 5, rim: 0.3, hub: 0.3, width: 0.25 };
    const holed = spec({ bore: 0.24, spokes });
    const [a, b] = [await host.evaluate(gear(plain, 0.25)), await host.evaluate(gear(holed, 0.25))];
    if (a.type !== 'result' || b.type !== 'result') throw new Error('no result');
    expect(b.evaluation.status).toBe('ok');
    const removed = volume(a.meshes[0]!) - volume(b.meshes[0]!);
    // Bore plus five windows: the ring between the hub and the rim less five arms.
    const inner = 0.12 + 0.3;
    const outer = spurGearRadii(holed).root - 0.3;
    const ring = Math.PI * (outer * outer - inner * inner) - 5 * 0.25 * (outer - inner);
    const expected = (Math.PI * 0.12 * 0.12 + ring) * 0.25;
    expect(Math.abs(removed - expected) / expected).toBeLessThan(0.01);
  }, 300_000);

  it('refuses an undercut gear with its code', async () => {
    const doc = gear(spec({ teeth: 30 }), 0.3);
    const f = doc.features[0]!;
    if (f.type === 'spurGear') f.args.teeth = { literal: 10 };
    const m = await host.evaluate(doc);
    expect(JSON.stringify(m)).toContain('gear-undercut');
  }, 60_000);
});
