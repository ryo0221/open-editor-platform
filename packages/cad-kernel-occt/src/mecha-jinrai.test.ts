import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  cadContentHash,
  checkCadInterference,
  checkCadInterferenceAlong,
  jinraiRobot,
  jinraiTransform,
  jointValues,
  parameterValues,
  solveJoints,
  type CadDocument,
  type CadInterferenceMesh,
  type CadResolvedJointValues,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

type Values = Map<string, CadResolvedJointValues>;
type Stage = (typeof jinraiTransform.stages)[number];

/** A cubic Bézier easing at linear progress `t`, as the character player samples a key. */
function eased(e: { x1: number; y1: number; x2: number; y2: number }, t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const curve = (s: number, a: number, b: number) =>
    3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  let [low, high] = [0, 1];
  for (let i = 0; i < 52; i++) {
    const mid = (low + high) / 2;
    if (curve(mid, e.x1, e.x2) < t) low = mid;
    else high = mid;
  }
  return curve((low + high) / 2, e.y1, e.y2);
}
/** Each step played backwards: from its `to` form to its `from`, each group at the mirrored time. */
const reversed = (s: Stage) => ({
  ...s,
  from: s.to,
  to: s.from,
  groups: s.groups.map((g) => ({ ...g, start: s.seconds - g.start - g.length })),
});

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('D8 迅雷 transforming with kernel meshes (ST-407, TS-1721)', () => {
  const f = { current: undefined as ReturnType<typeof jinraiRobot> | undefined };
  const meshes = new Map<string, CadInterferenceMesh[]>();
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
    const robot = jinraiRobot({ id: 'occt', buildHash });
    let n = 0;
    for (const [hash, doc] of robot.closure) {
      const requestId = `jinrai-${n++}`;
      await handle({
        type: 'evaluate',
        requestId,
        generation: 1,
        baseHash: '',
        candidateHash: cadContentHash(doc as CadDocument),
        document: doc as CadDocument,
      } as CadWorkerRequest);
      const m = posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      );
      if (m?.type !== 'result' || m.evaluation.status !== 'ok') throw new Error(JSON.stringify(m));
      meshes.set(
        hash,
        m.meshes.map((x) => ({
          bodyId: x.bodyId,
          origin: [...x.origin] as [number, number, number],
          positions: [...x.positions],
          indices: [...x.indices],
        })),
      );
    }
    f.current = robot;
  }, 600_000);

  it('holds every form clear of overlaps', () => {
    const { assembly: doc, closure } = f.current!;
    const lookup = (h: string) => closure.get(h);
    const { joints } = solveJoints(
      doc,
      parameterValues(doc),
      lookup,
      () => undefined,
      () => true,
    );
    for (const form of doc.configurations!) {
      const r = checkCadInterference({ doc, lookup, meshesOf: (h) => meshes.get(h), joints, form });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect([form.name, r.findings, r.stale]).toEqual([form.name, [], []]);
    }
  });

  it('transforms both ways without an overlap or a jump at any 0.05 s, eased', () => {
    const { assembly: doc0, closure } = f.current!;
    const lookup = (h: string) => closure.get(h);
    const params = parameterValues(doc0);
    const form = (name: string) => doc0.configurations!.find((c) => c.name === name)!;
    const values = (name: string): Values =>
      new Map(
        doc0.joints
          .filter((j) => form(name).values[j.id])
          .map((j) => [
            j.id,
            jointValues({ type: j.type, values: form(name).values[j.id]! }, params),
          ]),
      );
    const mounts = (name: string) => new Map(Object.entries(form(name).mounts ?? {}));
    const at = (a: Values, b: Values, groups: Stage['groups'], t: number): Values => {
      const out = new Map(a);
      for (const g of groups) {
        const s = eased(g.easing, (t - g.start) / g.length);
        for (const j of g.joints) {
          const [from, to] = [a.get(j)!, b.get(j)!];
          out.set(
            j,
            Object.fromEntries(
              Object.keys(from).map((k) => {
                const key = k as keyof CadResolvedJointValues;
                return [k, from[key]! + (to[key]! - from[key]!) * s];
              }),
            ),
          );
        }
      }
      return out;
    };
    const problems: string[] = [];
    for (const forward of jinraiTransform.stages) {
      for (const [s, switchAt] of [
        [forward, 'start'],
        [reversed(forward), 'end'],
      ] as const) {
        // The robot as the step finds it: in its first form's mounts, its poses solved so.
        const before = mounts(s.from);
        const placed = {
          ...doc0,
          mounts: doc0.mounts!.map((m) => ({ ...m, active: before.get(m.id) ?? m.active })),
        };
        const solved = solveJoints(
          placed,
          params,
          lookup,
          () => undefined,
          () => true,
        );
        const doc = { ...placed, solvedPoses: solved.poses };
        const [a, b] = [values(s.from), values(s.to)];
        const [ma, mb] = [mounts(s.from), mounts(s.to)];
        const n = Math.round(s.seconds * 20);
        const samples = Array.from({ length: n + 1 }, (_, i) => ({
          tick: i * 2 + 1,
          values: at(a, b, s.groups, i / 20),
          mounts: switchAt === 'start' ? mb : ma,
        }));
        // The other side of the switch, a tick before or after the sample at its time.
        const edge = switchAt === 'start' ? samples[0]! : samples[n]!;
        samples.push({
          ...edge,
          tick: switchAt === 'start' ? 0 : n * 2 + 2,
          mounts: switchAt === 'start' ? ma : mb,
        });
        const r = checkCadInterferenceAlong(
          { doc, lookup, meshesOf: (h) => meshes.get(h), joints: solved.joints },
          samples,
        );
        const step = `${s.from}→${s.to}`;
        if (r.status !== 'ok') {
          problems.push(`${step}: ${r.code}`);
          continue;
        }
        const time = (tick: number) => Math.max(0, Math.min(n, (tick - 1) / 2)) / 20;
        problems.push(
          ...r.hits.flatMap((h) =>
            h.findings.map((x) => `${step} ${time(h.tick)}: ${x.a.join('/')}–${x.b.join('/')}`),
          ),
          ...r.jumps.map((j) => `${step} ${time(j.tick)}: ${j.mount} jumps ${j.mm.toFixed(2)} mm`),
        );
      }
    }
    expect(problems).toEqual([]);
  }, 600_000);
});
