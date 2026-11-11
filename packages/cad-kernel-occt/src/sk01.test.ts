import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  cadContentHash,
  checkCadInterference,
  checkCadInterferenceAlong,
  cadSweepLimits,
  sk01Escapement,
  sk01Movement,
  sk01Watch,
  type CadDocument,
  type CadInterferenceMesh,
  type CadResolvedJointValues,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('WM5a–b SK-01 with kernel meshes (ST-447, TS-1897; ST-448, TS-1899)', () => {
  const f = { current: undefined as ReturnType<typeof sk01Movement> | undefined };
  const w = { current: undefined as ReturnType<typeof sk01Watch> | undefined };
  const meshes = new Map<string, CadInterferenceMesh[]>();
  const timings: string[] = [];
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    const buildHash = `sha256:${sha}`;
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
    await handle({ type: 'init', build: { buildHash, moduleUrl: '', wasmUrl: '' } });
    const movement = sk01Movement({ id: 'occt', buildHash });
    // WM5b: the watch's parts are the movement's (the same versions) and the case's.
    const watch = sk01Watch({ id: 'occt', buildHash });
    for (const p of watch.parts) {
      const v = watch.versions.get(p.key)!;
      const requestId = `sk01-${p.key}`;
      const t0 = performance.now();
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(v.content as CadDocument),
        document: v.content as CadDocument,
      } as CadWorkerRequest);
      timings.push(`${p.key} ${Math.round(performance.now() - t0)} ms`);
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result' || m.evaluation.status !== 'ok')
        throw new Error(`${p.key}: ${JSON.stringify(m).slice(0, 600)}`);
      meshes.set(
        v.contentHash,
        m.meshes.map((x) => ({
          bodyId: x.bodyId,
          origin: [...x.origin] as [number, number, number],
          positions: [...x.positions],
          indices: [...x.indices],
        })),
      );
    }
    f.current = movement;
    w.current = watch;
  }, 1_200_000);

  it('evaluates every part and holds the movement clear at rest', () => {
    console.log(timings.join('\n'));
    const { assembly: doc, lookup, solve } = f.current!;
    const { joints } = solve(doc);
    const r = checkCadInterference({ doc, lookup, meshesOf: (h) => meshes.get(h), joints });
    expect(r.status).toBe('ok');
    if (r.status === 'ok')
      expect([r.findings.map((x) => `${x.a.join('/')}–${x.b.join('/')}`), r.unchecked]).toEqual([
        [],
        [],
      ]);
  });

  it('runs two beats of the escapement without an overlap', () => {
    const { assembly: doc, lookup, solve } = f.current!;
    const { joints } = solve(doc);
    const e = sk01Escapement;
    const beta = e.forkAngle;
    const step = Math.PI / e.teeth;
    const amplitude = (280 * Math.PI) / 180;
    // One beat is 1/8 s at 28,800 an hour; the impulse lasts while the balance is within ±26°.
    const half = Math.asin(26 / 280) / Math.PI;
    const samples: { tick: number; values: Map<string, CadResolvedJointValues> }[] = [];
    const n = 160;
    for (let i = 0; i <= n; i++) {
      const t = (2 * i) / n; // beats
      const k = Math.min(1, Math.floor(t));
      const local = t - k;
      const s = Math.max(0, Math.min(1, (local - (0.5 - half)) / (2 * half)));
      const side = (j: number) => (j % 2 ? beta : -beta);
      const fork = side(k) + (side(k + 1) - side(k)) * s;
      const escape = (k + s) * step;
      const balance = -amplitude * Math.cos(Math.PI * t);
      samples.push({
        tick: i,
        values: new Map([
          ['j-balance', { angle: balance }],
          ['j-pallet', { angle: fork }],
          ['j-escape', { angle: escape }],
        ]),
      });
    }
    const r = checkCadInterferenceAlong(
      { doc, lookup, meshesOf: (h) => meshes.get(h), joints },
      samples,
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok')
      expect(
        r.hits.flatMap((h) =>
          h.findings.map((x) => `${h.tick}: ${x.a.join('/')}–${x.b.join('/')}`),
        ),
      ).toEqual([]);
  }, 600_000);
  it('holds the cased watch clear, assembled and exploded, with the hands turned', () => {
    const { assembly, lookup, solve } = w.current!;
    const clear = (doc: CadDocument) => {
      const r = checkCadInterference({
        doc,
        lookup,
        meshesOf: (h) => meshes.get(h),
        joints: solve(doc).joints,
      });
      expect(r.status).toBe('ok');
      return r.status === 'ok'
        ? [r.findings.map((x) => `${x.a.join('/')}–${x.b.join('/')}`), r.unchecked]
        : undefined;
    };
    expect(clear(assembly)).toEqual([[], []]);
    const exploded = structuredClone(assembly);
    for (const [id, values] of Object.entries(
      assembly.configurations!.find((c) => c.id === 'form-exploded')!.values,
    ))
      exploded.joints.find((j) => j.id === id)!.values = structuredClone(values);
    expect(clear(exploded)).toEqual([[], []]);
    // The hands over every hour: the escape wheel turned so the hour hand passes the fourth arbor.
    const { joints } = solve(assembly);
    const samples = Array.from({ length: 49 }, (_, i) => ({
      tick: i,
      values: new Map([['j-escape', { angle: -(i / 48) * 8640 * 2 * Math.PI }]]),
    }));
    const r = checkCadInterferenceAlong(
      { doc: assembly, lookup, meshesOf: (h) => meshes.get(h), joints },
      samples as { tick: number; values: Map<string, CadResolvedJointValues> }[],
    );
    expect(r.status).toBe('ok');
    if (r.status === 'ok')
      expect(
        r.hits.flatMap((h) =>
          h.findings.map((x) => `${h.tick}: ${x.a.join('/')}–${x.b.join('/')}`),
        ),
      ).toEqual([]);
  }, 600_000);
  it('runs a minute of the escapement in the cased watch without an overlap (WM5c, TS-1902)', () => {
    const { assembly: doc, lookup, solve } = w.current!;
    const { joints } = solve(doc);
    const e = sk01Escapement;
    const beta = e.forkAngle;
    const step = Math.PI / e.teeth;
    const amplitude = (280 * Math.PI) / 180;
    const half = Math.asin(26 / 280) / Math.PI;
    // 480 beats (60 s at 28,800 an hour), each sampled locked, at the impulse's start, middle
    // and end, and locked again: the seconds hand turns once and the escape wheel 12 times.
    const beats = 480;
    const at = [0.25, 0.5 - half, 0.5, 0.5 + half, 0.75];
    const samples: { tick: number; values: Map<string, CadResolvedJointValues> }[] = [];
    for (let k = 0; k < beats; k++)
      for (const local of at) {
        const s = Math.max(0, Math.min(1, (local - (0.5 - half)) / (2 * half)));
        const side = (j: number) => (j % 2 ? beta : -beta);
        const t = k + local;
        samples.push({
          tick: samples.length,
          values: new Map([
            ['j-balance', { angle: -amplitude * Math.cos(Math.PI * t) }],
            ['j-pallet', { angle: side(k) + (side(k + 1) - side(k)) * s }],
            ['j-escape', { angle: (k + s) * step }],
          ]),
        });
      }
    // At most `cadSweepLimits.samples` (600) a check: the minute in four checks of 15 s.
    const t0 = performance.now();
    const found: string[] = [];
    let checked = 0;
    for (let i = 0; i < samples.length; i += cadSweepLimits.samples) {
      const r = checkCadInterferenceAlong(
        { doc, lookup, meshesOf: (h) => meshes.get(h), joints },
        samples.slice(i, i + cadSweepLimits.samples),
      );
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      checked += r.samples;
      expect(r.unchecked).toEqual([]);
      for (const h of r.hits)
        for (const x of h.findings) found.push(`${h.tick}: ${x.a.join('/')}–${x.b.join('/')}`);
    }
    console.log(`${samples.length} samples in ${Math.round(performance.now() - t0)} ms`);
    expect(checked).toBe(beats * at.length);
    expect(found).toEqual([]);
  }, 1_200_000);
});
