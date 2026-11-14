import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, f95Nagi, f95NagiAero, type CadDocument } from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { evaluateCad, type CadAnalysisSurface } from './index';

const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

/** Every edge of the triangles is shared by exactly two of them, once each way. */
function closed(s: CadAnalysisSurface): boolean {
  const seen = new Map<string, number>();
  for (let t = 0; t < s.triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = s.triangles[t + k]!;
      const b = s.triangles[t + ((k + 1) % 3)]!;
      const key = `${a},${b}`;
      if (seen.has(key)) return false;
      seen.set(key, 1);
    }
  for (const key of seen.keys()) {
    const [a, b] = key.split(',');
    if (!seen.has(`${b},${a}`)) return false;
  }
  return true;
}
/** The enclosed volume (mm³), positive with outward triangles. */
function volume(s: CadAnalysisSurface): number {
  const p = s.points;
  let v = 0;
  for (let t = 0; t < s.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => 3 * s.triangles[t + k]!);
    v +=
      p[a!]! * (p[b! + 1]! * p[c! + 2]! - p[b! + 2]! * p[c! + 1]!) -
      p[a! + 1]! * (p[b!]! * p[c! + 2]! - p[b! + 2]! * p[c!]!) +
      p[a! + 2]! * (p[b!]! * p[c! + 1]! - p[b! + 1]! * p[c!]!);
  }
  return v / 6;
}
function bounds(s: CadAnalysisSurface) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.points.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3]!, s.points[i]!);
    hi[i % 3] = Math.max(hi[i % 3]!, s.points[i]!);
  }
  return { lo, hi };
}

describe.skipIf(!available)('F95 凪 aero bodies → analysis surfaces (VS1a)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
  }, 300_000);

  const surface = async (doc: CadDocument, bodyId: string) => {
    const r = await evaluateCad(oc, doc, cadContentHash(doc), {
      analysisSurface: { bodyId, deflectionMm: 2 },
    });
    expect(r.evaluation.status).toBe('ok');
    if (!r.analysisSurface || !('surface' in r.analysisSurface)) throw new Error(bodyId);
    const s = r.analysisSurface.surface;
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeGreaterThan(0);
    // Every triangle names the body face it came from.
    expect(s.faces).toHaveLength(s.triangles.length / 3);
    return { s, ...bounds(s), volume: volume(s) };
  };

  it('gives every body of the closed car as a closed surface at the drawing sizes', async () => {
    // TS-2203, ST-601. The skin's 18 closed spline sections need the loft without OCCT's wire
    // matching (it throws SameNumberByPolarMethod without naming its class).
    const doc = f95NagiAero();
    const skin = await surface(doc, 'skin');
    expect(skin.lo[0]).toBeGreaterThan(0);
    expect(skin.hi[0]).toBeLessThan(f95Nagi.length);
    expect(skin.hi[0]! - skin.lo[0]!).toBeGreaterThan(3950);
    expect(Math.abs(skin.hi[1]! + skin.lo[1]!)).toBeLessThan(1);
    expect(skin.hi[1]).toBeGreaterThan(870);
    expect(skin.hi[1]).toBeLessThan(890);
    // The floor between the wheels (the drawing's 165–195 mm) and the tail's top (958 mm).
    expect(skin.lo[2]).toBeGreaterThan(140);
    expect(skin.lo[2]).toBeLessThan(170);
    expect(skin.hi[2]).toBeGreaterThan(940);
    expect(skin.hi[2]).toBeLessThan(970);
    const top = await surface(doc, 'hard-top');
    expect(top.hi[2]).toBeGreaterThan(f95Nagi.roofHeight - 20);
    expect(top.hi[2]).toBeLessThan(f95Nagi.roofHeight + 40);
    for (const id of ['wheel-fl', 'wheel-rr']) {
      const w = await surface(doc, id);
      // The tyre stands on the ground (its triangles are inside the circle, by the deflection).
      expect(w.lo[2]).toBeGreaterThanOrEqual(-1e-6);
      expect(w.lo[2]).toBeLessThan(2);
      expect(w.hi[2]).toBeGreaterThan(2 * f95Nagi.tyre.radius - 2);
      expect(w.volume / (Math.PI * f95Nagi.tyre.radius ** 2 * f95Nagi.tyre.width)).toBeGreaterThan(
        0.99,
      );
    }
    const mirror = await surface(doc, 'mirror-l');
    expect(mirror.lo[1]).toBeLessThan(-950);
    expect(mirror.hi[1]).toBeLessThan(-780);
  }, 600_000);

  it('gives the windscreen of the open car as a closed surface', async () => {
    // TS-2203, ST-601.
    const screen = await surface(f95NagiAero({ roof: 'open', mirrors: false }), 'windscreen');
    expect(screen.hi[2]).toBeGreaterThan(1200);
    expect(screen.hi[0]! - screen.lo[0]!).toBeLessThan(450);
  }, 600_000);
});
