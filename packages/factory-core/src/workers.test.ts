import { describe, expect, it } from 'vitest';
import {
  applyFactoryOperation,
  factoryWarnings,
  isFactoryDocument,
  newFactory,
  runFactory,
  validateFactory,
  type FactoryDocument,
  type FactoryObject,
  type FactoryRunResult,
  type FactoryWorkerPool,
} from './index';

const H = 3_600_000;
const c = (sec: number) => ({ type: 'const' as const, value: sec * 1000 });
const share = (r: FactoryRunResult, id: string, s: string) => {
  const o = r.objects.find((x) => x.id === id)!;
  return o.states[s as keyof typeof o.states] / (r.endMs - r.startMs);
};
const pool = (extra: Partial<FactoryWorkerPool> = {}): FactoryWorkerPool => ({
  id: 'crew',
  name: 'Crew',
  count: 1,
  skills: [],
  walkSpeedMmS: 1000,
  ...extra,
});
const station = (id: string, sec: number, x: number, extra = {}): FactoryObject => ({
  id,
  name: id,
  kind: 'station',
  processTime: c(sec),
  at: { x, y: 0 },
  ...extra,
});
function line(objects: FactoryObject[], pools: FactoryWorkerPool[], hours = 1): FactoryDocument {
  const doc = newFactory('t');
  doc.objects = [
    {
      id: 'in',
      name: 'in',
      kind: 'source',
      interval: c(1),
      mix: [{ productId: 'part', weight: 1 }],
    },
    ...objects,
    { id: 'out', name: 'out', kind: 'drain' },
  ];
  doc.links = doc.objects
    .slice(1)
    .map((o, i) => ({ id: `l${i}`, from: doc.objects[i]!.id, to: o.id }));
  doc.workerPools = pools;
  doc.run = { durationMs: hours * H, seed: 9 };
  return doc;
}

