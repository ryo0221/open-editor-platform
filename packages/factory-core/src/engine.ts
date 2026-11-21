/**
 * FT1 (docs/cad/factory-twin.md, FT-U3): the discrete-event run of a factory model. Events are
 * taken in time order (ties: the order they were scheduled), so one document and one seed give
 * one result. Parts move between objects instantly; only processing, conveying and the source
 * intervals take time. A finished part that no successor accepts blocks its object (blocking
 * after service) until a successor frees room.
 */

import {
  ladderInitialState,
  ladderScan,
  ladderVariableMap,
  type LadderState,
} from '@editor-platform/ladder-core';
import {
  FactoryValidationError,
  factoryLimits,
  type FactoryActuatorSignal,
  type FactoryControl,
  type FactoryAssembly,
  type FactoryCalendar,
  type FactoryConveyor,
  type FactoryDistribution,
  type FactoryDocument,
  type FactoryLink,
  type FactoryObject,
  type FactoryParallel,
  type FactorySource,
  type FactoryStation,
  type FactoryWorkerNeed,
} from './model';
import { FactoryRandom, sampleDistribution } from './random';
import { validateFactory } from './validation';

/**
 * What an object (or one place of a parallel station) is doing. FT3 added `setup`, `failed`
 * (broken down, under repair) and `paused` (outside its shifts); the order is the index used in
 * the timeline, so new states only ever go at the end.
 */
export type FactoryState =
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'setup'
  | 'failed'
  | 'paused'
  | 'unstaffed'
  | 'transport'
  | 'held';
export const factoryStates: readonly FactoryState[] = Object.freeze([
  'working',
  'waiting',
  'blocked',
  'setup',
  'failed',
  'paused',
  'unstaffed',
  'transport',
  'held',
]);
const noVehicleStates = () =>
  Object.fromEntries(factoryVehicleStates.map((s) => [s, 0])) as Record<
    FactoryVehicleState,
    number
  >;
const noStates = () =>
  Object.fromEntries(factoryStates.map((s) => [s, 0])) as Record<FactoryState, number>;

export interface FactoryObjectStats {
  id: string;
  kind: FactoryObject['kind'];
  /**
   * Milliseconds in each state over the statistics period. A parallel station counts each place
   * and divides by the number of places, so the three always add up to the period.
   * - station, parallel, assembly: working = processing, waiting = no part (or, for an
   *   assembly, not all parts yet), blocked = a finished part cannot leave.
   * - source: working = creating parts, blocked = a created part cannot leave, waiting = done
   *   (its limit reached) or not started.
   * - buffer: working = holds parts, waiting = empty, blocked = its first part cannot leave.
   * - conveyor: working = carries parts, waiting = empty, blocked = its head part cannot leave.
   * - drain: working = never, waiting = always.
   * - FT3: setup = setting up for another product, failed = broken down until repaired,
   *   paused = outside the object's shifts.
   * - FT3b: unstaffed = a part is there but its workers are not (none free, or walking there).
   * - FT3c: transport = a finished part waits for the vehicle called for it (else blocked).
   * - FT6: held = the PLC holds it: its release is off while a part is ready, or a conveyor's
   *   motor is off while parts are on it.
   */
  states: Record<FactoryState, number>;
  /** Parts that came in / went out during the period (a drain's `exited` = parts removed). */
  entered: number;
  exited: number;
  /** Time-average and maximum number of parts held. */
  meanContent: number;
  maxContent: number;
}

export interface FactoryBottleneck {
  id: string;
  /** Time this object alone was the bottleneck (its active period the longest). */
  soleMs: number;
  /** Time it shared the bottleneck with the one before or after it. */
  shiftingMs: number;
  /** (sole + shifting) ÷ period. */
  share: number;
  /** Mean length of its active (working) periods. */
  meanActiveMs: number;
}

export interface FactoryRunResult {
  seed: number;
  /** The statistics period: from the end of the warm-up to the end of the run. */
  startMs: number;
  endMs: number;
  events: number;
  /** Parts that reached a drain during the period, all and per product. */
  produced: number;
  producedByProduct: Record<string, number>;
  throughputPerHour: number;
  /** Time from creation at a source to a drain, of the parts that reached one in the period. */
  leadTime: {
    count: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
    /** Nearest-rank percentiles. */
    p50Ms: number;
    p90Ms: number;
    p95Ms: number;
    /** `factoryHistogramBins` equal bins from `minMs` to `maxMs` (counts). */
    histogram: number[];
  };
  /** Parts in the model (created, not yet removed or assembled into another). */
  wip: { mean: number; max: number };
  /** Parts consumed as assembly components during the period. */
  assembled: number;
  objects: FactoryObjectStats[];
  /** Stations, parallel stations and assemblies, most often the bottleneck first. */
  bottlenecks: FactoryBottleneck[];
  /** Parts that passed each link during the period (by link ID), for a flow (Sankey) chart. */
  flows: Record<string, number>;
  /** FT3b: per worker pool, in document order (empty without pools). */
  workers: FactoryWorkerStats[];
  /** FT3c: per fleet, in document order. */
  fleets: FactoryFleetStats[];
  /** FT3c: set when vehicles locked each other; the run (and its statistics) end there. */
  deadlock?: FactoryDeadlock;
  /** FT6: only with `doc.control`. */
  control?: FactoryControlResult;
  /** Only with `options.record`. */
  timeline?: FactoryTimeline;
}

/** FT6: an object the PLC held for at least `control.stallMs` up to the end of the run. */
export interface FactoryStall {
  objectId: string;
  /** The actuator that holds it: `run` (motor off), `release` or `admit` (a feeder blocked). */
  signal: FactoryActuatorSignal;
  sinceMs: number;
}

export interface FactoryControlResult {
  /** Scans run (warm-up included). */
  scans: number;
  /** When a part last moved from one object to another (-1: never). */
  lastMoveMs: number;
  /** Held objects at the end; empty when the flow was not stopped by the PLC. */
  stalls: FactoryStall[];
  /** The program's state after the last scan, and which elements carried power in it. */
  state: LadderState;
  power: Record<string, boolean>;
}

export const factoryHistogramBins = 20;

/**
 * FT1b: what happened over the whole run (warm-up included), for Gantt charts and replay.
 * - `states`: per object, intervals `[start, end, state, place]` (state as an index into
 *   `factoryStates`; the place of a parallel station, else 0). Intervals of zero length are
 *   left out, so two `working` rows meet where a place takes its next part at once.
 * - `moves`: `[time, part, product, from, to]` with object indices (-1 = made at a source for
 *   `from`, or consumed into an assembly for `to`) and product indices into `doc.products`.
 * Stops recording at `maxRecords` intervals plus moves and sets `truncated` and `recordedUntilMs`;
 * what began by then is still kept (states still open there, events of that instant).
 */
export interface FactoryTimeline {
  states: number[][];
  moves: number[];
  /** FT3b: `[start, arrive, pool, worker, object]` for every walk of a worker to an object. */
  walks: number[];
  /**
   * FT3c: `[start, end, fleet, vehicle, segment, forward, part]` for every segment a vehicle
   * drives (segment index into `paths.segments`, forward 1 = from → to, part -1 = empty).
   */
  drives: number[];
  /**
   * `[time, fleet, vehicle, part, object]` each time a vehicle starts loading a part from an
   * object: the part is on it from then (a trip whose ends share a path node drives no segment loaded).
   */
  loads: number[];
  /**
   * `[time, object, stopped]` each time a conveyor's belt stops (1: its head held back, or its
   * motor off) or runs again (0). A belt runs from the start until its first stop.
   */
  belts: number[];
  /**
   * FT6: `[time, kind, index, value]` for every change of a wired signal seen at a scan (kind 0 =
   * sensor, 1 = actuator; index into `control.sensors` or `control.actuators`; value 0 or 1).
   * The first scan records every signal.
   */
  signals: number[];
  truncated: boolean;
  /**
   * FT4b: when `truncated`, the time of the first record left out; nothing from then on is
   * complete (an interval open then is missing too), so replay stops there.
   */
  recordedUntilMs?: number;
}

export interface FactoryRunOptions {
  /** Defaults to `doc.run`. */
  seed?: number;
  durationMs?: number;
  warmupMs?: number;
  /** Stops with `event-limit` after this many events (default and maximum `factoryLimits.events`). */
  maxEvents?: number;
  /** Records the timeline (FT1b), up to `maxRecords` entries (default and maximum 2,000,000). */
  record?: boolean;
  maxRecords?: number;
}

interface Part {
  id: number;
  productId: string;
  createdAt: number;
}

/** `step` ends a run of a place's work; `shift` turns a calendar (`node` = its index) on or off. */
type EventKind =
  | 'create'
  | 'step'
  | 'wake'
  | 'warmup'
  | 'fail'
  | 'repair'
  | 'shift'
  | 'arrive'
  | 'drive'
  | 'agv'
  | 'scan';
interface SimEvent {
  time: number;
  seq: number;
  kind: EventKind;
  node: number;
  slot: number;
  /** A `step` with an outdated stamp was overtaken (paused) and is ignored. */
  tag: number;
}

