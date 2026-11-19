/**
 * FT4b (docs/cad/factory-twin.md): what the factory looks like at a moment of a recorded run.
 * Replay only reads the timeline (FT1b): each object's state, the parts in it (and how far along a
 * conveyor), each vehicle on its lane and each worker on the way or at work. Nothing is
 * simulated again, and nothing collides in 3D (FT-U: positions are interpolated from the record).
 */
import { factoryStates, type FactoryState, type FactoryTimeline } from './engine';
import type { FactoryDocument, FactoryPlacement } from './model';

/** Which state an object shows when its places differ: the first of these any place is in. */
const shownOrder: readonly FactoryState[] = [
  'failed',
  'setup',
  'working',
  'unstaffed',
  'transport',
  'blocked',
  'held',
  'paused',
  'waiting',
];
// A state not listed shows after every listed one (never over a failure).
const rank = factoryStates.map((s) =>
  shownOrder.includes(s) ? shownOrder.indexOf(s) : shownOrder.length,
);

export interface FactoryReplayPart {
  part: number;
  /** Product index into `doc.products` (it changes at an assembly). */
  product: number;
  /** Object index. */
  object: number;
  /** On a conveyor: 0 at its start to 1 at its end. */
  along?: number;
}
export interface FactoryReplayVehicle {
  fleet: number;
  vehicle: number;
  x: number;
  y: number;
  /** Direction of travel (or of its last drive), radians from +x. */
  heading: number;
  driving: boolean;
  loaded: boolean;
}
export interface FactoryReplayWorker {
  pool: number;
  worker: number;
  x: number;
  y: number;
  heading: number;
  walking: boolean;
}
export interface FactoryReplayFrame {
  timeMs: number;
  /** Per object, the state index into `factoryStates` it shows (-1 before it has any). */
  states: number[];
  parts: FactoryReplayPart[];
  vehicles: FactoryReplayVehicle[];
  workers: FactoryReplayWorker[];
}