// TS-2657: FT3b workers.
describe('FT3b workers (TS-2657)', () => {
  it('a worker who never walks changes nothing but is busy while the station works', () => {
    const r = runFactory(line([station('a', 10, 0, { workers: { count: 1 } })], [pool()]));
    expect(r.produced).toBe(360);
    expect(share(r, 'a', 'unstaffed')).toBe(0);
    expect(r.workers).toEqual([
      expect.objectContaining({ poolId: 'crew', count: 1, walkShare: 0, meanWaitMs: 0 }),
    ]);
    expect(r.workers[0]!.busyShare).toBeCloseTo(1, 6);
  });

  it('one worker walking between two stations 10 m apart', () => {
    // Per part: 10 s at a, walk 10 s, 10 s at b, walk back 10 s.
    const r = runFactory(
      line(
        [
          station('a', 10, 0, { workers: { count: 1 } }),
          station('b', 10, 10_000, { workers: { count: 1 } }),
        ],
        [pool()],
      ),
      { record: true },
    );
    expect(r.produced).toBeGreaterThanOrEqual(88);
    expect(r.produced).toBeLessThanOrEqual(90);
    expect(r.workers[0]!.walkShare).toBeCloseTo(0.5, 2);
    expect(share(r, 'a', 'unstaffed')).toBeGreaterThan(0.5);
    // Every walk is recorded: from start to arrival, 10 s each after the first.
    const walks = r.timeline!.walks;
    expect(walks.length / 5).toBeGreaterThan(170);
    for (let i = 5; i < walks.length; i += 5) expect(walks[i + 1]! - walks[i]!).toBe(10_000);
    // A second worker halves the walking: each stays at one station.
    const two = runFactory(
      line(
        [
          station('a', 10, 0, { workers: { count: 1 } }),
          station('b', 10, 10_000, { workers: { count: 1 } }),
        ],
        [pool({ count: 2 })],
      ),
    );
    expect(two.produced).toBeGreaterThan(340);
  });

  it('serves only workers with the skill, and needs them all at once', () => {
    const doc = line(
      [station('a', 10, 0, { workers: { count: 2, skill: 'weld' } })],
      [pool({ id: 'helpers', count: 5 }), pool({ id: 'welders', skills: ['weld'], count: 1 })],
    );
    expect(validateFactory(doc)).toEqual([]);
    expect(factoryWarnings(doc).map((w) => w.code)).toEqual(['workers-short']);
    const r = runFactory(doc);
    expect(r.produced).toBe(0);
    expect(share(r, 'a', 'unstaffed')).toBeCloseTo(1, 6);
    const enough = {
      ...doc,
      workerPools: [doc.workerPools![0]!, { ...doc.workerPools![1]!, count: 2 }],
    };
    expect(factoryWarnings(enough)).toEqual([]);
    expect(runFactory(enough).produced).toBe(360);
  });

  it('refuses needs no pool can meet and bad pools', () => {
    const doc = line([station('a', 10, 0, { workers: { count: 1, skill: 'weld' } })], [pool()]);
    const codes = (d: unknown) => validateFactory(d).map((x) => `${x.code}@${x.path}`);
    expect(codes(doc)).toEqual(['skill-missing@$.objects.1.workers.skill']);
    // A value that is not a string is reported, never coerced (an object without toString throws).
    const odd = line([station('a', 10, 0, { workers: { count: 1, skill: 'weld' } })], [pool()]);
    const needs = odd.objects[1] as unknown as { workers: { skill: unknown } };
    needs.workers.skill = { toString: 0 };
    expect(codes(odd)).toEqual(['skill-missing@$.objects.1.workers.skill']);
    expect(validateFactory(odd)[0]!.message).toBe('no worker pool has a value of type object');
    expect(isFactoryDocument(odd)).toBe(false);
    const noPools = line([station('a', 10, 0, { workers: { count: 1 } })], []);
    delete noPools.workerPools;
    expect(codes(noPools)).toEqual(['worker-missing@$.objects.1.workers']);
    expect(codes(line([], [pool({ count: 0, walkSpeedMmS: 0, skills: ['bad '] })]))).toEqual([
      'count@$.workerPools.0.count',
      'speed@$.workerPools.0.walkSpeedMmS',
      'skill@$.workerPools.0.skills.0',
    ]);
    // Removing the last pool a station needs is refused by validation.
    const ok = line([station('a', 10, 0, { workers: { count: 1 } })], [pool()]);
    expect(() => applyFactoryOperation(ok, { type: 'removeWorkerPool', id: 'crew' })).toThrow(
      'no worker pool',
    );
  });

  it('counts only the walking inside the measured period', () => {
    // One part at 9 s; the worker walks 10 m (10 s) to the station; the run ends at 10 s.
    const late = line([station('a', 5, 10_000, { workers: { count: 1 } })], [pool()]);
    late.objects[0] = {
      ...(late.objects[0] as Extract<FactoryObject, { kind: 'source' }>),
      startMs: 9000,
      limit: 1,
    };
    late.run = { durationMs: 10_000, seed: 1 };
    expect(runFactory(late).workers[0]!.walkShare).toBeCloseTo(0.1, 9);
    // A 20 s walk from 0 s spans the whole period after a 5 s warm-up.
    const long = line([station('a', 5, 20_000, { workers: { count: 1 } })], [pool()]);
    long.objects[0] = {
      ...(long.objects[0] as Extract<FactoryObject, { kind: 'source' }>),
      limit: 1,
    };
    long.run = { durationMs: 10_000, warmupMs: 5000, seed: 1 };
    expect(runFactory(long).workers[0]!.walkShare).toBeCloseTo(1, 9);
  });

  it('a station waiting for workers is not active for the bottleneck analysis', () => {
    const r = runFactory(line([station('a', 10, 0, { workers: { count: 2 } })], [pool()]));
    expect(r.produced).toBe(0);
    expect(share(r, 'a', 'unstaffed')).toBeCloseTo(1, 6);
    expect(r.bottlenecks[0]!.share).toBe(0);
  });

  it('a request served from two pools counts its wait for both', () => {
    const doc = line(
      [station('a', 5, 0, { workers: { count: 2, skill: 'weld' } })],
      [
        pool({ id: 'near', skills: ['weld'] }),
        pool({ id: 'far', skills: ['weld'], home: { x: 10_000, y: 0 } }),
      ],
    );
    doc.objects[0] = {
      ...(doc.objects[0] as Extract<FactoryObject, { kind: 'source' }>),
      limit: 1,
    };
    const r = runFactory(doc);
    expect(r.workers.map((w) => w.meanWaitMs)).toEqual([10_000, 10_000]);
  });

  it('counts a request wait when the crew arrives inside the measured period', () => {
    const doc = line([station('a', 5, 10_000, { workers: { count: 1 } })], [pool()]);
    doc.objects[0] = {
      ...(doc.objects[0] as Extract<FactoryObject, { kind: 'source' }>),
      limit: 1,
    };
    // Asked at 0 s, arrives at 10 s: inside a period from 5 s to 25 s.
    doc.run = { durationMs: 20_000, warmupMs: 5000, seed: 1 };
    expect(runFactory(doc).workers[0]!.meanWaitMs).toBe(10_000);
    // Asked at 9 s of a 10 s run: never arrives inside it.
    const late = line([station('a', 5, 10_000, { workers: { count: 1 } })], [pool()]);
    late.objects[0] = {
      ...(late.objects[0] as Extract<FactoryObject, { kind: 'source' }>),
      startMs: 9000,
      limit: 1,
    };
    late.run = { durationMs: 10_000, seed: 1 };
    expect(runFactory(late).workers[0]!.meanWaitMs).toBe(0);
  });
});