class EventQueue {
  private heap: SimEvent[] = [];
  private seq = 0;
  get size() {
    return this.heap.length;
  }
  push(time: number, kind: EventKind, node: number, slot = 0, tag = 0) {
    const e: SimEvent = { time, seq: this.seq++, kind, node, slot, tag };
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  peek(): SimEvent | undefined {
    return this.heap[0];
  }
  pop(): SimEvent | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l]!, h[m]!)) m = l;
        if (r < h.length && before(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
/**
 * Calendar changes come first at their instant, so nothing happens on the wrong side of one; a
 * PLC scan comes last, so it reads the sensors after everything else at that instant.
 */
const rank = (e: SimEvent) => (e.kind === 'shift' ? 0 : e.kind === 'scan' ? 2 : 1);
const before = (a: SimEvent, b: SimEvent) =>
  a.time < b.time ||
  (a.time === b.time && (rank(a) < rank(b) || (rank(a) === rank(b) && a.seq < b.seq)));

/** Per-place state bookkeeping with time totals. */
class Clock {
  totals: Record<FactoryState, number> = noStates();
  private since: number[];
  /** Since when each place is in its state, for the timeline (not reset at the warm-up). */
  private began: number[];
  constructor(
    public states: FactoryState[],
    now: number,
    private log?: (start: number, end: number, s: FactoryState, place: number) => void,
  ) {
    this.since = states.map(() => now);
    this.began = states.map(() => now);
  }
  set(slot: number, s: FactoryState, now: number) {
    if (this.states[slot] === s) return;
    this.totals[this.states[slot]!] += now - this.since[slot]!;
    if (this.log && now > this.began[slot]!)
      this.log(this.began[slot]!, now, this.states[slot]!, slot);
    this.states[slot] = s;
    this.since[slot] = now;
    this.began[slot] = now;
  }
  flush(now: number) {
    this.states.forEach((s, i) => {
      this.totals[s] += now - this.since[i]!;
      this.since[i] = now;
    });
  }
  /** Writes the open intervals at the end of the run. */
  close(now: number) {
    this.states.forEach((s, i) => {
      if (this.log && now > this.began[i]!) this.log(this.began[i]!, now, s, i);
      this.began[i] = now;
    });
  }
  reset(now: number) {
    this.flush(now);
    this.totals = noStates();
  }
  /** FT6: since when the place is `held`, or -1. */
  heldSince(slot: number) {
    return this.states[slot] === 'held' ? this.began[slot]! : -1;
  }
}

/** One object of the model at run time. */
abstract class Node {
  outs: { link: FactoryLink; to: Node; index: number }[] = [];
  ins: Node[] = [];
  clock: Clock;
  blockedSince = -1;
  lastOut = -1;
  entered = 0;
  exited = 0;
  content = 0;
  maxContent = 0;
  private contentArea = 0;
  private contentSince: number;
  /** Working periods (start, end) after the warm-up, for the bottleneck analysis. */
  active: number[] = [];
  private activeStart = -1;
  constructor(
    public sim: Sim,
    public index: number,
    public def: FactoryObject,
    places: number,
    initial: FactoryState,
  ) {
    const log = sim.recorder?.stateLog(index);
    this.clock = new Clock(
      Array.from({ length: places }, () => initial),
      sim.now,
      log,
    );
    this.contentSince = sim.now;
  }
  abstract accepts(part: Part): boolean;
  abstract receive(part: Part): void;
  /** Parts that may leave now, in the order they should. */
  abstract ready(): Part[];
  abstract release(part: Part): void;
  onEvent(_kind: EventKind, _slot: number, _tag: number) {}
  /** FT3: outside its calendar's shifts. */
  offShift = false;
  /** FT3c: the parts that will leave, in order (a buffer: all of them; else the ready ones). */
  waitingParts(): Part[] {
    return this.ready();
  }
  /** FT3c: links carried by vehicles out of this object. */
  transports: TransportNode[] = [];
  /** `transport` while a vehicle is called for one of its parts, else `blocked`. */
  blockedState(): FactoryState {
    return this.transports.some((t) => t.pending > 0) ? 'transport' : 'blocked';
  }
  setShift(on: boolean) {
    this.offShift = !on;
    this.refreshState();
  }
  get rng() {
    return this.sim.rngFor(this.index);
  }
  addContent(delta: number) {
    const now = this.sim.now;
    this.contentArea += this.content * (now - this.contentSince);
    this.contentSince = now;
    this.content += delta;
    if (this.content > this.maxContent) this.maxContent = this.content;
  }
  meanContent(now: number, period: number) {
    const area = this.contentArea + this.content * (now - this.contentSince);
    return period > 0 ? area / period : this.content;
  }
  resetStats(now: number) {
    this.clock.reset(now);
    this.entered = 0;
    this.exited = 0;
    this.contentArea = 0;
    this.contentSince = now;
    this.maxContent = this.content;
    this.active = [];
    if (this.activeStart >= 0) this.activeStart = now;
  }
  /** Marks whether the object is working (for the active-period bottleneck analysis). */
  setActive(on: boolean) {
    const now = this.sim.now;
    if (on && this.activeStart < 0) {
      // A part handed on and the next taken at the same instant: one continuous period.
      const n = this.active.length;
      if (n && this.active[n - 1] === now) {
        this.activeStart = this.active[n - 2]!;
        this.active.length = n - 2;
      } else this.activeStart = now;
    } else if (!on && this.activeStart >= 0) {
      if (now > this.activeStart && this.sim.measuring) this.active.push(this.activeStart, now);
      this.activeStart = -1;
    }
  }
  closeActive(now: number) {
    if (this.activeStart >= 0 && now > this.activeStart) this.active.push(this.activeStart, now);
  }
  /** Called when a part could not leave, or did. */
  abstract refreshState(): void;
  /** FT6: the PLC's gates (always on without control). */
  releaseOn = true;
  admitOn = true;
  admitOffSince = -1;
  setRelease(on: boolean) {
    if (this.releaseOn === on) return;
    this.releaseOn = on;
    this.sim.wake(this);
  }
  setAdmit(on: boolean) {
    if (this.admitOn === on) return;
    this.admitOn = on;
    this.admitOffSince = on ? -1 : this.sim.now;
    if (on) this.sim.wakeFeeders(this);
  }
  /** FT6 sensors. */
  sensorReady() {
    return this.ready().length > 0;
  }
  isFull() {
    return false;
  }
  isFailed() {
    return false;
  }
}

class SourceNode extends Node {
  held: Part | undefined;
  made = 0;
  started = false;
  constructor(sim: Sim, index: number, def: FactorySource) {
    super(sim, index, def, 1, 'waiting');
    sim.queue.push(def.startMs ?? 0, 'create', index);
  }
  get source() {
    return this.def as FactorySource;
  }
  accepts() {
    return false;
  }
  receive() {}
  ready() {
    return this.held && !this.offShift ? [this.held] : [];
  }
  release() {
    this.held = undefined;
    this.addContent(-1);
    this.exited++;
    this.scheduleNext();
    this.refreshState();
  }
  private done() {
    return this.source.limit !== undefined && this.made >= this.source.limit;
  }
  private scheduleNext() {
    if (this.done()) return;
    const gap = Math.max(1, sampleDistribution(this.source.interval, this.rng));
    this.sim.queue.push(this.sim.now + gap, 'create', this.index);
  }
  /** A part fell due outside the shifts: it is made when the next shift starts. */
  private due = false;
  setShift(on: boolean) {
    this.offShift = !on;
    if (on && this.due) {
      this.due = false;
      this.create();
    } else this.refreshState();
    if (on) this.sim.wake(this);
  }
  onEvent(kind: EventKind) {
    if (kind !== 'create' || this.done()) return;
    if (this.offShift) {
      this.due = true;
      return;
    }
    this.create();
  }
  private create() {
    this.started = true;
    const mix = this.source.mix;
    const productId =
      mix.length === 1
        ? mix[0]!.productId
        : mix[this.rng.pick(mix.map((m) => m.weight))]!.productId;
    this.held = this.sim.newPart(productId);
    this.sim.recorder?.move(this.sim.now, this.held, -1, this.index);
    this.made++;
    this.entered++;
    this.addContent(1);
    this.refreshState();
    this.sim.wake(this);
  }
  refreshState() {
    const s: FactoryState =
      this.offShift && (this.held || !this.done())
        ? 'paused'
        : this.held
          ? !this.releaseOn
            ? 'held'
            : this.blockedSince >= 0
              ? this.blockedState()
              : 'working'
          : this.started && !this.done()
            ? 'working'
            : 'waiting';
    this.clock.set(0, s, this.sim.now);
  }
}

/** FT3: one place of a station, parallel station or assembly. */
interface Place {
  part: Part | undefined;
  /** `idle`: no part (an assembly may be gathering one); `done`: the part may leave. */
  phase: 'idle' | 'setup' | 'process' | 'done';
  /** Work left in the current phase, ms. */
  left: number;
  processMs: number;
  /** Since when the phase runs (-1: not running), and a stamp that outdates its step event. */
  since: number;
  gen: number;
  failed: boolean;
  /** Operating time left to the next failure (operating basis). */
  upLeft: number;
  /** The product of the last part (for setups). */
  last: string | undefined;
  /** FT3b: the place's workers: none needed or none yet, asked for, on the way, there. */
  staff: 'none' | 'waiting' | 'walking' | 'here';
  crew: Worker[];
}

/**
 * Stations, parallel stations and assemblies. A place's work (a setup, then the processing)
 * runs only while it is not failed and its object is on shift; a failure or the end of a shift
 * pauses it and the rest continues later.
 */
abstract class ProcessNode extends Node {
  places: Place[];
  /** Places whose part is finished, in the order they finished. */
  finished: number[] = [];
  constructor(
    sim: Sim,
    index: number,
    def: FactoryStation | FactoryParallel | FactoryAssembly,
    count: number,
  ) {
    super(sim, index, def, count, 'waiting');
    this.places = Array.from({ length: count }, () => ({
      part: undefined,
      phase: 'idle' as const,
      left: 0,
      processMs: 0,
      since: -1,
      gen: 0,
      failed: false,
      upLeft: Infinity,
      last: undefined,
      staff: 'none' as const,
      crew: [],
    }));
    if (def.failures)
      this.places.forEach((p, slot) => {
        if (this.operatingFailures) p.upLeft = this.uptime();
        else sim.queue.push(this.uptime(), 'fail', index, slot);
      });
  }
  get proc() {
    return this.def as FactoryStation | FactoryParallel | FactoryAssembly;
  }
  private get operatingFailures() {
    const f = this.proc.failures;
    return !!f && (f.basis ?? 'operating') === 'operating';
  }
  private uptime() {
    return Math.max(
      1,
      sampleDistribution(this.proc.failures!.uptime, this.sim.extraRng(this.index, 'uptime')),
    );
  }
  /** Starts a part on a place: a setup first when the product changed. */
  protected begin(slot: number, productId: string, processMs: number) {
    const p = this.places[slot]!;
    const s = this.proc.setup;
    const setup =
      s && p.last !== undefined && p.last !== productId
        ? (s.productTimes?.find((t) => t.productId === productId)?.time ?? s.time)
        : undefined;
    p.processMs = processMs;
    p.last = productId;
    if (setup) {
      p.phase = 'setup';
      p.left = sampleDistribution(setup, this.sim.extraRng(this.index, 'setup'));
    } else {
      p.phase = 'process';
      p.left = processMs;
    }
    if (this.proc.workers) {
      p.staff = 'waiting';
      this.sim.askWorkers(this, slot, this.proc.workers);
    }
    this.resume(slot);
    this.refreshState();
  }
  /** FT3b: workers set off for `slot`; they are there at `at`. */
  staffed(slot: number, crew: Worker[], at: number) {
    const p = this.places[slot]!;
    p.crew = crew;
    p.staff = 'walking';
    this.sim.queue.push(at, 'arrive', this.index, slot);
    this.refreshState();
  }
  private resume(slot: number) {
    const p = this.places[slot]!;
    if (p.since >= 0 || p.failed || this.offShift) return;
    if (p.staff === 'waiting' || p.staff === 'walking') return;
    if (p.phase !== 'setup' && p.phase !== 'process') return;
    p.since = this.sim.now;
    p.gen++;
    const dt = Math.min(p.left, this.operatingFailures ? p.upLeft : Infinity);
    this.sim.queue.push(this.sim.now + dt, 'step', this.index, slot, p.gen);
  }
  private pause(slot: number) {
    const p = this.places[slot]!;
    if (p.since < 0) return;
    const ran = this.sim.now - p.since;
    p.left -= ran;
    if (this.operatingFailures) p.upLeft -= ran;
    p.since = -1;
    p.gen++;
  }
  private fail(slot: number) {
    const p = this.places[slot]!;
    this.pause(slot);
    p.failed = true;
    const repair = sampleDistribution(
      this.proc.failures!.repair,
      this.sim.extraRng(this.index, 'repair'),
    );
    this.sim.queue.push(this.sim.now + repair, 'repair', this.index, slot);
    this.refreshState();
  }
  /**
   * After a pause: ends a setup or a processing whose work is used up, and fails the place when
   * its operating uptime is used up (also at a shift end, so the repair runs off shift).
   */
  private settle(slot: number) {
    const p = this.places[slot]!;
    if (p.left <= 0 && p.phase === 'setup') {
      p.phase = 'process';
      p.left = p.processMs;
    }
    if (p.left <= 0 && p.phase === 'process') {
      p.phase = 'done';
      if (p.crew.length) this.sim.freeWorkers(p.crew);
      p.crew = [];
      p.staff = 'none';
      this.finished.push(slot);
      this.onFinished(slot);
      this.sim.wake(this);
    }
    if (this.operatingFailures && p.upLeft <= 0 && !p.failed) this.fail(slot);
  }
  /** The part of `slot` is processed (assemblies consume their components here). */
  protected onFinished(_slot: number) {}
  onEvent(kind: EventKind, slot: number, tag: number) {
    const p = this.places[slot]!;
    if (kind === 'step') {
      if (tag !== p.gen || p.since < 0) return;
      this.pause(slot);
      this.settle(slot);
      if (!p.failed) this.resume(slot);
      this.refreshState();
    } else if (kind === 'arrive') {
      p.staff = 'here';
      this.resume(slot);
      this.refreshState();
    } else if (kind === 'fail') {
      if (!p.failed) this.fail(slot);
    } else if (kind === 'repair') {
      p.failed = false;
      if (this.operatingFailures) p.upLeft = this.uptime();
      else this.sim.queue.push(this.sim.now + this.uptime(), 'fail', this.index, slot);
      this.resume(slot);
      this.refreshState();
      this.sim.wake(this);
      this.sim.wakeFeeders(this);
    }
  }
  setShift(on: boolean) {
    this.offShift = !on;
    this.places.forEach((p, slot) => {
      if (on) this.resume(slot);
      else if (p.since >= 0) {
        this.pause(slot);
        this.settle(slot);
      }
    });
    this.refreshState();
    if (on) {
      this.sim.wake(this);
      this.sim.wakeFeeders(this);
    }
  }
  isFull() {
    return this.freePlace() < 0;
  }
  isFailed() {
    return this.places.some((p) => p.failed);
  }
  /** A place that can take a part now, or -1. */
  protected freePlace() {
    if (this.offShift) return -1;
    return this.places.findIndex((p) => p.phase === 'idle' && !p.failed);
  }
  ready() {
    if (this.offShift) return [];
    return this.finished.filter((s) => !this.places[s]!.failed).map((s) => this.places[s]!.part!);
  }
  release(part: Part) {
    const slot = this.places.findIndex((p) => p.part === part);
    const p = this.places[slot]!;
    p.part = undefined;
    p.phase = 'idle';
    this.finished.splice(this.finished.indexOf(slot), 1);
    this.exited++;
    this.addContent(-1);
    this.refreshState();
  }
  protected placeState(p: Place): FactoryState {
    if (p.failed) return 'failed';
    if (this.offShift) return 'paused';
    if (p.staff === 'waiting' || p.staff === 'walking') return 'unstaffed';
    if (p.phase === 'setup') return 'setup';
    if (p.phase === 'process') return 'working';
    if (p.phase === 'done')
      return !this.releaseOn ? 'held' : this.blockedSince >= 0 ? this.blockedState() : 'working';
    return 'waiting';
  }
  refreshState() {
    this.places.forEach((p, slot) => this.clock.set(slot, this.placeState(p), this.sim.now));
    // Active (for the bottleneck analysis) while on shift and every place sets up, processes or
    // is repaired; a repair that runs on outside the shifts is not active.
    this.setActive(
      !this.offShift &&
        this.places.every(
          (p) =>
            p.failed ||
            (p.staff !== 'waiting' &&
              p.staff !== 'walking' &&
              (p.phase === 'setup' || p.phase === 'process')),
        ),
    );
  }
}

/** A station (one place) or a parallel station (`count` places). */
class StationNode extends ProcessNode {
  constructor(sim: Sim, index: number, def: FactoryStation | FactoryParallel) {
    super(sim, index, def, def.kind === 'parallel' ? def.count : 1);
  }
  get station() {
    return this.def as FactoryStation | FactoryParallel;
  }
  accepts() {
    return this.freePlace() >= 0;
  }
  timeFor(productId: string): FactoryDistribution {
    return (
      this.station.productTimes?.find((t) => t.productId === productId)?.time ??
      this.station.processTime
    );
  }
  receive(part: Part) {
    const slot = this.freePlace();
    this.places[slot]!.part = part;
    this.entered++;
    this.addContent(1);
    this.begin(slot, part.productId, sampleDistribution(this.timeFor(part.productId), this.rng));
  }
}

class AssemblyNode extends ProcessNode {
  have = new Map<string, number>();
  components: Part[] = [];
  /** The main part while gathering, before processing starts. */
  main: Part | undefined;
  constructor(sim: Sim, index: number, def: FactoryAssembly) {
    super(sim, index, def, 1);
  }
  get assembly() {
    return this.def as FactoryAssembly;
  }
  accepts(part: Part) {
    if (this.freePlace() < 0) return false;
    if (part.productId === this.assembly.mainProductId) return !this.main;
    const need = this.assembly.components.find((c) => c.productId === part.productId);
    return !!need && (this.have.get(part.productId) ?? 0) < need.count;
  }
  receive(part: Part) {
    this.entered++;
    this.addContent(1);
    if (part.productId === this.assembly.mainProductId) this.main = part;
    else {
      this.have.set(part.productId, (this.have.get(part.productId) ?? 0) + 1);
      this.components.push(part);
    }
    if (
      this.main &&
      this.assembly.components.every((c) => (this.have.get(c.productId) ?? 0) >= c.count)
    ) {
      this.places[0]!.part = this.main;
      this.begin(0, this.main.productId, sampleDistribution(this.assembly.processTime, this.rng));
    }
  }
  protected onFinished() {
    // The components are now part of the main part.
    const used = this.assembly.components.reduce((s, c) => s + c.count, 0);
    this.addContent(-used);
    this.sim.consume(used);
    for (const c of this.components) this.sim.recorder?.move(this.sim.now, c, this.index, -1);
    this.components = [];
    this.have.clear();
    if (this.assembly.outputProductId) this.main!.productId = this.assembly.outputProductId;
  }
  release(part: Part) {
    this.main = undefined;
    super.release(part);
  }
}

class BufferNode extends Node {
  parts: Part[] = [];
  constructor(
    sim: Sim,
    index: number,
    public capacity: number,
    public lifo: boolean,
  ) {
    super(sim, index, sim.doc.objects[index]!, 1, 'waiting');
  }
  accepts() {
    return this.parts.length < this.capacity;
  }
  isFull() {
    return this.parts.length >= this.capacity;
  }
  receive(part: Part) {
    this.parts.push(part);
    this.entered++;
    this.addContent(1);
    this.refreshState();
    this.sim.wake(this);
  }
  waitingParts() {
    return this.lifo ? [...this.parts].reverse() : this.parts;
  }
  /** Only the head (FIFO) or top (LIFO) may leave: a blocked one holds back the rest. */
  ready() {
    const part = this.lifo ? this.parts[this.parts.length - 1] : this.parts[0];
    return part ? [part] : [];
  }
  release(part: Part) {
    this.parts.splice(this.parts.indexOf(part), 1);
    this.exited++;
    this.addContent(-1);
    this.refreshState();
  }
  refreshState() {
    this.clock.set(
      0,
      !this.parts.length
        ? 'waiting'
        : !this.releaseOn
          ? 'held'
          : this.blockedSince >= 0
            ? this.blockedState()
            : 'working',
      this.sim.now,
    );
  }
}

/**
 * Positions on a belt are kept in belt time: real time less the time the belt stood. A part
 * reaches the end `travel` of belt time after it entered. Accumulating: no sooner than `gap`
 * after the part in front left (parts queue up behind a blocked head while the belt runs).
 * Non-accumulating: the belt stands while its head part waits at the end, which delays every
 * part on it. Entry needs `gap` of belt movement since the last entry. FT6: with its motor off
 * (the PLC's `run`), any belt stands.
 */
class ConveyorNode extends Node {
  parts: { part: Part; belt: number }[] = [];
  travel: number;
  gap: number;
  capacity: number;
  lastEntryBelt = -Infinity;
  lastExitBelt = -Infinity;
  /** Total standing time, and since when it stands (-1 = moving). */
  stoppedTotal = 0;
  stoppedSince = -1;
  /** Non-accumulating: the head part waits at the end. */
  headStop = false;
  /** FT6: the PLC's `run`. */
  motorOn = true;
  wakeAt = -1;
  constructor(sim: Sim, index: number, def: FactoryConveyor) {
    super(sim, index, def, 1, 'waiting');
    this.travel = Math.ceil((def.lengthMm * 1000) / def.speedMmS);
    this.gap = Math.ceil((def.partLengthMm * 1000) / def.speedMmS);
    this.capacity = Math.floor(def.lengthMm / def.partLengthMm);
  }
  get conveyor() {
    return this.def as FactoryConveyor;
  }
  belt(now = this.sim.now) {
    return now - this.stoppedTotal - (this.stoppedSince >= 0 ? now - this.stoppedSince : 0);
  }
  private setStopped() {
    const stop = this.headStop || !this.motorOn;
    const now = this.sim.now;
    if (stop && this.stoppedSince < 0) {
      this.stoppedSince = now;
      this.sim.recorder?.belt(now, this.index, true);
    } else if (!stop && this.stoppedSince >= 0) {
      this.stoppedTotal += now - this.stoppedSince;
      this.stoppedSince = -1;
      this.sim.recorder?.belt(now, this.index, false);
    }
  }
  accepts() {
    if (this.parts.length >= this.capacity) return false;
    const due = this.lastEntryBelt + this.gap;
    if (this.belt() >= due) return true;
    // Room opens once the belt moved on; a standing belt wakes its feeders when it restarts.
    if (this.stoppedSince < 0) this.schedule(this.sim.now + (due - this.belt()));
    return false;
  }
  isFull() {
    return this.parts.length >= this.capacity;
  }
  receive(part: Part) {
    const belt = this.belt();
    this.parts.push({ part, belt });
    this.lastEntryBelt = belt;
    this.entered++;
    this.addContent(1);
    this.refreshState();
    this.planHead();
  }
  /** The belt time at which the head part is at the end. */
  private headTarget() {
    const head = this.parts[0]!;
    return this.conveyor.accumulating
      ? Math.max(head.belt + this.travel, this.lastExitBelt + this.gap)
      : head.belt + this.travel;
  }
  /** The head part is at the end (whether or not the motor runs). */
  atEnd() {
    return this.parts.length > 0 && this.belt() >= this.headTarget();
  }
  /** When the head part may leave (real time), or Infinity while the belt stands short of it. */
  headReadyAt(): number {
    if (!this.parts.length || !this.motorOn) return Infinity;
    if (this.atEnd()) return this.sim.now;
    if (this.stoppedSince >= 0) return Infinity;
    return this.sim.now + (this.headTarget() - this.belt());
  }
  private schedule(at: number) {
    if (this.wakeAt === at) return;
    this.wakeAt = at;
    this.sim.queue.push(at, 'wake', this.index);
  }
  private planHead() {
    const at = this.headReadyAt();
    if (at > this.sim.now && Number.isFinite(at)) this.schedule(at);
    else if (at <= this.sim.now) this.sim.wake(this);
  }
  onEvent(kind: EventKind) {
    if (kind !== 'wake') return;
    if (this.wakeAt === this.sim.now) this.wakeAt = -1;
    this.planHead();
    this.sim.wakeFeeders(this);
  }
  /** FT6: the motor turned on or off. */
  setMotor(on: boolean) {
    if (this.motorOn === on) return;
    this.motorOn = on;
    this.setStopped();
    this.refreshState();
    if (on) {
      this.planHead();
      this.sim.wakeFeeders(this);
    }
  }
  ready() {
    const head = this.parts[0];
    return head && this.headReadyAt() <= this.sim.now ? [head.part] : [];
  }
  sensorReady() {
    return this.atEnd();
  }
  release() {
    this.parts.shift();
    this.lastExitBelt = this.belt();
    this.headStop = false;
    this.setStopped();
    this.exited++;
    this.addContent(-1);
    this.refreshState();
    this.planHead();
    this.sim.wakeFeeders(this);
  }
  refreshState() {
    const blocked = this.blockedSince >= 0;
    const holding = !this.releaseOn && this.atEnd();
    if (!this.conveyor.accumulating && !this.headStop && (blocked || holding)) {
      this.headStop = true;
      this.setStopped();
    }
    this.clock.set(
      0,
      !this.parts.length
        ? 'waiting'
        : !this.motorOn || holding
          ? 'held'
          : blocked
            ? this.blockedState()
            : 'working',
      this.sim.now,
    );
  }
}

/** FT3c: what a vehicle is doing, for its statistics. */
export type FactoryVehicleState =
  | 'idle'
  | 'empty'
  | 'loaded'
  | 'handling'
  | 'traffic'
  | 'blocked'
  | 'charging';
export const factoryVehicleStates: readonly FactoryVehicleState[] = Object.freeze([
  'idle',
  'empty',
  'loaded',
  'handling',
  'traffic',
  'blocked',
  'charging',
]);

export interface FactoryFleetStats {
  fleetId: string;
  count: number;
  /**
   * Mean share of the period per vehicle: idle (parked, free), empty (driving to a pickup or a
   * charger), loaded (driving with a part), handling (waiting at a pickup, loading, unloading),
   * traffic (waiting for a segment), blocked (unloaded, the target has no room), charging.
   */
  shares: Record<FactoryVehicleState, number>;
  /** Parts loaded during the period. */
  trips: number;
  /** Mean time from a call to the vehicle's arrival at the pickup, of the calls met. */
  meanCallWaitMs: number;
}

/** FT3c: the run stopped because vehicles waited for each other's segments in a circle. */
export interface FactoryDeadlock {
  atMs: number;
  /** `fleet#n` of each vehicle in the circle. */
  vehicles: string[];
  /** The segment IDs they hold. */
  segments: string[];
}

type VehicleTask =
  | 'idle'
  | 'toPickup'
  | 'atPickup'
  | 'loading'
  | 'toDrop'
  | 'unloading'
  | 'atDrop'
  | 'toCharger'
  | 'charging';
interface Vehicle {
  id: number;
  fleet: number;
  index: number;
  /** The path node it stands at (-1 while on a segment). */
  node: number;
  /** The segment it holds (-1: none) and the one it waits for. */
  seg: number;
  waitSeg: number;
  next: number;
  path: { seg: number; to: number; forward: boolean }[];
  task: VehicleTask;
  part: Part | undefined;
  job: TransportNode | undefined;
  callAt: number;
  charge: number;
  stat: FactoryVehicleState;
  since: number;
  totals: Record<FactoryVehicleState, number>;
  trips: number;
}
const AGV_CHECK = 0;
const AGV_LOADED = 1;
const AGV_UNLOADED = 2;
const AGV_CHARGED = 3;

/**
 * FT3c: a link carried by vehicles, as a node of its own between `from` and `to` (not one of
 * the document's objects). It takes a part from `from` only when a vehicle stands at the pickup;
 * otherwise it calls vehicles, one per part waiting at `from` (whether or not `to` has room now),
 * and refuses. Parts whose vehicle has unloaded are
 * ready to go on to `to`.
 */
class TransportNode extends Node {
  /** Vehicles called and not loaded yet (on their way, queued, or waiting at the pickup). */
  pending = 0;
  atPickup: Vehicle[] = [];
  atDrop: Vehicle[] = [];
  constructor(
    sim: Sim,
    index: number,
    public link: FactoryLink,
    public from: Node,
    public fleet: number,
    public pickup: number,
    public drop: number,
  ) {
    super(
      sim,
      index,
      { id: link.id, name: link.id, kind: 'buffer', capacity: 1 } as FactoryObject,
      1,
      'waiting',
    );
  }
  get to() {
    return this.outs[0]!.to;
  }
  accepts() {
    if (this.atPickup.length) return true;
    this.callFor();
    return false;
  }
  /** The parts waiting at `from` that this link may carry (its product filter). */
  eligible() {
    const only = this.link.productIds;
    const parts = this.from.waitingParts();
    return only ? parts.filter((p) => only.includes(p.productId)).length : parts.length;
  }
  /** One vehicle per part waiting at `from` (a buffer's whole queue) that this link carries. */
  callFor() {
    const want = this.eligible();
    while (this.pending < want) {
      this.pending++;
      this.sim.callVehicle(this);
    }
  }
  receive(part: Part) {
    const v = this.atPickup.shift()!;
    this.pending--;
    this.sim.loadVehicle(v, part, this.from.index);
  }
  ready() {
    return this.atDrop.map((v) => v.part!);
  }
  release(part: Part) {
    const v = this.atDrop.splice(
      this.atDrop.findIndex((x) => x.part === part),
      1,
    )[0]!;
    this.sim.vehicleDone(v);
  }
  refreshState() {}
}

class DrainNode extends Node {
  constructor(sim: Sim, index: number) {
    super(sim, index, sim.doc.objects[index]!, 1, 'waiting');
  }
  accepts() {
    return true;
  }
  receive(part: Part) {
    this.entered++;
    this.exited++;
    this.sim.removeFromModel(part);
  }
  ready() {
    return [];
  }
  release() {}
  refreshState() {}
}

/** FT1b: collects the timeline, up to a number of records. */
class Recorder {
  private states: number[][];
  private moves: number[] = [];
  private count = 0;
  private truncated = false;
  private cut: number | undefined;
  private products: Map<string, number>;
  constructor(
    doc: FactoryDocument,
    private max: number,
  ) {
    this.states = doc.objects.map(() => []);
    this.products = new Map(doc.products.map((p, i) => [p.id, i]));
  }
  /**
   * `at`: the simulation time now (records arrive in time order); `from`: when the record
   * begins. Past the limit the recording is cut where it is now, but what began by then is still
   * kept (a state is recorded when it ends; at most one per place, and the events of that
   * instant), so the replay is whole up to the cut.
   */
  private room(at: number, from = at) {
    if (this.count >= this.max) {
      this.truncated = true;
      this.cut ??= at;
      return from <= this.cut;
    }
    this.count++;
    return true;
  }
  stateLog(index: number) {
    if (index >= this.states.length) return undefined;
    return (start: number, end: number, s: FactoryState, place: number) => {
      if (this.room(end, start))
        this.states[index]!.push(start, end, factoryStates.indexOf(s), place);
    };
  }
  move(time: number, part: Part, from: number, to: number) {
    if (this.room(time))
      this.moves.push(time, part.id, this.products.get(part.productId) ?? -1, from, to);
  }
  private walks: number[] = [];
  walk(start: number, arrive: number, w: Worker, to: number) {
    if (this.room(start)) this.walks.push(start, arrive, w.pool, w.index, to);
  }
  private drives: number[] = [];
  drive(start: number, end: number, v: Vehicle, seg: number, forward: boolean) {
    if (this.room(start))
      this.drives.push(start, end, v.fleet, v.index, seg, forward ? 1 : 0, v.part?.id ?? -1);
  }
  private belts: number[] = [];
  belt(time: number, object: number, stopped: boolean) {
    if (this.room(time)) this.belts.push(time, object, stopped ? 1 : 0);
  }
  private loads: number[] = [];
  load(time: number, v: Vehicle, part: number, from: number) {
    if (this.room(time)) this.loads.push(time, v.fleet, v.index, part, from);
  }
  private signals: number[] = [];
  signal(time: number, kind: number, index: number, value: boolean) {
    if (this.room(time)) this.signals.push(time, kind, index, value ? 1 : 0);
  }
  timeline(): FactoryTimeline {
    return {
      states: this.states,
      moves: this.moves,
      walks: this.walks,
      drives: this.drives,
      loads: this.loads,
      belts: this.belts,
      signals: this.signals,
      truncated: this.truncated,
      ...(this.cut !== undefined ? { recordedUntilMs: this.cut } : {}),
    };
  }
}

/** FT3b: one worker of a pool. */
interface Worker {
  pool: number;
  index: number;
  x: number;
  y: number;
  busy: boolean;
  /** Since when busy (walking or working), for the statistics. */
  busySince: number;
  busyMs: number;
  /** Walking inside the measured period, the last walk counted up to its end. */
  walkMs: number;
  walkFrom: number;
  walkTo: number;
}

export interface FactoryWorkerStats {
  poolId: string;
  count: number;
  /** Mean share of the period the pool's workers were taken (walking or working). */
  busyShare: number;
  /** Mean share of the period they walked. */
  walkShare: number;
  /** Mean time from asking to the workers' arrival, of the requests met in the period. */
  meanWaitMs: number;
}

/** FT3: whether `t` (ms from the start of the run) falls in one of the calendar's shifts. */
export function calendarOn(cal: FactoryCalendar, t: number): boolean {
  const r = t % cal.cycleMs;
  return cal.shifts.some((s) => s.startMs <= r && r < s.endMs);
}
/** The first time after `t` at which `calendarOn` changes, or Infinity (it never does). */
export function nextCalendarChange(cal: FactoryCalendar, t: number): number {
  const on = calendarOn(cal, t);
  // Wrapped into the cycle before sorting, so an end at `cycleMs` comes first (as 0).
  const bounds = [
    ...new Set(cal.shifts.flatMap((s) => [s.startMs % cal.cycleMs, s.endMs % cal.cycleMs])),
  ].sort((a, b) => a - b);
  const base = t - (t % cal.cycleMs);
  for (let k = 0; k < 3; k++)
    for (const b of bounds) {
      const at = base + k * cal.cycleMs + b;
      if (at > t && calendarOn(cal, at) !== on) return at;
    }
  return Infinity;
}

/** Nearest-rank percentiles and an equal-width histogram of the lead times. */
function leadTimeSpread(values: number[], min: number, max: number) {
  const sorted = Float64Array.from(values).sort();
  const rank = (p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0;
  const histogram = Array.from({ length: factoryHistogramBins }, () => 0);
  if (sorted.length) {
    const width = (max - min) / factoryHistogramBins;
    for (const v of sorted)
      histogram[
        width > 0 ? Math.min(factoryHistogramBins - 1, Math.floor((v - min) / width)) : 0
      ]!++;
  }
  return { p50Ms: rank(0.5), p90Ms: rank(0.9), p95Ms: rank(0.95), histogram };
}

/** FT6: the PLC during a run. */
interface PlcRun {
  control: FactoryControl;
  sensors: { node: Node; def: FactoryControl['sensors'][number]; name: string }[];
  actuators: { node: Node; def: FactoryControl['actuators'][number]; name: string }[];
  state: LadderState;
  power: Record<string, boolean>;
  scans: number;
  /** The last recorded value of each sensor and actuator (-1: none yet). */
  seen: number[][];
}

class Sim {
  now = 0;
  queue = new EventQueue();
  nodes: Node[] = [];
  measuring: boolean;
  private rngs: FactoryRandom[];
  private nextPartId = 1;
  private work: Node[] = [];
  private queued: boolean[] = [];
  // statistics
  wip = 0;
  private wipArea = 0;
  private wipSince = 0;
  wipMax = 0;
  produced = 0;
  /** No prototype: product IDs such as `toString` are ordinary keys. */
  producedByProduct: Record<string, number> = Object.create(null) as Record<string, number>;
  assembled = 0;
  leadSum = 0;
  leadMin = Infinity;
  leadMax = 0;
  leadTimes: number[] = [];
  flows: number[];
  recorder: Recorder | undefined;
  /** FT6. */
  lastMoveMs = -1;
  private plc: PlcRun | undefined;

  constructor(
    public doc: FactoryDocument,
    private seed: number,
    public warmup: number,
    maxRecords?: number,
  ) {
    this.flows = doc.links.map(() => 0);
    if (maxRecords !== undefined) this.recorder = new Recorder(doc, maxRecords);
    this.measuring = warmup === 0;
    this.rngs = doc.objects.map((o) => new FactoryRandom(seed, o.id));
    const byId = new Map<string, Node>();
    doc.objects.forEach((o, i) => {
      const node =
        o.kind === 'source'
          ? new SourceNode(this, i, o)
          : o.kind === 'station' || o.kind === 'parallel'
            ? new StationNode(this, i, o)
            : o.kind === 'assembly'
              ? new AssemblyNode(this, i, o)
              : o.kind === 'buffer'
                ? new BufferNode(this, i, o.capacity, o.order === 'lifo')
                : o.kind === 'conveyor'
                  ? new ConveyorNode(this, i, o)
                  : new DrainNode(this, i);
      this.nodes.push(node);
      byId.set(o.id, node);
    });
    this.setUpPaths();
    for (const link of doc.links) {
      const from = byId.get(link.from)!;
      const to = byId.get(link.to)!;
      if (link.transport) {
        const fleet = doc.fleets!.findIndex((f) => f.id === link.transport!.fleetId);
        const t = new TransportNode(
          this,
          this.nodes.length,
          link,
          from,
          fleet,
          this.pathIndex.get(from.def.pathNodeId!)!,
          this.pathIndex.get(to.def.pathNodeId!)!,
        );
        this.nodes.push(t);
        from.transports.push(t);
        from.outs.push({ link, to: t, index: doc.links.indexOf(link) });
        t.ins.push(from);
        t.outs.push({ link, to, index: -1 });
        if (!to.ins.includes(t)) to.ins.push(t);
        continue;
      }
      from.outs.push({ link, to, index: doc.links.indexOf(link) });
      if (!to.ins.includes(from)) to.ins.push(from);
    }
    this.queued = this.nodes.map(() => false);
    if (warmup > 0) this.queue.push(warmup, 'warmup', -1);
    const calendars = new Map((doc.calendars ?? []).map((c, i) => [c.id, i]));
    this.byCalendar = (doc.calendars ?? []).map(() => []);
    doc.objects.forEach((o, i) => {
      if (o.calendarId !== undefined)
        this.byCalendar[calendars.get(o.calendarId)!]!.push(this.nodes[i]!);
    });
    (doc.calendars ?? []).forEach((_, c) => this.shift(c));
    this.workers = (doc.workerPools ?? []).map((p, pool) =>
      Array.from({ length: p.count }, (_, index) => ({
        pool,
        index,
        x: p.home?.x ?? 0,
        y: p.home?.y ?? 0,
        busy: false,
        busySince: 0,
        busyMs: 0,
        walkMs: 0,
        walkFrom: 0,
        walkTo: 0,
      })),
    );
    this.waitSum = this.workers.map(() => 0);
    this.waitCount = this.workers.map(() => 0);
    if (doc.control) this.setUpControl(doc.control, byId);
  }
  /** FT6: wires the program's variables, sets the actuators to the outputs' initial values. */
  private setUpControl(control: FactoryControl, byId: Map<string, Node>) {
    const vars = ladderVariableMap(control.program);
    const wire = <T extends { objectId: string; variable: string }>(w: T) => ({
      node: byId.get(w.objectId)!,
      def: w,
      name: vars.get(w.variable)!.name,
    });
    const state = ladderInitialState(control.program);
    this.plc = {
      control,
      sensors: control.sensors.map(wire),
      actuators: control.actuators.map(wire),
      state,
      power: Object.create(null) as Record<string, boolean>,
      scans: 0,
      seen: [control.sensors.map(() => -1), control.actuators.map(() => -1)],
    };
    this.actuate();
    this.queue.push(0, 'scan', -1);
  }
  /** FT6: one PLC scan: sensors in, the program, actuators out; plans the next scan. */
  private scan() {
    const plc = this.plc!;
    const inputs = Object.create(null) as Record<string, boolean>;
    plc.sensors.forEach((w, i) => {
      const n = w.node;
      const v =
        w.def.signal === 'occupied'
          ? n.content > 0
          : w.def.signal === 'ready'
            ? n.sensorReady()
            : w.def.signal === 'blocked'
              ? n.blockedSince >= 0
              : w.def.signal === 'full'
                ? n.isFull()
                : n.isFailed();
      inputs[w.name] = v;
      this.note(0, i, v);
    });
    const r = ladderScan(plc.control.program, plc.state, inputs);
    plc.state = r.state;
    plc.power = r.power;
    plc.scans++;
    this.actuate();
    this.queue.push(this.now + plc.control.program.scanMs, 'scan', -1);
  }
  /** Records a wired signal's value when it changed (the first scan records them all). */
  private note(kind: 0 | 1, index: number, value: boolean) {
    const seen = this.plc!.seen[kind]!;
    const v = value ? 1 : 0;
    if (seen[index] === v) return;
    seen[index] = v;
    this.recorder?.signal(this.now, kind, index, value);
  }
  private actuate() {
    const plc = this.plc!;
    plc.actuators.forEach((w, i) => {
      const on = plc.state.values[w.name] === true;
      if (plc.scans > 0) this.note(1, i, on);
      const n = w.node;
      if (w.def.signal === 'run') (n as ConveyorNode).setMotor(on);
      else if (w.def.signal === 'release') n.setRelease(on);
      else n.setAdmit(on);
    });
  }
  /** FT6: objects the PLC has held for at least `stallMs` at the end. */
  private stalls(end: number): FactoryStall[] {
    const plc = this.plc!;
    const limit = plc.control.stallMs ?? 60_000;
    const out: FactoryStall[] = [];
    const seen = new Set<Node>();
    for (const w of plc.actuators) {
      const n = w.node;
      if (seen.has(n)) continue;
      let since = -1;
      let signal: FactoryActuatorSignal = 'release';
      n.clock.states.forEach((_, slot) => {
        const h = n.clock.heldSince(slot);
        if (h >= 0 && (since < 0 || h < since)) since = h;
      });
      if (since >= 0 && n instanceof ConveyorNode && !n.motorOn) signal = 'run';
      if (since < 0 && !n.admitOn) {
        const feeders = n.ins.filter((f) => f.blockedSince >= 0).map((f) => f.blockedSince);
        if (feeders.length) {
          since = Math.max(n.admitOffSince, Math.min(...feeders));
          signal = 'admit';
        }
      }
      if (since >= 0 && end - since >= limit) {
        seen.add(n);
        out.push({ objectId: n.def.id, signal, sinceMs: since });
      }
    }
    return out;
  }
  private byCalendar: Node[][];
  // FT3c vehicles
  pathIndex = new Map<string, number>();
  private pathXY: { x: number; y: number }[] = [];
  private segLen: number[] = [];
  private segHolder: number[] = [];
  private segQueue: number[][] = [];
  private adj: { seg: number; to: number; forward: boolean; len: number }[][] = [];
  private routes = new Map<number, { dist: Float64Array; via: Int32Array }>();
  vehicles: Vehicle[] = [];
  private calls: { tn: TransportNode; since: number }[] = [];
  private callWaits: { sum: number; n: number }[] = [];
  deadlock: FactoryDeadlock | undefined;
  private setUpPaths() {
    const paths = this.doc.paths;
    paths?.nodes.forEach((n, i) => {
      this.pathIndex.set(n.id, i);
      this.pathXY.push({ x: n.x, y: n.y });
      this.adj.push([]);
    });
    paths?.segments.forEach((g, k) => {
      const a = this.pathIndex.get(g.from)!;
      const b = this.pathIndex.get(g.to)!;
      const len = Math.hypot(
        this.pathXY[a]!.x - this.pathXY[b]!.x,
        this.pathXY[a]!.y - this.pathXY[b]!.y,
      );
      this.segLen.push(len);
      this.segHolder.push(-1);
      this.segQueue.push([]);
      this.adj[a]!.push({ seg: k, to: b, forward: true, len });
      if (g.twoWay) this.adj[b]!.push({ seg: k, to: a, forward: false, len });
    });
    (this.doc.fleets ?? []).forEach((f, fleet) => {
      this.callWaits.push({ sum: 0, n: 0 });
      for (let index = 0; index < f.count; index++)
        this.vehicles.push({
          id: this.vehicles.length,
          fleet,
          index,
          node: this.pathIndex.get(f.homeNodeId)!,
          seg: -1,
          waitSeg: -1,
          next: -1,
          path: [],
          task: 'idle',
          part: undefined,
          job: undefined,
          callAt: 0,
          charge: f.battery?.capacityMs ?? Infinity,
          stat: 'idle',
          since: 0,
          totals: noVehicleStates(),
          trips: 0,
        });
    });
  }
  /** Shortest distances (mm) from path node `src` (Dijkstra), cached. */
  private route(src: number) {
    let r = this.routes.get(src);
    if (r) return r;
    const n = this.pathXY.length;
    const dist = new Float64Array(n).fill(Infinity);
    const via = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[src] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i]! < dist[u]!)) u = i;
      if (u < 0 || dist[u] === Infinity) break;
      done[u] = 1;
      this.adj[u]!.forEach((e, k) => {
        if (dist[u]! + e.len < dist[e.to]!) {
          dist[e.to] = dist[u]! + e.len;
          via[e.to] = u * 65536 + k;
        }
      });
    }
    r = { dist, via };
    this.routes.set(src, r);
    return r;
  }
  private pathTo(src: number, dst: number) {
    const { via } = this.route(src);
    const steps: Vehicle['path'] = [];
    for (let at = dst; at !== src; ) {
      const v = via[at]!;
      if (v < 0) return undefined;
      const u = Math.floor(v / 65536);
      const e = this.adj[u]![v % 65536]!;
      steps.unshift({ seg: e.seg, to: e.to, forward: e.forward });
      at = u;
    }
    return steps;
  }
  private vehicleStat(v: Vehicle) {
    const s: FactoryVehicleState =
      v.task === 'idle'
        ? 'idle'
        : v.task === 'charging'
          ? 'charging'
          : v.task === 'atDrop'
            ? 'blocked'
            : v.task === 'atPickup' || v.task === 'loading' || v.task === 'unloading'
              ? 'handling'
              : v.waitSeg >= 0
                ? 'traffic'
                : v.task === 'toDrop'
                  ? 'loaded'
                  : 'empty';
    v.totals[v.stat] += this.now - v.since;
    v.since = this.now;
    v.stat = s;
  }
  private setTask(v: Vehicle, task: VehicleTask) {
    this.vehicleStat(v);
    v.task = task;
    this.vehicleStat(v);
  }
  private fleetOf(v: Vehicle) {
    return this.doc.fleets![v.fleet]!;
  }
  /** Takes the next segment of the vehicle's path, or waits for it; arrives at the end. */
  private driveOn(v: Vehicle) {
    const step = v.path[0];
    if (!step) return this.arrived(v);
    const q = this.segQueue[step.seg]!;
    const h = this.segHolder[step.seg]!;
    if ((h >= 0 && h !== v.id) || (h < 0 && q.length && q[0] !== v.id)) {
      if (v.waitSeg !== step.seg) {
        this.vehicleStat(v);
        v.waitSeg = step.seg;
        q.push(v.id);
        this.vehicleStat(v);
        this.checkDeadlock(v);
      }
      return;
    }
    if (q[0] === v.id) q.shift();
    const before = v.seg;
    this.segHolder[step.seg] = v.id;
    this.vehicleStat(v);
    v.seg = step.seg;
    v.waitSeg = -1;
    v.path.shift();
    v.node = -1;
    v.next = step.to;
    this.vehicleStat(v);
    if (before >= 0 && before !== step.seg) this.freeSegment(before);
    const t = Math.max(1, Math.ceil((this.segLen[step.seg]! * 1000) / this.fleetOf(v).speedMmS));
    v.charge -= t;
    this.recorder?.drive(this.now, this.now + t, v, step.seg, step.forward);
    this.queue.push(this.now + t, 'drive', v.id);
  }
  private driven(v: Vehicle) {
    v.node = v.next;
    this.driveOn(v);
  }
  private freeSegment(seg: number) {
    this.segHolder[seg] = -1;
    const w = this.segQueue[seg]![0];
    if (w !== undefined) this.driveOn(this.vehicles[w]!);
  }
  /** Follows who waits for whom; a circle back to `v` is a deadlock. */
  private checkDeadlock(v: Vehicle) {
    const chain: Vehicle[] = [];
    let cur = v;
    for (let i = 0; i <= this.vehicles.length; i++) {
      chain.push(cur);
      if (cur.waitSeg < 0) return;
      const h = this.segHolder[cur.waitSeg]!;
      if (h < 0) return;
      if (h === v.id) {
        this.deadlock = {
          atMs: this.now,
          vehicles: chain.map((x) => `${this.fleetOf(x).id}#${x.index + 1}`),
          segments: chain.map((x) => this.doc.paths!.segments[x.seg]?.id ?? ''),
        };
        return;
      }
      cur = this.vehicles[h]!;
    }
  }
  private arrived(v: Vehicle) {
    if (v.seg >= 0) {
      const s = v.seg;
      v.seg = -1;
      this.freeSegment(s);
    }
    const f = this.fleetOf(v);
    if (v.task === 'toPickup') {
      this.setTask(v, 'atPickup');
      if (this.measuring) {
        this.callWaits[v.fleet]!.sum += this.now - v.callAt;
        this.callWaits[v.fleet]!.n++;
      }
      v.job!.atPickup.push(v);
      this.wake(v.job!.from);
      this.queue.push(this.now, 'agv', v.id, AGV_CHECK);
    } else if (v.task === 'toDrop') {
      this.setTask(v, 'unloading');
      this.queue.push(this.now + f.unloadMs, 'agv', v.id, AGV_UNLOADED);
    } else if (v.task === 'toCharger') {
      this.setTask(v, 'charging');
      const b = f.battery!;
      const need = Math.max(0, b.capacityMs - v.charge);
      this.queue.push(
        this.now + Math.ceil((need / b.capacityMs) * b.chargeMs),
        'agv',
        v.id,
        AGV_CHARGED,
      );
    }
  }
  private vehicleEvent(v: Vehicle, what: number) {
    if (what === AGV_CHECK) {
      // Nothing to load (the part went another way): free again.
      if (v.task !== 'atPickup') return;
      const tn = v.job!;
      tn.atPickup.splice(tn.atPickup.indexOf(v), 1);
      tn.pending--;
      tn.from.refreshState();
      v.job = undefined;
      this.vehicleIdle(v);
    } else if (what === AGV_LOADED) {
      this.setTask(v, 'toDrop');
      v.path = this.pathTo(v.node, v.job!.drop) ?? [];
      this.driveOn(v);
    } else if (what === AGV_UNLOADED) {
      this.setTask(v, 'atDrop');
      v.job!.atDrop.push(v);
      this.wake(v.job!);
    } else if (what === AGV_CHARGED) {
      v.charge = this.fleetOf(v).battery!.capacityMs;
      this.vehicleIdle(v);
    }
  }
  callVehicle(tn: TransportNode) {
    this.calls.push({ tn, since: this.now });
    this.assignVehicles();
  }
  loadVehicle(v: Vehicle, part: Part, from: number) {
    v.part = part;
    this.recorder?.load(this.now, v, part.id, from);
    this.setTask(v, 'loading');
    if (this.measuring) v.trips++;
    this.queue.push(this.now + this.fleetOf(v).loadMs, 'agv', v.id, AGV_LOADED);
  }
  vehicleDone(v: Vehicle) {
    v.part = undefined;
    v.job = undefined;
    this.vehicleIdle(v);
  }
  private vehicleIdle(v: Vehicle) {
    this.setTask(v, 'idle');
    const b = this.fleetOf(v).battery;
    if (b && v.charge < b.rechargeBelow * b.capacityMs && this.sendToCharger(v)) return;
    this.assignVehicles();
  }
  private sendToCharger(v: Vehicle) {
    const b = this.fleetOf(v).battery!;
    const path = this.pathTo(v.node, this.pathIndex.get(b.chargerNodeId)!);
    if (!path) return false;
    this.setTask(v, 'toCharger');
    v.path = path;
    this.driveOn(v);
    return true;
  }
  /** FT3c: the driving time from `src` to `dst` on the shortest path, as `driveOn` counts it. */
  private driveMs(src: number, dst: number, fleet: number) {
    const path = this.pathTo(src, dst);
    if (!path) return Infinity;
    const speed = this.doc.fleets![fleet]!.speedMmS;
    return path.reduce(
      (t, step) => t + Math.max(1, Math.ceil((this.segLen[step.seg]! * 1000) / speed)),
      0,
    );
  }
  /** Serves the calls in order, each by the nearest idle vehicle of its fleet that can get there. */
  private assignVehicles() {
    for (let i = 0; i < this.calls.length; i++) {
      const c = this.calls[i]!;
      // More vehicles called than parts left to carry: this call is no longer needed.
      if (c.tn.pending > c.tn.eligible()) {
        c.tn.pending--;
        this.calls.splice(i--, 1);
        continue;
      }
      // A drop that no path reaches is never served: the part keeps waiting at its sender.
      if (this.route(c.tn.pickup).dist[c.tn.drop] === Infinity) continue;
      const battery = this.doc.fleets![c.tn.fleet]!.battery;
      const carry = battery ? this.driveMs(c.tn.pickup, c.tn.drop, c.tn.fleet) : 0;
      let best: Vehicle | undefined;
      let bestD = Infinity;
      let low: Vehicle | undefined;
      for (const v of this.vehicles) {
        if (v.fleet !== c.tn.fleet || v.task !== 'idle') continue;
        const d = this.route(v.node).dist[c.tn.pickup]!;
        // With a battery, the vehicle takes the job only with charge for both drives.
        if (battery && v.charge < this.driveMs(v.node, c.tn.pickup, v.fleet) + carry) {
          if (v.charge < battery.capacityMs) low ??= v;
          continue;
        }
        if (d < bestD) {
          best = v;
          bestD = d;
        }
      }
      if (!best) {
        // None has the charge: an idle vehicle that is not full goes to charge first.
        if (low) this.sendToCharger(low);
        continue;
      }
      this.calls.splice(i--, 1);
      best.job = c.tn;
      best.callAt = c.since;
      this.setTask(best, 'toPickup');
      best.path = this.pathTo(best.node, c.tn.pickup) ?? [];
      this.driveOn(best);
    }
  }

  // FT3b workers
  private workers: Worker[][] = [];
  private asks: { node: ProcessNode; slot: number; need: FactoryWorkerNeed; since: number }[] = [];
  private waitSum: number[] = [];
  private waitCount: number[] = [];
  /** Wait samples whose crew is still walking (they may arrive after the end). */
  private unarrived: { at: number; wait: number; pool: number }[] = [];
  private poolsFor(need: FactoryWorkerNeed) {
    return (this.doc.workerPools ?? [])
      .map((_, i) => i)
      .filter(
        (i) => need.skill === undefined || this.doc.workerPools![i]!.skills.includes(need.skill),
      );
  }
  askWorkers(node: ProcessNode, slot: number, need: FactoryWorkerNeed) {
    this.asks.push({ node, slot, need, since: this.now });
    this.assignWorkers();
  }
  freeWorkers(crew: Worker[]) {
    for (const w of crew) {
      w.busy = false;
      if (this.measuring) w.busyMs += this.now - Math.max(w.busySince, this.warmup);
    }
    this.assignWorkers();
  }
  /** Serves the requests in order; each takes the nearest free workers that can do it. */
  private assignWorkers() {
    for (let i = 0; i < this.asks.length; i++) {
      const a = this.asks[i]!;
      const pos = a.node.def.at ?? { x: 0, y: 0 };
      const free: { w: Worker; d: number }[] = [];
      for (const pool of this.poolsFor(a.need))
        for (const w of this.workers[pool]!)
          if (!w.busy) free.push({ w, d: Math.hypot(w.x - pos.x, w.y - pos.y) });
      if (free.length < a.need.count) continue;
      free.sort((p, q) => p.d - q.d || p.w.pool - q.w.pool || p.w.index - q.w.index);
      const crew = free.slice(0, a.need.count);
      let arrive = this.now;
      for (const { w, d } of crew) {
        const speed = this.doc.workerPools![w.pool]!.walkSpeedMmS;
        const at = this.now + Math.ceil((d * 1000) / speed);
        if (this.measuring) w.walkMs += at - this.now;
        w.walkFrom = this.now;
        w.walkTo = at;
        this.recorder?.walk(this.now, at, w, a.node.index);
        w.busy = true;
        w.busySince = this.now;
        w.x = pos.x;
        w.y = pos.y;
        arrive = Math.max(arrive, at);
      }
      // A request counts when its crew arrives inside the measured period: from the warm-up on
      // here, and those arriving after the end are taken off in finish().
      if (arrive >= this.warmup) {
        this.unarrived = this.unarrived.filter((u) => u.at > this.now);
        for (const pool of new Set(crew.map((c) => c.w.pool))) {
          this.waitSum[pool]! += arrive - a.since;
          this.waitCount[pool]!++;
          if (arrive > this.now) this.unarrived.push({ at: arrive, wait: arrive - a.since, pool });
        }
      }
      this.asks.splice(i--, 1);
      a.node.staffed(
        a.slot,
        crew.map((c) => c.w),
        arrive,
      );
    }
  }
  rngFor(i: number) {
    return this.rngs[i]!;
  }
  private extra = new Map<string, FactoryRandom>();
  /**
   * FT3: a stream of its own per object and purpose (uptime, repair, setup), so that adding
   * failures or setups does not change the processing times drawn (common random numbers).
   */
  extraRng(i: number, purpose: string) {
    const key = `${i}:${purpose}`;
    let r = this.extra.get(key);
    if (!r)
      this.extra.set(
        key,
        (r = new FactoryRandom(this.seed, `${this.doc.objects[i]!.id}\u0000${purpose}`)),
      );
    return r;
  }
  /** FT3: turns the objects of calendar `c` on or off, and plans its next change. */
  private shift(c: number) {
    const cal = this.doc.calendars![c]!;
    const on = calendarOn(cal, this.now);
    for (const n of this.byCalendar[c]!) if (n.offShift === on) n.setShift(on);
    const next = nextCalendarChange(cal, this.now);
    if (Number.isFinite(next)) this.queue.push(next, 'shift', c);
  }
  newPart(productId: string): Part {
    this.setWip(this.wip + 1);
    return { id: this.nextPartId++, productId, createdAt: this.now };
  }
  private setWip(n: number) {
    this.wipArea += this.wip * (this.now - this.wipSince);
    this.wipSince = this.now;
    this.wip = n;
    if (n > this.wipMax) this.wipMax = n;
  }
  /** `count` components became part of an assembled part. */
  consume(count: number) {
    this.setWip(this.wip - count);
    if (this.measuring) this.assembled += count;
  }
  removeFromModel(part: Part) {
    this.setWip(this.wip - 1);
    if (!this.measuring) return;
    this.produced++;
    this.producedByProduct[part.productId] = (this.producedByProduct[part.productId] ?? 0) + 1;
    const lead = this.now - part.createdAt;
    this.leadSum += lead;
    if (this.leadTimes.length < factoryLimits.events) this.leadTimes.push(lead);
    this.leadMin = Math.min(this.leadMin, lead);
    this.leadMax = Math.max(this.leadMax, lead);
  }
  /** Asks `node` to hand on its ready parts after the current event. */
  wake(node: Node) {
    if (this.queued[node.index]) return;
    this.queued[node.index] = true;
    this.work.push(node);
  }
  /** Room opened in `node`: its blocked feeders try again, longest-blocked first. */
  wakeFeeders(node: Node) {
    const waiting = node.ins.filter((n) => n.blockedSince >= 0);
    waiting.sort((a, b) => a.blockedSince - b.blockedSince || a.index - b.index);
    waiting.forEach((n) => this.wake(n));
  }
  private target(node: Node, part: Part): Node['outs'][number] | undefined {
    const outs = node.outs;
    const open = (i: number) => {
      const o = outs[i]!;
      return (
        (!o.link.productIds || o.link.productIds.includes(part.productId)) &&
        o.to.admitOn &&
        o.to.accepts(part)
      );
    };
    const queued = (to: Node) => (to instanceof TransportNode ? to.to : to).content;
    const strategy = node.def.exit ?? 'first-free';
    if (strategy === 'cyclic') {
      for (let k = 1; k <= outs.length; k++) {
        const i = (node.lastOut + k) % outs.length;
        if (open(i)) return ((node.lastOut = i), outs[i]!);
      }
      return undefined;
    }
    let best = -1;
    for (let i = 0; i < outs.length; i++) {
      if (!open(i)) continue;
      if (strategy === 'first-free') return outs[i]!;
      // A carried link counts the parts at its destination, not on its vehicles.
      if (best < 0 || queued(outs[i]!.to) < queued(outs[best]!.to)) best = i;
    }
    return best < 0 ? undefined : outs[best]!;
  }
  /** Hands on every ready part of `node` that some successor accepts. */
  private forward(node: Node) {
    // FT6: with its release off, nothing leaves the object.
    const ready = () => (node.releaseOn ? node.ready() : []);
    for (;;) {
      let moved = false;
      for (const part of ready()) {
        const out = this.target(node, part);
        if (!out) continue;
        node.blockedSince = -1;
        node.release(part);
        if (this.measuring && out.index >= 0) this.flows[out.index]!++;
        // A part in a vehicle moves from the link's `from` to its `to` when unloaded.
        if (!(out.to instanceof TransportNode))
          this.recorder?.move(
            this.now,
            part,
            node instanceof TransportNode ? node.from.index : node.index,
            out.to.index,
          );
        out.to.receive(part);
        this.lastMoveMs = this.now;
        this.wakeFeeders(node);
        moved = true;
        break;
      }
      if (!moved) break;
    }
    const stuck = ready().length > 0;
    if (stuck && node.blockedSince < 0) node.blockedSince = this.now;
    if (!stuck) node.blockedSince = -1;
    node.refreshState();
  }
  private drain() {
    while (this.work.length) {
      const node = this.work.shift()!;
      this.queued[node.index] = false;
      this.forward(node);
    }
  }
  /** Events handled so far, over every slice of the run. */
  handled = 0;
  /** True once the run reached its end or a deadlock. */
  ended = false;
  /**
   * #17: handles events up to `end`, at most `budget` of them in this call, and stops with
   * `event-limit` past `maxEvents` in all. A later call goes on from the next event: a run handled
   * in slices takes the same steps as one handled at once.
   */
  advance(end: number, maxEvents: number, budget = Infinity): boolean {
    let here = 0;
    for (;;) {
      const e = this.queue.peek();
      if (!e || e.time > end) break;
      // Shifts at one instant are taken together (see below), so a slice never ends between them.
      if (here >= budget && !(e.kind === 'shift' && this.inShifts)) return false;
      this.queue.pop();
      here++;
      if (++this.handled > maxEvents)
        throw new FactoryValidationError('event-limit', `more than ${maxEvents} events`);
      this.now = e.time;
      if (e.kind === 'warmup') this.startMeasuring();
      else if (e.kind === 'shift') this.shift(e.node);
      else if (e.kind === 'drive') this.driven(this.vehicles[e.node]!);
      else if (e.kind === 'agv') this.vehicleEvent(this.vehicles[e.node]!, e.slot);
      else if (e.kind === 'scan') this.scan();
      else this.nodes[e.node]!.onEvent(e.kind, e.slot, e.tag);
      // Every calendar that changes at this instant changes before any part moves (shift events
      // come first at equal times), so the order of the calendars cannot change the result.
      const next = this.queue.peek();
      this.inShifts = e.kind === 'shift' && next?.kind === 'shift' && next.time === e.time;
      if (this.inShifts) continue;
      this.drain();
      if (this.deadlock) {
        // Stopped in the warm-up: the measured period is empty, at the deadlock.
        if (!this.measuring) this.startMeasuring();
        this.ended = true;
        return true;
      }
    }
    this.now = end;
    this.ended = true;
    return true;
  }
  private inShifts = false;
  run(end: number, maxEvents: number): number {
    this.advance(end, maxEvents);
    return this.handled;
  }
  private startMeasuring() {
    this.measuring = true;
    this.wipArea = 0;
    this.wipSince = this.now;
    this.wipMax = this.wip;
    for (const n of this.nodes) n.resetStats(this.now);
    for (const v of this.vehicles) {
      this.vehicleStat(v);
      v.totals = noVehicleStates();
      v.trips = 0;
    }
    this.callWaits = this.callWaits.map(() => ({ sum: 0, n: 0 }));
    for (const ws of this.workers)
      for (const w of ws) {
        w.busyMs = 0;
        // A walk going on at the end of the warm-up counts from here.
        w.walkMs = Math.max(0, w.walkTo - this.now);
      }
  }
  finish(start: number, events: number, seed: number): FactoryRunResult {
    const end = this.now;
    const period = end - start;
    // Before the clocks close their open intervals (which moves where `held` began).
    const stalls = this.plc ? this.stalls(end) : [];
    for (const u of this.unarrived)
      if (u.at > end) {
        this.waitSum[u.pool]! -= u.wait;
        this.waitCount[u.pool]!--;
      }
    this.unarrived = [];
    this.wipArea += this.wip * (end - this.wipSince);
    for (const v of this.vehicles) this.vehicleStat(v);
    const objects: FactoryObjectStats[] = this.nodes.slice(0, this.doc.objects.length).map((n) => {
      n.clock.flush(end);
      n.clock.close(end);
      n.closeActive(end);
      const places = n.clock.states.length;
      const states = { ...n.clock.totals };
      for (const s of factoryStates) states[s] /= places;
      return {
        id: n.def.id,
        kind: n.def.kind,
        states,
        entered: n.entered,
        exited: n.exited,
        meanContent: n.meanContent(end, period),
        maxContent: n.maxContent,
      };
    });
    return {
      seed,
      startMs: start,
      endMs: end,
      events,
      produced: this.produced,
      producedByProduct: Object.fromEntries(Object.entries(this.producedByProduct)),
      throughputPerHour: period > 0 ? (this.produced * 3_600_000) / period : 0,
      leadTime: {
        count: this.produced,
        meanMs: this.produced ? this.leadSum / this.produced : 0,
        minMs: this.produced ? this.leadMin : 0,
        maxMs: this.leadMax,
        ...leadTimeSpread(this.leadTimes, this.leadMin, this.leadMax),
      },
      wip: { mean: period > 0 ? this.wipArea / period : this.wip, max: this.wipMax },
      flows: Object.fromEntries(this.doc.links.map((l, i) => [l.id, this.flows[i]!])),
      assembled: this.assembled,
      objects,
      workers: (this.doc.workerPools ?? []).map((p, pool) => {
        const ws = this.workers[pool]!;
        let busy = 0;
        let walk = 0;
        for (const w of ws) {
          busy += w.busyMs + (w.busy ? end - Math.max(w.busySince, start) : 0);
          // The last walk may reach past the end of the period.
          walk += w.walkMs - Math.max(0, w.walkTo - Math.max(end, w.walkFrom, start));
        }
        return {
          poolId: p.id,
          count: p.count,
          busyShare: period > 0 ? busy / ws.length / period : 0,
          walkShare: period > 0 ? walk / ws.length / period : 0,
          meanWaitMs: this.waitCount[pool]! ? this.waitSum[pool]! / this.waitCount[pool]! : 0,
        };
      }),
      fleets: (this.doc.fleets ?? []).map((f, fleet) => {
        const vs = this.vehicles.filter((v) => v.fleet === fleet);
        const shares = Object.fromEntries(
          factoryVehicleStates.map((k) => [
            k,
            period > 0 ? vs.reduce((n, v) => n + v.totals[k], 0) / vs.length / period : 0,
          ]),
        ) as Record<FactoryVehicleState, number>;
        return {
          fleetId: f.id,
          count: f.count,
          shares,
          trips: vs.reduce((n, v) => n + v.trips, 0),
          meanCallWaitMs: this.callWaits[fleet]!.n
            ? this.callWaits[fleet]!.sum / this.callWaits[fleet]!.n
            : 0,
        };
      }),
      ...(this.deadlock ? { deadlock: this.deadlock } : {}),
      ...(this.plc
        ? {
            control: {
              scans: this.plc.scans,
              lastMoveMs: this.lastMoveMs,
              stalls,
              state: this.plc.state,
              power: { ...this.plc.power },
            },
          }
        : {}),
      ...(this.recorder ? { timeline: this.recorder.timeline() } : {}),
      bottlenecks: activePeriodBottlenecks(
        this.nodes
          .filter((n) => ['station', 'parallel', 'assembly'].includes(n.def.kind))
          .map((n) => ({ id: n.def.id, periods: n.active })),
        period,
      ),
    };
  }
}

