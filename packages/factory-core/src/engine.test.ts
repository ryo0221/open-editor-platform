import { describe, expect, it } from 'vitest';
import {
  activePeriodBottlenecks,
  f170SmallLine,
  factoryStates,
  factoryWarnings,
  newFactory,
  runFactory,
  validateFactory,
  type FactoryDocument,
  type FactoryObject,
  type FactoryRunResult,
} from './index';

const s = (sec: number) => sec * 1000;
const H = 3_600_000;
const c = (sec: number) => ({ type: 'const' as const, value: s(sec) });
const src = (id: string, sec: number, productId = 'part', extra = {}): FactoryObject => ({
  id,
  name: id,
  kind: 'source',
  interval: c(sec),
  mix: [{ productId, weight: 1 }],
  ...extra,
});
const st = (id: string, sec: number): FactoryObject => ({
  id,
  name: id,
  kind: 'station',
  processTime: c(sec),
});
const drain = (id = 'out'): FactoryObject => ({ id, name: id, kind: 'drain' });
/** A chain of objects linked in order. */
function line(objects: FactoryObject[], hours = 10, extra: Partial<FactoryDocument> = {}) {
  const doc = newFactory('t');
  doc.objects = objects;
  doc.links = objects.slice(1).map((o, i) => ({
    id: `l${i}`,
    from: objects[i]!.id,
    to: o.id,
  }));
  doc.run = { durationMs: hours * H, seed: 7 };
  return { ...doc, ...extra };
}
const obj = (r: FactoryRunResult, id: string) => r.objects.find((o) => o.id === id)!;
const frac = (r: FactoryRunResult, id: string) => {
  const o = obj(r, id);
  const total = r.endMs - r.startMs;
  return Object.fromEntries(factoryStates.map((k) => [k, o.states[k] / total]));
};

