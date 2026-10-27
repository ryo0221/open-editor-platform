import { describe, expect, it } from 'vitest';
import { expandAssembly } from './assembly';
import { CadAssemblyPort, type CadPartKernelPort } from './assembly-port';
import type { CadEvaluateRequest, CadEvaluation } from './coordinator';
import { r2bJoints } from './joints-fixtures';
import { cadContentHash } from './operations';
import { f23, r2bScale } from './scale-fixtures';
import { validateCad } from './validation';
import type { CadDocument } from './model';

const ok = (request: CadEvaluateRequest): CadEvaluation => ({
  status: 'ok',
  contentHash: request.candidateHash,
  buildHash: request.document.kernelProfile.buildHash,
  geometryDigest: `d ${request.candidateHash}`,
  bodies: {},
});
/** A kernel whose part jobs wait until released, recording each one's content hash. */
function heldKernel() {
  const jobs: string[] = [];
  const cancelled: string[] = [];
  let release: (() => void)[] = [];
  let hold = false;
  const kernel: CadPartKernelPort = {
    evaluate: async (request) => ok(request),
    evaluatePart: async (request) => {
      jobs.push(request.candidateHash);
      if (hold) await new Promise<void>((r) => release.push(r));
      return ok(request);
    },
    cancel: (id) => void cancelled.push(id),
  };
  return {
    kernel,
    jobs,
    cancelled,
    hold: (on: boolean) => (hold = on),
    release: () => {
      const r = release;
      release = [];
      for (const f of r) f();
    },
  };
}
const request = (document: CadDocument, requestId: string): CadEvaluateRequest => ({
  requestId,
  generation: 0,
  baseHash: cadContentHash(document),
  candidateHash: cadContentHash(document),
  document,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('F23 and parts evaluated after the result (R2b-4, CAD50)', () => {
  const f = r2bScale();
  const lookup = (h: string) => f.closure.get(h);

  it('places 300 kinds of bracket 1,000 times, nested three deep', () => {
    expect(validateCad(f.assembly)).toEqual([]);
    const { occurrences, versions, limit } = expandAssembly(f.assembly, lookup);
    expect(limit).toBeUndefined();
    const brackets = new Set(f.brackets.map((b) => b.contentHash));
    const placed = occurrences.filter((o) => brackets.has(o.part.source.contentHash));
    expect(placed).toHaveLength(f23.instances);
    expect(new Set(placed.map((o) => o.part.source.contentHash)).size).toBe(f23.kinds);
    // The assembly › a bay › a module › a bracket.
    expect(Math.max(...placed.map((o) => o.path.length))).toBe(3);
    expect(versions.size).toBe(f23.kinds + f23.modules + f23.bays);
  });

  it('returns before the parts no joint reads, then evaluates each version once, in order', async () => {
    const k = heldKernel();
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: lookup, background: true });
    const first = f.brackets.at(-1)!.contentHash;
    port.order = (hashes) => [...hashes].sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
    let progress = 0;
    port.subscribe(() => progress++);
    const result = await port.evaluate(request(f.assembly, 'r1'));
    if (result.status !== 'ok') throw new Error(result.status);
    // Nothing waited for a part: every version is left to the background.
    expect(Object.keys(result.assembly!.versions)).toEqual([]);
    expect(result.assembly!.pending).toHaveLength(f23.kinds + f23.modules + f23.bays);
    await port.idle();
    expect(k.jobs[0]).toBe(first);
    expect(k.jobs).toHaveLength(f23.kinds + f23.modules + f23.bays);
    expect(new Set(k.jobs).size).toBe(k.jobs.length);
    expect(progress).toBeGreaterThanOrEqual(k.jobs.length);
    // The same as one evaluation of every part without the background (CAD50: 全体評価との一致).
    const whole = await new CadAssemblyPort({
      kernel: heldKernel().kernel,
      parts: lookup,
    }).evaluate(request(f.assembly, 'r-whole'));
    if (whole.status !== 'ok') throw new Error(whole.status);
    for (const hash of result.assembly!.pending!)
      expect(port.version(hash)).toEqual(whole.assembly!.versions[hash]);
    // Evaluated again, every version is cached: none is pending, no part job is sent.
    const again = await port.evaluate(request(f.assembly, 'r2'));
    expect(again.status === 'ok' && again.assembly!.pending).toBeFalsy();
    expect(k.jobs).toHaveLength(f23.kinds + f23.modules + f23.bays);
  });

  it('stops between parts for a newer request or a cancel, and resumes where it stopped', async () => {
    const k = heldKernel();
    const port = new CadAssemblyPort({ kernel: k.kernel, parts: lookup, background: true });
    k.hold(true);
    const result = await port.evaluate(request(f.assembly, 'r1'));
    await tick();
    expect(k.jobs).toHaveLength(1);
    // A newer request: the running part job finishes and is kept; no other starts.
    const newer = port.evaluate(request(f.assembly, 'r2'));
    k.release();
    await newer;
    await tick();
    expect(port.version(k.jobs[0]!)?.state).toBe('available');
    // r2 left the rest pending and started its own run; a cancel stops it and its job.
    expect(k.jobs).toHaveLength(2);
    port.cancel('r2');
    expect(k.cancelled).toContain(`r2/later/part/${k.jobs[1]}`);
    k.release();
    await port.idle();
    await tick();
    expect(k.jobs).toHaveLength(2);
    // History returns to r1's result: its pending versions not yet evaluated go on.
    k.hold(false);
    expect(port.resume(f.assembly, result)).toBe(true);
    await port.idle();
    expect(k.jobs).toHaveLength(f23.kinds + f23.modules + f23.bays);
    expect(new Set(k.jobs).size).toBe(k.jobs.length);
    expect(port.resume(f.assembly, result)).toBe(false);
  });

  it('waits for the parts a joint reads, and leaves the others to the background', async () => {
    const j = r2bJoints();
    const k = heldKernel();
    const port = new CadAssemblyPort({
      kernel: k.kernel,
      parts: (h) => j.closure.get(h),
      background: true,
    });
    const result = await port.evaluate(request(j.assembly, 'r1'));
    if (result.status !== 'ok') throw new Error(result.status);
    const read = new Set(Object.keys(result.assembly!.versions));
    expect(read.size).toBeGreaterThan(0);
    // The joints solve as when every part waits for them.
    const whole = await new CadAssemblyPort({
      kernel: heldKernel().kernel,
      parts: (h) => j.closure.get(h),
    }).evaluate(request(j.assembly, 'r-whole'));
    if (whole.status !== 'ok') throw new Error(whole.status);
    expect(result.assembly!.joints).toEqual(whole.assembly!.joints);
    expect(result.assembly!.poses).toEqual(whole.assembly!.poses);
    for (const hash of result.assembly!.pending ?? []) expect(read.has(hash)).toBe(false);
    await port.idle();
  });
});