/**
 * The active-period method: at each instant the bottleneck is the object whose current working
 * period is the longest. Where the periods of two successive bottlenecks overlap, both count the
 * overlap as shifting; the rest of their bottleneck time is sole.
 */
export function activePeriodBottlenecks(
  objects: { id: string; periods: number[] }[],
  period: number,
): FactoryBottleneck[] {
  type P = { obj: number; start: number; end: number };
  const all: P[] = [];
  objects.forEach((o, obj) => {
    for (let i = 0; i < o.periods.length; i += 2)
      all.push({ obj, start: o.periods[i]!, end: o.periods[i + 1]! });
  });
  // Sweep: boundaries of all periods; between two, the longest covering period wins.
  const cuts = [...new Set(all.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const byStart = [...all].sort((a, b) => a.start - b.start);
  const heap: P[] = [];
  const longer = (a: P, b: P) =>
    a.end - a.start > b.end - b.start || (a.end - a.start === b.end - b.start && a.obj < b.obj);
  const push = (p: P) => {
    heap.push(p);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (!longer(heap[i]!, heap[q]!)) break;
      [heap[i], heap[q]] = [heap[q]!, heap[i]!];
      i = q;
    }
  };
  const pop = () => {
    const last = heap.pop()!;
    if (!heap.length) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && longer(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && longer(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  };
  const segments: { p: P; start: number; end: number }[] = [];
  let k = 0;
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c]!;
    const b = cuts[c + 1]!;
    while (k < byStart.length && byStart[k]!.start <= a) push(byStart[k++]!);
    while (heap.length && heap[0]!.end <= a) pop();
    if (!heap.length) continue;
    const top = heap[0]!;
    const last = segments[segments.length - 1];
    if (last && last.p === top && last.end === a) last.end = b;
    else segments.push({ p: top, start: a, end: b });
  }
  // A shifting bottleneck: where the periods of two successive winners overlap, both are the
  // bottleneck. That time counts for both and is taken out of their sole time.
  const own: [number, number][][] = objects.map(() => []);
  const shift: [number, number][][] = objects.map(() => []);
  for (const s of segments) own[s.p.obj]!.push([s.start, s.end]);
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1]!.p;
    const b = segments[i]!.p;
    if (a.obj === b.obj) continue;
    const from = Math.max(a.start, b.start);
    const to = Math.min(a.end, b.end);
    if (to <= from) continue;
    shift[a.obj]!.push([from, to]);
    shift[b.obj]!.push([from, to]);
  }
  return objects
    .map((o, i) => {
      const n = o.periods.length / 2;
      let total = 0;
      for (let j = 0; j < o.periods.length; j += 2) total += o.periods[j + 1]! - o.periods[j]!;
      const sh = union(shift[i]!);
      const won = union(own[i]!);
      const soleMs = length(won) - length(intersect(won, sh));
      const shiftingMs = length(sh);
      return {
        id: o.id,
        soleMs,
        shiftingMs,
        share: period > 0 ? (soleMs + shiftingMs) / period : 0,
        meanActiveMs: n ? total / n : 0,
      };
    })
    .sort((a, b) => b.share - a.share || b.meanActiveMs - a.meanActiveMs);
}