/** A part's stay in one object: `[enter, leave, part, product, object]` (leave = Infinity). */
type Stay = [number, number, number, number, number];
/** Stays per checkpoint of the part index. */
const checkpointEvery = 512;
/** States in which a non-accumulating conveyor's belt stands still (a blocked head). */
/** Last index `i` with `starts(i) <= t` among `n` sorted entries, or -1. */
function lastAtOrBefore(n: number, starts: (i: number) => number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts(mid) <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The replay of one recorded run. `places` gives each object's position (its `at`, or where the
 * plan puts it); vehicles drive between path nodes, workers walk between objects (from their
 * pool's home).
 */
export class FactoryReplay {
  readonly startMs = 0;
  readonly endMs: number;
  private readonly states: number[][][][];
  /** Part stays by start; at every `checkpointEvery`-th, the stays still open when it starts. */
  private readonly stays: Stay[] = [];
  private readonly checkpoints: Stay[][] = [];
  /** Per non-accumulating conveyor (object index): its stopped intervals, and their sums. */
  private readonly stopped = new Map<number, { from: number[]; to: number[]; before: number[] }>();
  /** Per accumulating conveyor (object index): the times parts left it, in order. */
  private readonly leaves = new Map<number, number[]>();
  private readonly drives: number[][][][];
  /**
   * Per fleet and vehicle, in time order: `[from, until, part]` while it holds a part, from the
   * start of its loading to the part's arrival (through driving, unloading and waits);
   * `until` is Infinity for a part not delivered (the run, or its recording, ended on the way).
   */
  private readonly holds: number[][][][];
  private readonly walks: number[][][][];
  private readonly nodes: Map<string, { x: number; y: number }>;

  constructor(
    private readonly doc: FactoryDocument,
    timeline: FactoryTimeline,
    private readonly places: ReadonlyMap<string, FactoryPlacement>,
    endMs: number,
  ) {
    // A truncated recording is replayed only as far as it is complete.
    this.endMs = Math.min(endMs, timeline.recordedUntilMs ?? Infinity);
    // States: per object and place, its intervals in time order.
    this.states = timeline.states.map((rows) => {
      const out: number[][][] = [];
      for (let k = 0; k + 3 < rows.length; k += 4)
        (out[rows[k + 3]!] ??= []).push(rows.slice(k, k + 4));
      for (const p of out) p?.sort((a, b) => a[0]! - b[0]!);
      return out.filter(Boolean);
    });
    // Parts: each stay in one object, in order of its start (the moves are in time order).
    const open = new Map<number, Stay>();
    const stays = this.stays;
    const m = timeline.moves;
    for (let k = 0; k + 4 < m.length; k += 5) {
      const [time, part, product, , to] = m.slice(k, k + 5) as [
        number,
        number,
        number,
        number,
        number,
      ];
      const was = open.get(part);
      if (was) was[1] = time;
      open.delete(part);
      if (to < 0 || doc.objects[to]?.kind === 'drain') continue;
      const stay: Stay = [time, Infinity, part, product, to];
      stays.push(stay);
      open.set(part, stay);
    }
    // Checkpoints: memory grows with the parts in the model at each, never with the run's length.
    const live = new Set<Stay>();
    stays.forEach((s, i) => {
      if (i % checkpointEvery === 0) {
        for (const x of live) if (x[1] <= s[0]) live.delete(x);
        this.checkpoints.push([...live]);
      }
      live.add(s);
    });
    // A conveyor's belt stands while the engine stopped it (a non-accumulating belt whose head is
    // held back, or any belt whose motor is off): its parts stand with it.
    const belts = new Map<number, number[][]>();
    const b = timeline.belts;
    for (let k = 0; k + 2 < b.length; k += 3) {
      const [time, object, stop] = [b[k]!, b[k + 1]!, b[k + 2]!];
      const rows = belts.get(object) ?? [];
      if (stop) rows.push([time, Infinity]);
      else if (rows.length && rows[rows.length - 1]![1] === Infinity)
        rows[rows.length - 1]![1] = time;
      belts.set(object, rows);
    }
    for (const [object, rows] of belts) {
      const before: number[] = [];
      let sum = 0;
      for (const r of rows) {
        before.push(sum);
        sum += Math.min(r[1]!, this.endMs) - r[0]!;
      }
      this.stopped.set(object, {
        from: rows.map((r) => r[0]!),
        to: rows.map((r) => r[1]!),
        before,
      });
    }
    // Vehicles and workers: their own rows in time order.
    const fleets = doc.fleets ?? [];
    this.drives = fleets.map((f) => Array.from({ length: f.count }, (): number[][] => []));
    const d = timeline.drives;
    for (let k = 0; k + 6 < d.length; k += 7)
      this.drives[d[k + 2]!]?.[d[k + 3]!]?.push(d.slice(k, k + 7));
    // Holds, one per leg: a part is on its vehicle from the moment the vehicle starts loading it
    // until the stay it was picked up from ends (its arrival at that leg's destination), through
    // driving, unloading and waits; a trip whose ends share a path node drives no segment at all.
    // A part carried again later (another vehicle-backed link) starts a new leg.
    // Each part's stays in each object, by start (a part is in one place at a time, so the
    // stay covering a time is the last one starting by then, if it has not ended).
    const staysOf = new Map<string, Stay[]>();
    for (const st of stays) {
      const key = `${st[2]},${st[4]}`;
      const l = staysOf.get(key) ?? [];
      l.push(st);
      staysOf.set(key, l);
    }
    for (const l of staysOf.values()) l.sort((a, b) => a[0] - b[0]);
    this.holds = this.drives.map((fleet) => fleet.map((): number[][] => []));
    const pickups = new Map<number, number[]>();
    const ld = timeline.loads;
    for (let k = 0; k + 4 < ld.length; k += 5) {
      const [at, f, v, part, from] = [ld[k]!, ld[k + 1]!, ld[k + 2]!, ld[k + 3]!, ld[k + 4]!];
      const rows = this.holds[f]?.[v];
      if (!rows) continue;
      // The stay in the object it is picked up from, ending at or after then (a trip with no
      // loading, unloading or drive leaves at the instant it arrived).
      const own = staysOf.get(`${part},${from}`) ?? [];
      const last = own[lastAtOrBefore(own.length, (j) => own[j]![0], at)];
      const pick = last && at <= last[1] ? last : undefined;
      // A delivery not recorded (the run ended, or its recording was cut, on the way): the
      // vehicle still holds the part at the end of the replay.
      const until = pick ? pick[1] : Infinity;
      rows.push([at, until, part]);
      const p = pickups.get(part) ?? [];
      p.push(at);
      pickups.set(part, p);
    }
    for (const fleet of this.holds) for (const rows of fleet) rows.sort((a, b) => a[0]! - b[0]!);
    for (const p of pickups.values()) p.sort((a, b) => a - b);
    // An accumulating conveyor's queue closes up behind a leaving head at the belt's speed.
    for (const st of stays) {
      const o = doc.objects[st[4]];
      if (o?.kind !== 'conveyor' || !o.accumulating) continue;
      // A vehicle takes the part off the belt when its leg starts, not when it arrives (also
      // when the arrival is past the end of the run).
      const p = pickups.get(st[2]) ?? [];
      let [first, hi] = [0, p.length];
      while (first < hi) {
        const mid = (first + hi) >> 1;
        if (p[mid]! < st[0]) first = mid + 1;
        else hi = mid;
      }
      const left = first < p.length && p[first]! < st[1] ? p[first]! : st[1];
      if (left === Infinity) continue;
      const l = this.leaves.get(st[4]) ?? [];
      l.push(left);
      this.leaves.set(st[4], l);
    }
    for (const l of this.leaves.values()) l.sort((a, b) => a - b);
    const pools = doc.workerPools ?? [];
    this.walks = pools.map((p) => Array.from({ length: p.count }, (): number[][] => []));
    const w = timeline.walks;
    for (let k = 0; k + 4 < w.length; k += 5)
      this.walks[w[k + 2]!]?.[w[k + 3]!]?.push(w.slice(k, k + 5));
    this.nodes = new Map((doc.paths?.nodes ?? []).map((n) => [n.id, n]));
  }

  /** Time the conveyor's belt has run by `t` (a non-accumulating one stands while blocked). */
  private beltTime(object: number, t: number): number {
    const s = this.stopped.get(object);
    if (!s) return t;
    const i = lastAtOrBefore(s.from.length, (j) => s.from[j]!, t);
    if (i < 0) return t;
    return t - s.before[i]! - (Math.min(t, s.to[i]!) - s.from[i]!);
  }

  private place(object: number) {
    const o = this.doc.objects[object];
    return (o && this.places.get(o.id)) ?? { x: 0, y: 0 };
  }

  /** The factory at `t` (clamped to the run). */
  at(t: number): FactoryReplayFrame {
    t = Math.max(0, Math.min(this.endMs, t));
    const states = this.states.map((places) => {
      let best = -1;
      for (const rows of places) {
        // A place's rows tile the run: the one covering `t` is the last starting by `t` (at the
        // very end, the last row).
        const r = rows[lastAtOrBefore(rows.length, (j) => rows[j]![0]!, t)];
        if (!r || (r[1]! <= t && !(t === this.endMs && r[1] === t))) continue;
        if (best < 0 || rank[r[2]!]! < rank[best]!) best = r[2]!;
      }
      return best;
    });
    // Parts on a vehicle are drawn on it, not where they were picked up.
    const carried = new Set<number>();
    const holding = (fi: number, v: number) => {
      const rows = this.holds[fi]?.[v] ?? [];
      const r = rows[lastAtOrBefore(rows.length, (j) => rows[j]![0]!, t)];
      return r && t < r[1]! ? r[2]! : -1;
    };
    this.holds.forEach((fleet, fi) =>
      fleet.forEach((_, v) => {
        const part = holding(fi, v);
        if (part >= 0) carried.add(part);
      }),
    );
    const parts: FactoryReplayPart[] = [];
    const conveyors = new Map<number, FactoryReplayPart[]>();
    const last = lastAtOrBefore(this.stays.length, (j) => this.stays[j]![0], t);
    const c = Math.floor(Math.max(0, last) / checkpointEvery);
    const candidates =
      last < 0
        ? []
        : [...(this.checkpoints[c] ?? []), ...this.stays.slice(c * checkpointEvery, last + 1)];
    for (const s of candidates) {
      if (!(s[0] <= t && t < s[1]) && !(t === this.endMs && s[1] === Infinity)) continue;
      if (carried.has(s[2])) continue;
      const p: FactoryReplayPart = { part: s[2], product: s[3], object: s[4] };
      const o = this.doc.objects[s[4]]!;
      if (o.kind === 'conveyor') {
        const moved = this.beltTime(s[4], t) - this.beltTime(s[4], s[0]);
        p.along = Math.min(1, (moved * o.speedMmS) / 1000 / o.lengthMm);
        const on = conveyors.get(s[4]) ?? [];
        on.push(Object.assign(p, { enter: s[0] }));
        conveyors.set(s[4], on);
      }
      parts.push(p);
    }
    // On an accumulating conveyor the parts queue behind the first: one part length apart.
    for (const [object, on] of conveyors) {
      const o = this.doc.objects[object]!;
      if (o.kind !== 'conveyor') continue;
      // A non-accumulating belt keeps its parts' spacing: they move (and stop) together.
      if (!o.accumulating) {
        for (const p of on) delete (p as { enter?: number }).enter;
        continue;
      }
      const gap = o.partLengthMm / o.lengthMm;
      on.sort(
        (a, b) =>
          (a as unknown as { enter: number }).enter - (b as unknown as { enter: number }).enter,
      );
      // The first is still one gap behind the part that last left, advancing since it left.
      const l = this.leaves.get(object) ?? [];
      const left = l[lastAtOrBefore(l.length, (j) => l[j]!, t)];
      // It advances only while the belt runs.
      const lead =
        left === undefined
          ? 1
          : 1 -
            gap +
            ((this.beltTime(object, t) - this.beltTime(object, left)) * o.speedMmS) /
              1000 /
              o.lengthMm;
      on.forEach((p, k) => {
        delete (p as { enter?: number }).enter;
        const ahead = k ? on[k - 1]!.along! - gap : lead;
        p.along = Math.min(p.along!, Math.max(0, ahead));
      });
    }
    parts.sort((a, b) => a.part - b.part);
    const segs = this.doc.paths?.segments ?? [];
    const vehicles: FactoryReplayVehicle[] = [];
    (this.doc.fleets ?? []).forEach((f, fi) => {
      for (let v = 0; v < f.count; v++) {
        const rows = this.drives[fi]![v]!;
        const i = lastAtOrBefore(rows.length, (j) => rows[j]![0]!, t);
        const home = this.nodes.get(f.homeNodeId) ?? { x: 0, y: 0 };
        if (i < 0) {
          vehicles.push({
            fleet: fi,
            vehicle: v,
            ...xy(home),
            heading: 0,
            driving: false,
            loaded: holding(fi, v) >= 0,
          });
          continue;
        }
        const [start, end, , , seg, forward] = rows[i]!;
        const g = segs[seg!];
        const a = (g && this.nodes.get(forward ? g.from : g.to)) ?? home;
        const b = (g && this.nodes.get(forward ? g.to : g.from)) ?? home;
        const driving = t < end!;
        const k = driving ? (t - start!) / Math.max(1, end! - start!) : 1;
        vehicles.push({
          fleet: fi,
          vehicle: v,
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          heading: Math.atan2(b.y - a.y, b.x - a.x),
          driving,
          loaded: holding(fi, v) >= 0,
        });
      }
    });
    const workers: FactoryReplayWorker[] = [];
    (this.doc.workerPools ?? []).forEach((p, pi) => {
      for (let w = 0; w < p.count; w++) {
        const rows = this.walks[pi]![w]!;
        const i = lastAtOrBefore(rows.length, (j) => rows[j]![0]!, t);
        const home = { x: p.home?.x ?? 0, y: p.home?.y ?? 0 };
        if (i < 0) {
          workers.push({ pool: pi, worker: w, ...home, heading: 0, walking: false });
          continue;
        }
        const [start, arrive, , , object] = rows[i]!;
        const a = i > 0 ? this.place(rows[i - 1]![4]!) : home;
        const b = this.place(object!);
        const walking = t < arrive!;
        const k = walking ? (t - start!) / Math.max(1, arrive! - start!) : 1;
        workers.push({
          pool: pi,
          worker: w,
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          heading: b.x === a.x && b.y === a.y ? 0 : Math.atan2(b.y - a.y, b.x - a.x),
          walking,
        });
      }
    });
    return { timeMs: t, states, parts, vehicles, workers };
  }
}

const xy = (p: { x: number; y: number }) => ({ x: p.x, y: p.y });