describe('FT1a factory run (TS-2650)', () => {
  it('F170 is valid, complete, deterministic per seed and keeps its books', () => {
    const doc = f170SmallLine();
    expect(validateFactory(doc)).toEqual([]);
    expect(factoryWarnings(doc)).toEqual([]);
    const a = runFactory(doc);
    expect(runFactory(doc)).toEqual(a);
    const b = runFactory(doc, { seed: 2 });
    expect(b.leadTime.meanMs).not.toBe(a.leadTime.meanMs);
    expect(a.startMs).toBe(H);
    expect(a.endMs).toBe(9 * H);
    // Supply is one housing a minute; the line keeps up.
    expect(a.throughputPerHour).toBeGreaterThan(57);
    expect(a.throughputPerHour).toBeLessThanOrEqual(61);
    expect(a.producedByProduct).toEqual({ eaxle: a.produced });
    for (const o of a.objects) {
      const sum = factoryStates.reduce((t, k) => t + o.states[k], 0);
      expect(sum).toBeCloseTo(8 * H, 3);
    }
    // The test station is busiest, so it leads the bottleneck list.
    expect(a.bottlenecks.map((x) => x.id)).toEqual(['test', 'assembly', 'machining']);
    expect(frac(a, 'test').working).toBeGreaterThan(0.85);
    expect(a.assembled).toBeGreaterThan(a.produced - 3);
  });

  it('a constant line gives the exact rate, working share and lead time', () => {
    const r = runFactory(line([src('in', 10), st('a', 8), drain()]));
    expect(r.produced).toBe(3600);
    expect(r.throughputPerHour).toBe(360);
    expect(frac(r, 'a').working).toBeCloseTo(0.8, 3);
    expect(frac(r, 'a').waiting).toBeCloseTo(0.2, 3);
    expect(r.leadTime).toMatchObject({ count: 3600, meanMs: s(8), minMs: s(8), maxMs: s(8) });
  });

  it('a slow station blocks the ones before it and starves the ones after it', () => {
    const r = runFactory(line([src('in', 1), st('a', 5), st('b', 9), st('c', 3), drain()]));
    expect(r.throughputPerHour).toBeCloseTo(400, 0);
    expect(frac(r, 'b').working).toBeCloseTo(1, 2);
    expect(frac(r, 'a').blocked).toBeCloseTo(4 / 9, 2);
    expect(frac(r, 'c').waiting).toBeCloseTo(6 / 9, 2);
    expect(frac(r, 'in').blocked).toBeGreaterThan(0.85);
    expect(r.bottlenecks[0]!.id).toBe('b');
    expect(r.bottlenecks[0]!.share).toBeGreaterThan(0.99);
  });

  it('a buffer decouples a variable station from its neighbour', () => {
    const variable: FactoryObject = {
      id: 'a',
      name: 'a',
      kind: 'station',
      processTime: { type: 'exponential', mean: s(9) },
    };
    const without = runFactory(line([src('in', 1), variable, st('b', 9), drain()], 200));
    const withBuffer = runFactory(
      line(
        [
          src('in', 1),
          variable,
          { id: 'q', name: 'q', kind: 'buffer', capacity: 20 },
          st('b', 9),
          drain(),
        ],
        200,
      ),
    );
    expect(withBuffer.throughputPerHour).toBeGreaterThan(without.throughputPerHour + 30);
    expect(obj(withBuffer, 'q').maxContent).toBeGreaterThan(5);
  });

  it('a parallel station runs its places at once', () => {
    const r = runFactory(
      line([
        src('in', 10),
        { id: 'p', name: 'p', kind: 'parallel', count: 3, processTime: c(30) },
        drain(),
      ]),
    );
    expect(r.throughputPerHour).toBeCloseTo(360, 0);
    expect(frac(r, 'p').working).toBeGreaterThan(0.99);
    expect(obj(r, 'p').maxContent).toBe(3);
    const two = runFactory(
      line([
        src('in', 10),
        { id: 'p', name: 'p', kind: 'parallel', count: 2, processTime: c(30) },
        drain(),
      ]),
    );
    expect(two.throughputPerHour).toBeCloseTo(240, 0);
  });

  it('conveyors: travel time, spacing, accumulation and a stopping belt', () => {
    const belt = (accumulating: boolean): FactoryObject => ({
      id: 'belt',
      name: 'belt',
      kind: 'conveyor',
      lengthMm: 4000,
      speedMmS: 400,
      partLengthMm: 1000,
      accumulating,
    });
    // One part every 20 s: 10 s on the belt, no waiting.
    const free = runFactory(line([src('in', 20), belt(true), drain()]));
    expect(free.leadTime.meanMs).toBe(s(10));
    // Parts every second, but the belt takes one per 2.5 s (1 m apart at 0.4 m/s).
    const dense = runFactory(line([src('in', 1), belt(true), drain()]));
    expect(dense.throughputPerHour).toBeCloseTo(3600 / 2.5, 0);
    expect(obj(dense, 'belt').maxContent).toBe(4);
    // A slow station after the belt: an accumulating belt queues 4, a stopping one fewer.
    const acc = runFactory(line([src('in', 5), belt(true), st('a', 20), drain()]));
    const stop = runFactory(line([src('in', 5), belt(false), st('a', 20), drain()]));
    expect(acc.throughputPerHour).toBeCloseTo(180, 0);
    expect(stop.throughputPerHour).toBeCloseTo(180, 0);
    expect(obj(acc, 'belt').maxContent).toBe(4);
    expect(obj(stop, 'belt').meanContent).toBeLessThan(obj(acc, 'belt').meanContent);
    expect(frac(stop, 'belt').blocked).toBeGreaterThan(0.5);
  });

  it('an assembly consumes its components and renames the main part', () => {
    const doc = newFactory('asm');
    doc.products = [
      { id: 'body', name: 'Body' },
      { id: 'screw', name: 'Screw' },
      { id: 'unit', name: 'Unit' },
    ];
    doc.objects = [
      src('bodies', 20, 'body'),
      src('screws', 4, 'screw'),
      {
        id: 'asm',
        name: 'asm',
        kind: 'assembly',
        mainProductId: 'body',
        components: [{ productId: 'screw', count: 4 }],
        processTime: c(10),
        outputProductId: 'unit',
      },
      drain(),
    ];
    doc.links = [
      { id: 'a', from: 'bodies', to: 'asm' },
      { id: 'b', from: 'screws', to: 'asm' },
      { id: 'c', from: 'asm', to: 'out' },
    ];
    doc.run = { durationMs: 10 * H, seed: 1 };
    const r = runFactory(doc);
    expect(r.producedByProduct).toEqual({ unit: r.produced });
    // The assembly takes nothing while it works: after each unit the screw held at the source
    // enters at once and three more follow 4 s apart, so a unit takes 12 s + 10 s.
    expect(r.throughputPerHour).toBeCloseTo(3600 / 22, 0);
    expect(r.assembled).toBe(4 * r.produced);
    expect(frac(r, 'asm').working).toBeCloseTo(10 / 22, 2);
  });

  it('exit strategies and product filters route parts', () => {
    const doc = newFactory('route');
    doc.products = [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' },
    ];
    doc.objects = [
      {
        id: 'in',
        name: 'in',
        kind: 'source',
        interval: c(10),
        mix: [
          { productId: 'x', weight: 1 },
          { productId: 'y', weight: 3 },
        ],
      },
      { id: 'split', name: 'split', kind: 'buffer', capacity: 10, exit: 'cyclic' },
      st('a', 1),
      st('b', 1),
      { id: 'sort', name: 'sort', kind: 'buffer', capacity: 10 },
      drain('only-x'),
      drain('only-y'),
    ];
    doc.links = [
      { id: 'l1', from: 'in', to: 'split' },
      { id: 'l2', from: 'split', to: 'a' },
      { id: 'l3', from: 'split', to: 'b' },
      { id: 'l4', from: 'a', to: 'sort' },
      { id: 'l5', from: 'b', to: 'sort' },
      { id: 'l6', from: 'sort', to: 'only-x', productIds: ['x'] },
      { id: 'l7', from: 'sort', to: 'only-y', productIds: ['y'] },
    ];
    doc.run = { durationMs: 10 * H, seed: 3 };
    const r = runFactory(doc);
    expect(obj(r, 'a').entered - obj(r, 'b').entered).toBeLessThanOrEqual(1);
    const x = obj(r, 'only-x').entered;
    const y = obj(r, 'only-y').entered;
    expect(x + y).toBe(r.produced);
    expect(y / (x + y)).toBeGreaterThan(0.7);
    expect(y / (x + y)).toBeLessThan(0.8);
    // first-free always tries a first; least-busy picks the emptier.
    const first = runFactory({
      ...doc,
      objects: doc.objects.map((o) => (o.id === 'split' ? { ...o, exit: 'first-free' } : o)),
    });
    expect(obj(first, 'b').entered).toBe(0);
  });

  it('a buffer hands on only its head (FIFO) or top (LIFO)', () => {
    // A then B arrive; only B may leave. FIFO holds B behind A; LIFO lets B (the top) go.
    const doc = newFactory('order');
    doc.products = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    doc.objects = [
      src('in-a', 1, 'a', { limit: 1 }),
      src('in-b', 1, 'b', { limit: 1, startMs: 500 }),
      { id: 'buf', name: 'buf', kind: 'buffer', capacity: 10 },
      drain(),
    ];
    doc.links = [
      { id: 'l1', from: 'in-a', to: 'buf' },
      { id: 'l2', from: 'in-b', to: 'buf' },
      { id: 'l3', from: 'buf', to: 'out', productIds: ['b'] },
    ];
    doc.run = { durationMs: H, seed: 1 };
    expect(runFactory(doc).produced).toBe(0);
    const lifo = {
      ...doc,
      objects: doc.objects.map((o) => (o.kind === 'buffer' ? { ...o, order: 'lifo' as const } : o)),
    };
    expect(runFactory(lifo).produced).toBe(1);
  });

  it('counts products named like object properties', () => {
    const doc = line([src('in', 60, 'toString'), drain()], 1);
    doc.products = [{ id: 'toString', name: 'T' }];
    const r = runFactory(doc);
    expect(r.producedByProduct).toEqual({ toString: 61 });
  });

  it('keeps one active period across a same-instant handoff', () => {
    // The station is never idle: one period over the whole run, not one per part.
    const doc = line([src('in', 1), st('m', 10), drain()], 1);
    const r = runFactory(doc);
    const m = r.bottlenecks.find((b) => b.id === 'm')!;
    expect(m.meanActiveMs).toBe(H);
    expect(m.soleMs).toBe(H);
  });

  it('the warm-up resets the statistics; a source limit stops it', () => {
    const doc = line([src('in', 10, 'part', { limit: 100 }), st('a', 5), drain()], 1);
    const r = runFactory(doc, { warmupMs: s(500) });
    expect(r.startMs).toBe(s(500));
    // Part k is made at 10k s and leaves at 10k + 5 s; the first 50 left before 500 s.
    expect(r.produced).toBe(50);
    expect(frac(r, 'in').waiting).toBeGreaterThan(0.8);
  });

  it('refuses invalid documents and runs that exceed the event limit', () => {
    const doc = line([src('in', 1), st('a', 0), drain()]);
    expect(() => runFactory(doc, { maxEvents: 100 })).toThrow(/more than 100 events/);
    const bad = line([src('in', 1), st('a', 1), drain()]);
    bad.links.push({ id: 'back', from: 'out', to: 'a' });
    expect(() => runFactory(bad)).toThrow('a drain has no exit');
  });
});