/** Sorted, non-overlapping intervals covering the same time. */
function union(list: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
/** The overlap of two unions. */
function intersect(x: [number, number][], y: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const a = Math.max(x[i]![0], y[j]![0]);
    const b = Math.min(x[i]![1], y[j]![1]);
    if (a < b) out.push([a, b]);
    if (x[i]![1] < y[j]![1]) i++;
    else j++;
  }
  return out;
}
const length = (list: [number, number][]) => list.reduce((t, [a, b]) => t + b - a, 0);

function prepareRun(doc: FactoryDocument, options: FactoryRunOptions) {
  const problems = validateFactory(doc);
  if (problems.length)
    throw new FactoryValidationError(problems[0]!.code, problems[0]!.message, problems);
  const seed = options.seed ?? doc.run.seed;
  const warmup = options.warmupMs ?? doc.run.warmupMs ?? 0;
  const duration = options.durationMs ?? doc.run.durationMs;
  const maxEvents = Math.min(options.maxEvents ?? factoryLimits.events, factoryLimits.events);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new FactoryValidationError('seed', 'seed must be 0 to 2³²−1');
  if (
    !Number.isInteger(warmup) ||
    !Number.isInteger(duration) ||
    warmup < 0 ||
    duration < 1 ||
    warmup + duration > factoryLimits.maxTimeMs
  )
    throw new FactoryValidationError('time', 'warm-up and duration must fit in one year');
  if (
    doc.control &&
    Math.ceil((warmup + duration) / doc.control.program.scanMs) > factoryLimits.scans
  )
    throw new FactoryValidationError(
      'limit-scans',
      `more than ${factoryLimits.scans} PLC scans: a longer scan period or a shorter run`,
    );
  const maxRecords = options.record
    ? Number.isFinite(options.maxRecords)
      ? Math.max(0, Math.min(Math.floor(options.maxRecords!), 2_000_000))
      : 2_000_000
    : undefined;
  return {
    sim: new Sim(doc, seed, warmup, maxRecords),
    seed,
    warmup,
    end: warmup + duration,
    maxEvents,
  };
}

/** Runs the model once. Refuses an invalid document (`FactoryValidationError`). */
export function runFactory(
  doc: FactoryDocument,
  options: FactoryRunOptions = {},
): FactoryRunResult {
  const run = startFactoryRun(doc, options);
  run.advance();
  return run.finish();
}

/** #17: how far a run handled in slices has come. */
export interface FactoryRunProgress {
  done: boolean;
  /** Events handled so far. */
  events: number;
  /** Simulated time reached, and where the run ends (ms, warm-up included). */
  simMs: number;
  endMs: number;
}

/**
 * #17: a run handled in slices. Each `advance(events)` handles at most that many more events and
 * keeps the run's whole state for the next one, so a long run (a simulated year) is taken in
 * chunks with progress between them, and gives the same result as one handled at once.
 */
export interface FactoryRunHandle {
  advance(events?: number): FactoryRunProgress;
  progress(): FactoryRunProgress;
  /** The result, once `advance` reported `done`. */
  finish(): FactoryRunResult;
}

/** #17: starts a run to be handled in slices. Refuses an invalid document as `runFactory` does. */
export function startFactoryRun(
  doc: FactoryDocument,
  options: FactoryRunOptions = {},
): FactoryRunHandle {
  const { sim, seed, warmup, end, maxEvents } = prepareRun(doc, options);
  let finished: FactoryRunResult | undefined;
  const progress = (): FactoryRunProgress => ({
    done: sim.ended,
    events: sim.handled,
    simMs: sim.ended ? sim.now : Math.min(sim.now, end),
    endMs: end,
  });
  return {
    advance(events = Infinity) {
      if (!sim.ended) sim.advance(end, maxEvents, Math.max(1, events));
      return progress();
    },
    progress,
    finish() {
      if (!sim.ended) throw new Error('The run has not finished');
      return (finished ??= sim.finish(Math.min(warmup, sim.now), sim.handled, seed));
    },
  };
}