describe('FT1a active-period bottlenecks (TS-2650)', () => {
  it('splits sole and shifting time where the longest periods change', () => {
    const r = activePeriodBottlenecks(
      [
        { id: 'a', periods: [0, 10, 20, 30] },
        { id: 'b', periods: [5, 25] },
      ],
      30,
    );
    const a = r.find((x) => x.id === 'a')!;
    const b = r.find((x) => x.id === 'b')!;
    // a leads 0–5 (only one active), b (20 long) leads 5–25, a again 25–30. Where the winners'
    // periods overlap (5–10, 20–25) both are the bottleneck: shifting time for both.
    expect(a).toMatchObject({ soleMs: 10, shiftingMs: 10 });
    expect(b).toMatchObject({ soleMs: 10, shiftingMs: 10 });
    expect(a.share).toBeCloseTo(20 / 30, 9);
    expect(b.share).toBeCloseTo(20 / 30, 9);
    // Same share: the longer mean period ranks first.
    expect(r[0]!.id).toBe('b');
  });

  it('counts a shift for both bottlenecks without losing sole time', () => {
    const r = activePeriodBottlenecks(
      [
        { id: 'a', periods: [0, 10] },
        { id: 'b', periods: [5, 20] },
      ],
      20,
    );
    expect(r.find((x) => x.id === 'a')).toMatchObject({ soleMs: 5, shiftingMs: 5, share: 0.5 });
    expect(r.find((x) => x.id === 'b')).toMatchObject({ soleMs: 10, shiftingMs: 5, share: 0.75 });
  });

  it('reports references that are not strings without coercing them', () => {
    const doc = structuredClone(line([src('in', 10), st('a', 5), drain()])) as unknown as {
      objects: { mix?: { productId: unknown }[] }[];
      links: { from: unknown }[];
    };
    doc.objects[0]!.mix![0]!.productId = { toString: null };
    doc.links[0]!.from = { toString: null };
    const codes = validateFactory(doc).map((d) => d.code);
    expect(codes).toContain('product-missing');
    expect(codes).toContain('object-missing');
  });
});
