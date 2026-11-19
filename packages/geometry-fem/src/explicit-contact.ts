/**
 * VS6a: contact for the explicit solver: every shell against every node (self contact included)
 * and the nodes against rigid walls (planes) and poles (cylinders), with penalty springs and
 * Coulomb friction.
 *
 * Penalty: a spring k = penalty · m / Δt² on the penetration (m the smaller of the node's mass
 * and the segment point's effective mass 1 / Σ wₖ²/mₖ over its barycentric weights; a rigid
 * body's nodes each carry the smaller of their share of the body's mass and the body's effective
 * mass along the push, its turning included; Δt the step the solver takes, which the contacts
 * cut so that no node crosses √(p/10) of the thinnest band in one step), as explicit
 * codes' soft-constraint contact does: it stays stable with the step whatever the materials, and
 * a penalty of 0.1 holds a node at v·Δt/√0.1 at most. Surfaces are the shells' midsurfaces offset
 * by half their thickness on both sides; a node touches the nearest segment (two triangles of its
 * quad) within the two halves. A node and the segments of its own sheet (joined through shared
 * nodes) already within the gap at the start never touch: they are its neighbours in the sheet,
 * not contact (with `ignoreInitial`, any segment within the gap at the start). Friction: the tangential force opposes the sliding, μ times the normal force at
 * most and never more than stops the sliding within a step; between shells it acts at one point
 * between the two midsurfaces (split in proportion to their half thicknesses), with the moments
 * that puts on both, so the pair keeps its angular momentum.
 *
 * Search: a spatial hash of the segments' boxes grown by the largest gap and a margin, rebuilt
 * only when a node has moved more than half the margin; each node looks in its own cell. Out of
 * scope: edge-to-edge contact, moving walls, contact of beams.
 */

export interface ExplicitContact {
  /** Coulomb friction coefficient (0 by default). */
  friction?: number;
  /** Penalty scale (0.1 by default, at most 1). */
  penalty?: number;
  /**
   * VS8c: a node and any segment (of any sheet) already within the gap at the start never touch,
   * as for the sheet neighbours: the parts of an assembly that meet at their joints (a member's
   * end against the next one's face, half thicknesses overlapping) start without contact
   * forces. False by default (only a node's own sheet).
   */
  ignoreInitial?: boolean;
}

/** A fixed rigid plane; nodes stay on the side its normal points to. */
export interface ExplicitWall {
  point: [number, number, number];
  normal: [number, number, number];
  friction?: number;
}

/** A fixed rigid cylinder of infinite length; nodes stay outside. */
export interface ExplicitPole {
  point: [number, number, number];
  axis: [number, number, number];
  radius: number;
  friction?: number;
}

export interface ContactInput {
  nodeCount: number;
  shells: Uint32Array;
  thickness: Float64Array;
  /** Effective mass per node (t): its own, or for a rigid body's node its share of the body's. */
  mass: Float64Array;
  /**
   * The effective mass (t) for a push along the unit d at the point o (mm) off node i: with the
   * node's rotary inertia, or for a rigid body's node the body's translation and turning about
   * its centre, 1 / (1/M + (r × d)ᵀ I⁻¹ (r × d)). Without it: the node's mass.
   */
  massAt?: (
    i: number,
    dx: number,
    dy: number,
    dz: number,
    ox: number,
    oy: number,
    oz: number,
  ) => number;
  /** Node positions at the start (for the sheet neighbours that never touch). */
  x0: Float64Array;
  /** Rigid body of each node (−1: none); a node and a segment of one body do not touch. */
  bodyOf: Int32Array;
  /** Shells that take no part (erased): checked on each call. */
  erased: Uint8Array;
  contact?: ExplicitContact;
  walls: ExplicitWall[];
  poles: ExplicitPole[];
  step: number;
}

const unit = (p: number[]) => {
  const l = Math.hypot(p[0]!, p[1]!, p[2]!);
  return p.map((c) => c / l);
};

export class ContactSet {
  /** Half the thickest shell on each node (mm). */
  private readonly half: Float64Array;
  private readonly walls: { p: number[]; n: number[]; mu: number }[];
  private readonly poles: { p: number[]; a: number[]; r: number; mu: number }[];
  /**
   * The thinnest contact band (mm): half the thinnest shell for the barriers, the thinnest
   * shell between shells.
   */
  readonly band: number;
  /**
   * The most a node moves in one step (mm): √(p/10) of the band (a tenth at the default
   * penalty p = 0.1). A spring k = p·m/Δt² stops a node coming in at s per step within
   * s/√p, so a node stops within a third of the band, before it reaches the midsurface,
   * whatever the penalty.
   */
  readonly travel: number;
  /** The step the springs are set for (s): the solver's, or less (see `forces`). */
  stepNow: number;
  /** Force on each wall then each pole (N, 3 each) at the last call. */
  readonly barrierForce: Float64Array;
  private readonly penalty: number;
  private readonly friction: number;
  private readonly self: boolean;
  /** Nodes that take part (in a shell not erased, with mass), and all nodes with mass. */
  private active: Uint32Array;
  private readonly massive: Uint32Array;
  /**
   * Per rigid body: its contacts now, with the barriers and with the shells (counted first).
   * Each of them pushes the same body: a contact's mass is the body's effective mass there over
   * their number, so that together they stop at most the body's slip and hold its springs stable.
   */
  private readonly hits: Uint32Array;
  private readonly shellHits: Uint32Array;
  /** The shell contacts found at this call (8 numbers each, see `shellSearch`). */
  private readonly found: number[] = [];
  /**
   * Per node in no rigid body: the summed weight of its contacts (barriers now, 1 each; shells
   * now, 1 as the pushed node, its barycentric weight w as a pushed segment's
   * corner). In a contact's penalty mass and its friction cap the node's term is W/m instead of
   * w²/m (its mass shared as m·w²/W), so that the contacts on it together stop at most its own
   * slip (Σ w·J ≤ m·v) and their springs together are at most one spring on its own mass
   * (Σ w²·k ≤ p·m/Δt²).
   */
  private readonly nodeHits: Float64Array;
  private readonly nodeShellHits: Float64Array;
  /** The erased-shell count the nodes' thickness and membership were taken at. */
  private erasedSeen = 0;
  private readonly best = { d: 0, s: 0, tri: 0, u: 0, v: 0, cx: 0, cy: 0, cz: 0 };

  constructor(private readonly input: ContactInput) {
    const { nodeCount: n, mass } = input;
    this.half = new Float64Array(n);
    this.hits = new Uint32Array(n);
    this.shellHits = new Uint32Array(n);
    this.nodeHits = new Float64Array(n);
    this.nodeShellHits = new Float64Array(n);
    this.walls = input.walls.map((w) => ({ p: w.point, n: unit(w.normal), mu: w.friction ?? 0 }));
    this.poles = input.poles.map((q) => ({
      p: q.point,
      a: unit(q.axis),
      r: q.radius,
      mu: q.friction ?? 0,
    }));
    this.barrierForce = new Float64Array(3 * (this.walls.length + this.poles.length));
    this.stepNow = input.step;
    this.self = !!input.contact;
    this.penalty = input.contact?.penalty ?? 0.1;
    this.friction = input.contact?.friction ?? 0;
    const massive: number[] = [];
    for (let i = 0; i < n; i++) if (mass[i]! > 0) massive.push(i);
    this.massive = Uint32Array.from(massive);
    this.active = new Uint32Array(0);
    this.refreshNodes();
    const { thickness } = input;
    let thinnest = Infinity;
    for (let e = 0; e < thickness.length; e++) thinnest = Math.min(thinnest, thickness[e]!);
    // Nodes in no shell meet the barriers with no band at all: they are left to the step.
    this.band = this.self
      ? thinnest
      : this.walls.length || this.poles.length
        ? thinnest / 2
        : Infinity;
    this.travel = Math.sqrt(this.penalty / 10) * this.band;
    if (this.self) this.neighbours();
  }

  /**
   * Each node's half thickness and contact membership from the shells not erased: a node left by
   * erosion is a bare particle (no thickness, no shell contact of its own).
   */
  private refreshNodes() {
    const { shells, thickness, erased, mass, nodeCount: n } = this.input;
    this.half.fill(0);
    const inShell = new Uint8Array(n);
    let count = 0;
    for (let e = 0; e < thickness.length; e++) {
      if (erased[e]) {
        count++;
        continue;
      }
      for (let k = 0; k < 4; k++) {
        const i = shells[4 * e + k]!;
        this.half[i] = Math.max(this.half[i]!, thickness[e]! / 2);
        inShell[i] = 1;
      }
    }
    const active: number[] = [];
    for (let i = 0; i < n; i++) if (mass[i]! > 0 && inShell[i]) active.push(i);
    this.active = Uint32Array.from(active);
    this.erasedSeen = count;
  }

  /**
   * A node's mass for a push along d at the point o off it: the smaller of its mass and its
   * effective mass there (`massAt`); for a rigid body's node, the body's effective mass there
   * over the body's number of contacts (Infinity when the body cannot move along d at all:
   * it adds no compliance, see `finite`).
   */
  private massAt(i: number, dx: number, dy: number, dz: number, ox = 0, oy = 0, oz = 0): number {
    const m = this.input.mass[i]!;
    const f = this.input.massAt;
    const body = this.input.bodyOf[i]!;
    if (body < 0) return f ? Math.min(m, f(i, dx, dy, dz, ox, oy, oz)) : m;
    // A body's node: the body's effective mass there, shared among the body's contacts (its
    // share of the body's mass without `massAt`).
    const own = f ? f(i, dx, dy, dz, ox, oy, oz) : m;
    return own / Math.max(1, this.hits[body]! + this.shellHits[body]!);
  }

  /**
   * A contact's penalty mass, finite: when neither side can move along the push (a clamped body
   * on a wall or on another), node i's share of its body's mass (or its own) instead.
   */
  private finite(m: number, i: number): number {
    return Number.isFinite(m) ? m : this.input.mass[i]!;
  }

  /**
   * The weight a contact's mass gives node i's compliance when the node takes the weight w of
   * the contact: w² for a body's node (the body's contacts share its mass by count), or for a node
   * in no body its contacts' summed weight W ≥ w (see `nodeHits`).
   */
  private shareWeight(i: number, w: number): number {
    if (this.input.bodyOf[i]! >= 0) return w * w;
    return Math.max(w, this.nodeHits[i]! + this.nodeShellHits[i]!);
  }

  /**
   * The compliance of the segment point (corners k with barycentric weights w) for a push
   * along d at the offset o from that point. Corners of one rigid body move together, so
   * they count once: their summed weight W at their weighted centre, W²/m there.
   */
  private segmentFlex(
    x: Float64Array,
    k: readonly [number, number, number],
    w: readonly [number, number, number],
    dx: number,
    dy: number,
    dz: number,
    ox: number,
    oy: number,
    oz: number,
  ): number {
    const { bodyOf } = this.input;
    let flex = 0;
    for (let c = 0; c < 3; c++) {
      const kc = k[c]!;
      const wc = w[c]!;
      if (!(wc > 0)) continue;
      const body = bodyOf[kc]!;
      if (body < 0) {
        flex += this.shareWeight(kc, wc) / this.massAt(kc, dx, dy, dz, ox, oy, oz);
        continue;
      }
      // The first corner of this body: gather its body's corners.
      let first = true;
      for (let e = 0; e < c; e++) if (w[e]! > 0 && bodyOf[k[e]!] === body) first = false;
      if (!first) continue;
      let W = 0,
        px = 0,
        py = 0,
        pz = 0;
      for (let e = c; e < 3; e++) {
        const ke = k[e]!;
        const we = w[e]!;
        if (!(we > 0) || bodyOf[ke] !== body) continue;
        W += we;
        px += we * x[3 * ke]!;
        py += we * x[3 * ke + 1]!;
        pz += we * x[3 * ke + 2]!;
      }
      const qx = px / W - x[3 * kc]! + ox,
        qy = py / W - x[3 * kc + 1]! + oy,
        qz = pz / W - x[3 * kc + 2]! + oz;
      flex += (W * W) / this.massAt(kc, dx, dy, dz, qx, qy, qz);
    }
    return flex;
  }

  /**
   * Per active node: the segments of its own sheet (any sheet with `ignoreInitial`) within the
   * gap at the start (CSR, sorted).
   */
  private exStart = new Uint32Array(0);
  private exList = new Uint32Array(0);

  private neighbours() {
    const { shells, thickness, x0, nodeCount: n } = this.input;
    const ne = thickness.length;
    const anySheet = !!this.input.contact?.ignoreInitial;
    // Sheets: nodes joined through shared shells (union–find).
    const root = new Int32Array(n).map((_, i) => i);
    const find = (i: number): number => {
      while (root[i] !== i) i = root[i] = root[root[i]!]!;
      return i;
    };
    for (let e = 0; e < ne; e++)
      for (let k = 1; k < 4; k++) {
        const a = find(shells[4 * e]!),
          b = find(shells[4 * e + k]!);
        if (a !== b) root[a] = b;
      }
    this.rebuild(x0);
    const exStart = new Uint32Array(n + 1);
    const lists: number[][] = [];
    const uv = new Float64Array(2);
    for (const i of this.active) {
      const near: number[] = [];
      this.candidates(
        i,
        x0,
        (e, d) => {
          if (
            d < this.half[i]! + thickness[e]! / 2 &&
            (anySheet || find(shells[4 * e]!) === find(i))
          )
            near.push(e);
        },
        uv,
      );
      near.sort((a, b) => a - b);
      lists[i] = near;
      exStart[i + 1] = near.length;
    }
    for (let i = 0; i < n; i++) exStart[i + 1] += exStart[i]!;
    const exList = new Uint32Array(exStart[n]!);
    for (const i of this.active) exList.set(lists[i]!, exStart[i]!);
    this.exStart = exStart;
    this.exList = exList;
  }

  /**
   * The longest step (s) that keeps every node from moving more than `travel` at the velocities
   * `v` (two nodes closing: twice it between them), so that the
   * springs, set for that step, stop a node within its band and none passes through a surface.
   */
  stepFor(v: Float64Array): number {
    if (!(this.band < Infinity)) return Infinity;
    let fastest = 0;
    for (const i of this.massive) {
      const s = v[3 * i]! ** 2 + v[3 * i + 1]! ** 2 + v[3 * i + 2]! ** 2;
      if (s > fastest) fastest = s;
    }
    return fastest > 0 ? this.travel / Math.sqrt(fastest) : Infinity;
  }

  /** Whether segment e is a sheet neighbour of node i (never in contact). */
  private excluded(i: number, e: number): boolean {
    const list = this.exList;
    for (let q = this.exStart[i]!; q < this.exStart[i + 1]!; q++) {
      const s = list[q]!;
      if (s === e) return true;
      if (s > e) return false;
    }
    return false;
  }

  /**
   * The segments in node i's cell that do not hold it, with the distance to their nearer
   * triangle (from the last rebuild's hash, at positions x).
   */
  private candidates(
    i: number,
    x: Float64Array,
    visit: (e: number, d: number) => void,
    uv: Float64Array,
  ) {
    const { shells } = this.input;
    const { inv, mask, start, list } = this;
    if (!(inv > 0)) return;
    const px = x[3 * i]!,
      py = x[3 * i + 1]!,
      pz = x[3 * i + 2]!;
    const b =
      ContactSet.hash(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv)) & mask;
    for (let q = start[b]!; q < start[b + 1]!; q++) {
      const e = list[q]!;
      const s0 = shells[4 * e]!,
        s1 = shells[4 * e + 1]!,
        s2 = shells[4 * e + 2]!,
        s3 = shells[4 * e + 3]!;
      if (s0 === i || s1 === i || s2 === i || s3 === i) continue;
      let best = Infinity;
      for (let t = 0; t < 2; t++) {
        if (t === 1 && s3 === s2) break;
        const ia = 3 * s0,
          ib = 3 * (t === 0 ? s1 : s2),
          ic = 3 * (t === 0 ? s2 : s3);
        if (
          ContactSet.flat(
            x[ia]!,
            x[ia + 1]!,
            x[ia + 2]!,
            x[ib]!,
            x[ib + 1]!,
            x[ib + 2]!,
            x[ic]!,
            x[ic + 1]!,
            x[ic + 2]!,
          )
        )
          continue;
        ContactSet.nearest(
          px,
          py,
          pz,
          x[ia]!,
          x[ia + 1]!,
          x[ia + 2]!,
          x[ib]!,
          x[ib + 1]!,
          x[ib + 2]!,
          x[ic]!,
          x[ic + 1]!,
          x[ic + 2]!,
          uv,
        );
        const u = uv[0]!,
          w = uv[1]!,
          o = 1 - u - w;
        const dx = px - (o * x[ia]! + u * x[ib]! + w * x[ic]!);
        const dy = py - (o * x[ia + 1]! + u * x[ib + 1]! + w * x[ic + 1]!);
        const dz = pz - (o * x[ia + 2]! + u * x[ib + 2]! + w * x[ic + 2]!);
        best = Math.min(best, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      visit(e, best);
    }
  }

  /**
   * The contact forces and moments at the positions `x` (velocities `v` and angular velocities
   * `w` for friction) into `f` and `m` (zeroed first), and the barrier forces.
   */
  forces(x: Float64Array, v: Float64Array, w: Float64Array, f: Float64Array, m: Float64Array) {
    f.fill(0);
    m.fill(0);
    this.barrierForce.fill(0);
    if (this.erasedCount() !== this.erasedSeen) this.refreshNodes();
    // The springs follow the step the solver takes next. It only ever shrinks (when a node goes
    // faster than any did before), so a spring never softens while it holds a node.
    this.stepNow = Math.min(this.stepNow, this.stepFor(v));
    // The shell contacts are found (and counted) first, then the barriers counted and pushed,
    // then the shell contacts pushed: each contact's share is of all the contacts now.
    if (this.self) this.shellSearch(x);
    if (this.walls.length || this.poles.length) this.barriers(x, v, w, f, m);
    else {
      this.hits.fill(0);
      this.nodeHits.fill(0);
    }
    if (this.self) this.shellForces(x, v, w, f, m);
  }

  /**
   * A penalty force with Coulomb friction on node i along the unit normal n, penetration pen;
   * the friction acts at the barrier's surface, `arm` below the node along −n: the slip is taken
   * there and the node gets that point's moment.
   */
  private push(
    i: number,
    pen: number,
    nx: number,
    ny: number,
    nz: number,
    arm: number,
    mu: number,
    v: Float64Array,
    w: Float64Array,
    f: Float64Array,
    mo: Float64Array,
    out: Float64Array,
    o: number,
  ) {
    const step = this.stepNow;
    const m = this.finite(this.massAt(i, nx, ny, nz) / this.shareWeight(i, 1), i);
    const fn = (this.penalty * m * pen) / (step * step);
    let fx = fn * nx,
      fy = fn * ny,
      fz = fn * nz;
    if (mu > 0) {
      // The contact point's velocity: v + ω × (−arm n).
      const wx = w[3 * i]!,
        wy = w[3 * i + 1]!,
        wz = w[3 * i + 2]!;
      const vx = v[3 * i]! - arm * (wy * nz - wz * ny),
        vy = v[3 * i + 1]! - arm * (wz * nx - wx * nz),
        vz = v[3 * i + 2]! - arm * (wx * ny - wy * nx);
      const vn = vx * nx + vy * ny + vz * nz;
      const tx = vx - vn * nx,
        ty = vy - vn * ny,
        tz = vz - vn * nz;
      const vt = Math.hypot(tx, ty, tz);
      if (vt > 0) {
        // At most what stops the slip in a step: the effective mass at the contact point along
        // the slip (the node's turning included).
        const mt =
          this.massAt(i, tx / vt, ty / vt, tz / vt, -arm * nx, -arm * ny, -arm * nz) /
          this.shareWeight(i, 1);
        const ft = Math.min(mu * fn, (mt * vt) / step);
        const gx = (-ft * tx) / vt,
          gy = (-ft * ty) / vt,
          gz = (-ft * tz) / vt;
        fx += gx;
        fy += gy;
        fz += gz;
        mo[3 * i] -= arm * (ny * gz - nz * gy);
        mo[3 * i + 1] -= arm * (nz * gx - nx * gz);
        mo[3 * i + 2] -= arm * (nx * gy - ny * gx);
      }
    }
    f[3 * i] += fx;
    f[3 * i + 1] += fy;
    f[3 * i + 2] += fz;
    out[o] -= fx;
    out[o + 1] -= fy;
    out[o + 2] -= fz;
  }

  private barriers(
    x: Float64Array,
    v: Float64Array,
    w: Float64Array,
    f: Float64Array,
    mo: Float64Array,
  ) {
    const out = this.barrierForce;
    const { bodyOf } = this.input;
    const { nodeHits } = this;
    this.hits.fill(0);
    nodeHits.fill(0);
    // First count each body's (and each other node's) barrier contacts.
    for (const i of this.massive) {
      const body = bodyOf[i]!;
      const hits = body < 0 ? nodeHits : this.hits;
      const at = body < 0 ? i : body;
      const px = x[3 * i]!,
        py = x[3 * i + 1]!,
        pz = x[3 * i + 2]!;
      const h = this.half[i]!;
      for (const q of this.walls)
        if ((px - q.p[0]!) * q.n[0]! + (py - q.p[1]!) * q.n[1]! + (pz - q.p[2]!) * q.n[2]! < h)
          hits[at]++;
      for (const q of this.poles) {
        const rx = px - q.p[0]!,
          ry = py - q.p[1]!,
          rz = pz - q.p[2]!;
        const along = rx * q.a[0]! + ry * q.a[1]! + rz * q.a[2]!;
        const d = Math.hypot(rx - along * q.a[0]!, ry - along * q.a[1]!, rz - along * q.a[2]!);
        if (q.r + h - d > 0 && d > 0) hits[at]++;
      }
    }
    for (const i of this.massive) {
      const px = x[3 * i]!,
        py = x[3 * i + 1]!,
        pz = x[3 * i + 2]!;
      const h = this.half[i]!;
      this.walls.forEach((q, k) => {
        const d = (px - q.p[0]!) * q.n[0]! + (py - q.p[1]!) * q.n[1]! + (pz - q.p[2]!) * q.n[2]!;
        if (d < h)
          this.push(
            i,
            h - d,
            q.n[0]!,
            q.n[1]!,
            q.n[2]!,
            Math.max(d, 0),
            q.mu,
            v,
            w,
            f,
            mo,
            out,
            3 * k,
          );
      });
      this.poles.forEach((q, k) => {
        const rx = px - q.p[0]!,
          ry = py - q.p[1]!,
          rz = pz - q.p[2]!;
        const along = rx * q.a[0]! + ry * q.a[1]! + rz * q.a[2]!;
        const ox = rx - along * q.a[0]!,
          oy = ry - along * q.a[1]!,
          oz = rz - along * q.a[2]!;
        const d = Math.hypot(ox, oy, oz);
        const pen = q.r + h - d;
        if (pen > 0 && d > 0)
          this.push(
            i,
            pen,
            ox / d,
            oy / d,
            oz / d,
            Math.max(d - q.r, 0),
            q.mu,
            v,
            w,
            f,
            mo,
            out,
            3 * (this.walls.length + k),
          );
      });
    }
  }

  /** The nearest point of triangle (a, b, c) to p (Ericson's regions): barycentric (1−u−v, u, v). */
  static closest(p: number[], a: number[], b: number[], c: number[]): [number, number] {
    const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const ac = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const ap = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!];
    const dot = (q: number[], r: number[]) => q[0]! * r[0]! + q[1]! * r[1]! + q[2]! * r[2]!;
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return [0, 0];
    const bp = [p[0]! - b[0]!, p[1]! - b[1]!, p[2]! - b[2]!];
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return [1, 0];
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return [d1 / (d1 - d3), 0];
    const cp = [p[0]! - c[0]!, p[1]! - c[1]!, p[2]! - c[2]!];
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return [0, 1];
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return [0, d2 / (d2 - d6)];
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      return [1 - w, w];
    }
    const denom = 1 / (va + vb + vc);
    return [vb * denom, vc * denom];
  }

  private keys = new Uint32Array(0);
  private segs = new Uint32Array(0);
  private start = new Uint32Array(0);
  private list = new Uint32Array(0);
  /** Per segment: its box (low x, y, z, high x, y, z) at the last call. */
  private box = new Float64Array(0);

  /** Whether triangle (a, b, c) has no area (its corners in a line): it has no normal. */
  private static flat(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): boolean {
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const scale = (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz);
    return nx * nx + ny * ny + nz * nz <= 1e-20 * scale;
  }

  /** Barycentric (u, v) of the point of triangle (a, b, c) nearest p, into `uv` (scalar Ericson). */
  private static nearest(
    px: number,
    py: number,
    pz: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    uv: Float64Array,
  ) {
    const abx = bx - ax,
      aby = by - ay,
      abz = bz - az;
    const acx = cx - ax,
      acy = cy - ay,
      acz = cz - az;
    const apx = px - ax,
      apy = py - ay,
      apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return void ((uv[0] = 0), (uv[1] = 0));
    const bpx = px - bx,
      bpy = py - by,
      bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return void ((uv[0] = 1), (uv[1] = 0));
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return void ((uv[0] = d1 / (d1 - d3)), (uv[1] = 0));
    const cpx = px - cx,
      cpy = py - cy,
      cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return void ((uv[0] = 0), (uv[1] = 1));
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return void ((uv[0] = 0), (uv[1] = d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      uv[0] = 1 - w;
      uv[1] = w;
      return;
    }
    const denom = 1 / (va + vb + vc);
    uv[0] = vb * denom;
    uv[1] = vc * denom;
  }

  private inv = 0;
  private mask = 0;
  /** Node positions at the last rebuild, and the margin the boxes were grown by then (mm). */
  private xBuild = new Float64Array(0);
  private margin = 0;

  private static hash(i: number, j: number, k: number) {
    return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) >>> 0;
  }

  /** Whether a node moved more than half the margin since the last rebuild (or none yet). */
  private mustRebuild(x: Float64Array): boolean {
    const xb = this.xBuild;
    if (xb.length !== x.length || this.erasedAtBuild !== this.erasedCount()) return true;
    const lim = (0.5 * this.margin) ** 2;
    for (let i = 0; i < x.length; i += 3) {
      const dx = x[i]! - xb[i]!,
        dy = x[i + 1]! - xb[i + 1]!,
        dz = x[i + 2]! - xb[i + 2]!;
      if (dx * dx + dy * dy + dz * dz > lim) return true;
    }
    return false;
  }

  private erasedAtBuild = -1;
  private erasedCount() {
    let c = 0;
    for (const q of this.input.erased) c += q;
    return c;
  }

  /**
   * The spatial hash: each segment's box grown by the largest gap and the margin, in every cell
   * it touches (cells as large as the largest grown box, so at most 2 × 2 × 2 of them).
   */
  private rebuild(x: Float64Array) {
    const { shells, thickness, erased } = this.input;
    const ne = thickness.length;
    let size = 0;
    let gapMax = 0;
    if (this.box.length < 6 * ne) this.box = new Float64Array(6 * ne);
    const box = this.box;
    const sizes = new Float64Array(ne);
    let live = 0;
    for (let e = 0; e < ne; e++) {
      if (erased[e]) continue;
      if (thickness[e]! > gapMax) gapMax = thickness[e]!;
      let lx = Infinity,
        ly = Infinity,
        lz = Infinity,
        hx = -Infinity,
        hy = -Infinity,
        hz = -Infinity;
      for (let k = 0; k < 4; k++) {
        const o = 3 * shells[4 * e + k]!;
        const cx = x[o]!,
          cy = x[o + 1]!,
          cz = x[o + 2]!;
        if (cx < lx) lx = cx;
        if (cx > hx) hx = cx;
        if (cy < ly) ly = cy;
        if (cy > hy) hy = cy;
        if (cz < lz) lz = cz;
        if (cz > hz) hz = cz;
      }
      box[6 * e] = lx;
      box[6 * e + 1] = ly;
      box[6 * e + 2] = lz;
      box[6 * e + 3] = hx;
      box[6 * e + 4] = hy;
      box[6 * e + 5] = hz;
      const extent = Math.max(hx - lx, hy - ly, hz - lz);
      sizes[live++] = extent;
      size = Math.max(size, extent);
    }
    this.xBuild = Float64Array.from(x);
    this.erasedAtBuild = this.erasedCount();
    this.nearStale = true;
    if (!(size > 0)) {
      this.inv = 0;
      return;
    }
    // The margin: half the thickest gap, so that a rebuild comes every few steps at most.
    const margin = (this.margin = 0.5 * gapMax);
    const g = gapMax + margin;
    // VS8c: cells a quarter of the 90th-percentile segment (at least twice the gap), not the
    // largest segment: a node then checks only the segments near it. A segment goes into every
    // cell its box (grown by the gap) reaches, so a node still finds it in its own cell.
    const typical = live ? sizes.subarray(0, live).sort()[Math.floor(0.9 * (live - 1))]! : size;
    let h = Math.max(typical / 4, 2 * g);
    for (let e = 0; e < ne; e++) {
      if (erased[e]) continue;
      for (let a = 0; a < 3; a++) {
        box[6 * e + a] -= margin;
        box[6 * e + 3 + a] += margin;
      }
    }
    let inv = 1 / h;
    const cells = (e: number, a: number) =>
      Math.floor((box[6 * e + 3 + a]! + gapMax) * inv) -
      Math.floor((box[6 * e + a]! - gapMax) * inv) +
      1;
    let total = 0;
    // Larger cells while the entries pass 64 per segment on average.
    for (;;) {
      total = 0;
      for (let e = 0; e < ne; e++) if (!erased[e]) total += cells(e, 0) * cells(e, 1) * cells(e, 2);
      if (total <= 64 * Math.max(live, 1) || h >= size + 2 * g) break;
      h *= 2;
      inv = 1 / h;
    }
    this.inv = inv;
    if (this.keys.length < total) {
      this.keys = new Uint32Array(total);
      this.segs = new Uint32Array(total);
      this.list = new Uint32Array(total);
    }
    const keys = this.keys;
    const segs = this.segs;
    let count = 0;
    const hash = ContactSet.hash;
    for (let e = 0; e < ne; e++) {
      if (erased[e]) continue;
      const o = 6 * e;
      const i1 = Math.floor((box[o + 3]! + gapMax) * inv),
        j1 = Math.floor((box[o + 4]! + gapMax) * inv),
        k1 = Math.floor((box[o + 5]! + gapMax) * inv);
      for (let i = Math.floor((box[o]! - gapMax) * inv); i <= i1; i++)
        for (let j = Math.floor((box[o + 1]! - gapMax) * inv); j <= j1; j++)
          for (let k = Math.floor((box[o + 2]! - gapMax) * inv); k <= k1; k++) {
            keys[count] = hash(i, j, k);
            segs[count++] = e;
          }
    }
    let table = 1;
    while (table < 2 * count) table <<= 1;
    const mask = (this.mask = table - 1);
    if (this.start.length < table + 1) this.start = new Uint32Array(table + 1);
    const start = this.start;
    start.fill(0, 0, table + 1);
    for (let q = 0; q < count; q++) start[(keys[q]! & mask) + 1]++;
    for (let b = 0; b < table; b++) start[b + 1] += start[b]!;
    const list = this.list;
    // Fill each bucket from its end down, then put the ends back.
    for (let q = 0; q < count; q++) list[--start[(keys[q]! & mask) + 1]!] = segs[q]!;
    for (let q = 0; q < count; q++) start[(keys[q]! & mask) + 1]++;
  }

  /** VS8c: per node, the segments it may touch until the next rebuild (CSR). */
  private nearStart = new Uint32Array(0);
  private nearList = new Uint32Array(0);
  private nearStale = true;

  /**
   * VS8c: at a rebuild, each active node's segments from its cell that pass the checks of
   * `shellSearch` (not its own, not its body's, not excluded) and that it is within the gap and
   * the margin of: until the next rebuild no node moves more than half the margin, so no other
   * segment can come within its gap. The steps between rebuilds then look only at these.
   */
  private nearOf(x: Float64Array) {
    const { shells, thickness, bodyOf, nodeCount: n } = this.input;
    const { inv, mask, start, list, box, half } = this;
    const nearStart = new Uint32Array(n + 1);
    const out: number[] = [];
    if (inv > 0) {
      const hash = ContactSet.hash;
      const slack = this.margin;
      const uv = new Float64Array(2);
      let at = 0;
      for (let i = 0; i < n; i++) {
        nearStart[i] = out.length;
        if (at < this.active.length && this.active[at] === i) at++;
        else continue;
        const px = x[3 * i]!,
          py = x[3 * i + 1]!,
          pz = x[3 * i + 2]!;
        const b = hash(Math.floor(px * inv), Math.floor(py * inv), Math.floor(pz * inv)) & mask;
        const body = bodyOf[i]!;
        for (let q = start[b]!; q < start[b + 1]!; q++) {
          const e = list[q]!;
          const s0 = shells[4 * e]!,
            s1 = shells[4 * e + 1]!,
            s2 = shells[4 * e + 2]!,
            s3 = shells[4 * e + 3]!;
          if (s0 === i || s1 === i || s2 === i || s3 === i) continue;
          if (
            body >= 0 &&
            bodyOf[s0] === body &&
            bodyOf[s1] === body &&
            bodyOf[s2] === body &&
            bodyOf[s3] === body
          )
            continue;
          const gap = half[i]! + thickness[e]! / 2 + slack;
          const o6 = 6 * e;
          if (
            px < box[o6]! - gap ||
            px > box[o6 + 3]! + gap ||
            py < box[o6 + 1]! - gap ||
            py > box[o6 + 4]! + gap ||
            pz < box[o6 + 2]! - gap ||
            pz > box[o6 + 5]! + gap
          )
            continue;
          if (this.excluded(i, e)) continue;
          // Its triangles' nearest point within the gap and the margin (until the next
          // rebuild neither the node nor the corners move more than half the margin).
          const reach = gap;
          let near = false;
          for (let t = 0; t < 2 && !near; t++) {
            if (t === 1 && s3 === s2) break;
            const ia = 3 * s0,
              ib = 3 * (t === 0 ? s1 : s2),
              ic = 3 * (t === 0 ? s2 : s3);
            const ax = x[ia]!,
              ay = x[ia + 1]!,
              az = x[ia + 2]!;
            const bx = x[ib]!,
              by = x[ib + 1]!,
              bz = x[ib + 2]!;
            const cx = x[ic]!,
              cy = x[ic + 1]!,
              cz = x[ic + 2]!;
            if (ContactSet.flat(ax, ay, az, bx, by, bz, cx, cy, cz)) {
              // A flat triangle now may open later: keep it.
              near = true;
              break;
            }
            ContactSet.nearest(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, uv);
            const u = uv[0]!,
              w = uv[1]!,
              o = 1 - u - w;
            const dx = px - (o * ax + u * bx + w * cx);
            const dy = py - (o * ay + u * by + w * cy);
            const dz = pz - (o * az + u * bz + w * cz);
            near = dx * dx + dy * dy + dz * dz < reach * reach;
          }
          if (near) out.push(e);
        }
      }
    }
    nearStart[n] = out.length;
    this.nearStart = nearStart;
    this.nearList = Uint32Array.from(out);
    this.nearStale = false;
  }

  /**
   * Each active node's nearest segment within the gap (into `found`: node, shell, the
   * triangle's corners, the weights of its 2nd and 3rd corners and the distance), with the
   * contacts each body and node takes (`shellHits`, `nodeShellHits`).
   */
  private shellSearch(x: Float64Array) {
    const { shells, thickness, bodyOf } = this.input;
    const found = this.found;
    found.length = 0;
    const hits = this.shellHits;
    const nodeHits = this.nodeShellHits;
    hits.fill(0);
    nodeHits.fill(0);
    if (this.mustRebuild(x)) this.rebuild(x);
    if (this.nearStale) this.nearOf(this.xBuild);
    const { inv, box, nearStart, nearList } = this;
    if (!(inv > 0)) return;
    const uv = new Float64Array(2);
    const half = this.half;
    for (const i of this.active) {
      const px = x[3 * i]!,
        py = x[3 * i + 1]!,
        pz = x[3 * i + 2]!;
      const body = bodyOf[i]!;
      let bestD = Infinity;
      let bestS = -1;
      let bestT = 0;
      let bu = 0;
      let bv = 0;
      for (let q = nearStart[i]!; q < nearStart[i + 1]!; q++) {
        const e = nearList[q]!;
        const s0 = shells[4 * e]!,
          s1 = shells[4 * e + 1]!,
          s2 = shells[4 * e + 2]!,
          s3 = shells[4 * e + 3]!;
        if (s0 === i || s1 === i || s2 === i || s3 === i) continue;
        if (
          body >= 0 &&
          bodyOf[s0] === body &&
          bodyOf[s1] === body &&
          bodyOf[s2] === body &&
          bodyOf[s3] === body
        )
          continue;
        const gap = half[i]! + thickness[e]! / 2;
        // Outside the segment's box grown by the gap: no contact.
        const o6 = 6 * e;
        if (
          px < box[o6]! - gap ||
          px > box[o6 + 3]! + gap ||
          py < box[o6 + 1]! - gap ||
          py > box[o6 + 4]! + gap ||
          pz < box[o6 + 2]! - gap ||
          pz > box[o6 + 5]! + gap
        )
          continue;
        if (this.excluded(i, e)) continue;
        for (let t = 0; t < 2; t++) {
          // Triangles (0, 1, 2) and (0, 2, 3); a triangle shell has only the first.
          if (t === 1 && s3 === s2) break;
          const ia = 3 * s0,
            ib = 3 * (t === 0 ? s1 : s2),
            ic = 3 * (t === 0 ? s2 : s3);
          const ax = x[ia]!,
            ay = x[ia + 1]!,
            az = x[ia + 2]!;
          const bx = x[ib]!,
            by = x[ib + 1]!,
            bz = x[ib + 2]!;
          const cx = x[ic]!,
            cy = x[ic + 1]!,
            cz = x[ic + 2]!;
          if (ContactSet.flat(ax, ay, az, bx, by, bz, cx, cy, cz)) continue;
          ContactSet.nearest(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, uv);
          const u = uv[0]!,
            w = uv[1]!,
            o = 1 - u - w;
          const dx = px - (o * ax + u * bx + w * cx);
          const dy = py - (o * ay + u * by + w * cy);
          const dz = pz - (o * az + u * bz + w * cz);
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < gap && d < bestD) {
            bestD = d;
            bestS = e;
            bestT = t;
            bu = u;
            bv = w;
          }
        }
      }
      if (bestS < 0) continue;
      const k0 = shells[4 * bestS]!;
      const k1 = shells[4 * bestS + (bestT === 0 ? 1 : 2)]!;
      const k2 = shells[4 * bestS + (bestT === 0 ? 2 : 3)]!;
      const w0 = 1 - bu - bv;
      found.push(i, bestS, k0, k1, k2, bu, bv, bestD);
      // The bodies this contact pushes (each once), and the nodes by their weights.
      const b0 = bodyOf[i]!,
        b1 = bodyOf[k0]!,
        b2 = bodyOf[k1]!,
        b3 = bodyOf[k2]!;
      if (b0 >= 0) hits[b0]++;
      if (b1 >= 0 && b1 !== b0) hits[b1]++;
      if (b2 >= 0 && b2 !== b0 && b2 !== b1) hits[b2]++;
      if (b3 >= 0 && b3 !== b0 && b3 !== b1 && b3 !== b2) hits[b3]++;
      if (b0 < 0) nodeHits[i] += 1;
      if (b1 < 0 && w0 > 0) nodeHits[k0] += w0;
      if (b2 < 0 && bu > 0) nodeHits[k1] += bu;
      if (b3 < 0 && bv > 0) nodeHits[k2] += bv;
    }
  }

  /** The forces of the contacts `shellSearch` found (after the barriers counted theirs). */
  private shellForces(
    x: Float64Array,
    v: Float64Array,
    wr: Float64Array,
    f: Float64Array,
    mo: Float64Array,
  ) {
    const { thickness } = this.input;
    const step = this.stepNow;
    const half = this.half;
    const friction = this.friction;
    const found = this.found;
    for (let q = 0; q < found.length; q += 8) {
      const i = found[q]!,
        e = found[q + 1]!,
        k0 = found[q + 2]!,
        k1 = found[q + 3]!,
        k2 = found[q + 4]!;
      const w1 = found[q + 5]!,
        w2 = found[q + 6]!,
        w0 = 1 - w1 - w2;
      const bestD = found[q + 7]!;
      const px = x[3 * i]!,
        py = x[3 * i + 1]!,
        pz = x[3 * i + 2]!;
      const gap = half[i]! + thickness[e]! / 2;
      const cx = w0 * x[3 * k0]! + w1 * x[3 * k1]! + w2 * x[3 * k2]!;
      const cy = w0 * x[3 * k0 + 1]! + w1 * x[3 * k1 + 1]! + w2 * x[3 * k2 + 1]!;
      const cz = w0 * x[3 * k0 + 2]! + w1 * x[3 * k1 + 2]! + w2 * x[3 * k2 + 2]!;
      let nx = px - cx,
        ny = py - cy,
        nz = pz - cz;
      let d = bestD;
      // The node's velocity relative to the segment's point.
      const rx = v[3 * i]! - w0 * v[3 * k0]! - w1 * v[3 * k1]! - w2 * v[3 * k2]!;
      const ry = v[3 * i + 1]! - w0 * v[3 * k0 + 1]! - w1 * v[3 * k1 + 1]! - w2 * v[3 * k2 + 1]!;
      const rz = v[3 * i + 2]! - w0 * v[3 * k0 + 2]! - w1 * v[3 * k1 + 2]! - w2 * v[3 * k2 + 2]!;
      if (d < 1e-9 * gap) {
        // On the midsurface: push along the segment's normal, to the side the node moves from.
        const ux = x[3 * k1]! - x[3 * k0]!,
          uy = x[3 * k1 + 1]! - x[3 * k0 + 1]!,
          uz = x[3 * k1 + 2]! - x[3 * k0 + 2]!;
        const vx = x[3 * k2]! - x[3 * k0]!,
          vy = x[3 * k2 + 1]! - x[3 * k0 + 1]!,
          vz = x[3 * k2 + 2]! - x[3 * k0 + 2]!;
        nx = uy * vz - uz * vy;
        ny = uz * vx - ux * vz;
        nz = ux * vy - uy * vx;
        if (rx * nx + ry * ny + rz * nz > 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        d = 0;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= l;
        ny /= l;
        nz /= l;
      } else {
        nx /= d;
        ny /= d;
        nz /= d;
      }
      const pen = gap - d;
      // The segment point's effective mass under its barycentric share of the force.
      const ks = [k0, k1, k2] as const;
      const ws = [w0, w1, w2] as const;
      const flex = this.segmentFlex(x, ks, ws, nx, ny, nz, 0, 0, 0);
      const m = this.finite(
        Math.min(this.massAt(i, nx, ny, nz) / this.shareWeight(i, 1), 1 / flex),
        i,
      );
      if (!(m > 0)) continue;
      const fn = (this.penalty * m * pen) / (step * step);
      let fx = fn * nx,
        fy = fn * ny,
        fz = fn * nz;
      if (friction > 0) {
        // The friction acts at one point, a·n below the node and b·n above the segment
        // (a + b = d): the slip there, and its moments on the node and the segment's nodes.
        const a = (half[i]! * d) / gap;
        const bb = d - a;
        const Wx = a * wr[3 * i]! + bb * (w0 * wr[3 * k0]! + w1 * wr[3 * k1]! + w2 * wr[3 * k2]!);
        const Wy =
          a * wr[3 * i + 1]! +
          bb * (w0 * wr[3 * k0 + 1]! + w1 * wr[3 * k1 + 1]! + w2 * wr[3 * k2 + 1]!);
        const Wz =
          a * wr[3 * i + 2]! +
          bb * (w0 * wr[3 * k0 + 2]! + w1 * wr[3 * k1 + 2]! + w2 * wr[3 * k2 + 2]!);
        const sx = rx - (Wy * nz - Wz * ny),
          sy = ry - (Wz * nx - Wx * nz),
          sz = rz - (Wx * ny - Wy * nx);
        const vn = sx * nx + sy * ny + sz * nz;
        const tx = sx - vn * nx,
          ty = sy - vn * ny,
          tz = sz - vn * nz;
        const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (vt > 0) {
          // At most what stops the slip in a step: the pair's effective mass at the contact
          // point along the slip (both sides' turning included).
          const ux = tx / vt,
            uy = ty / vt,
            uz = tz / vt;
          const flexT =
            this.shareWeight(i, 1) / this.massAt(i, ux, uy, uz, -a * nx, -a * ny, -a * nz) +
            this.segmentFlex(x, ks, ws, ux, uy, uz, bb * nx, bb * ny, bb * nz);
          const ft = Math.min(friction * fn, vt / (flexT * step));
          const gx = (-ft * tx) / vt,
            gy = (-ft * ty) / vt,
            gz = (-ft * tz) / vt;
          fx += gx;
          fy += gy;
          fz += gz;
          const mx = ny * gz - nz * gy,
            my = nz * gx - nx * gz,
            mz = nx * gy - ny * gx;
          mo[3 * i] -= a * mx;
          mo[3 * i + 1] -= a * my;
          mo[3 * i + 2] -= a * mz;
          for (const [k, wk] of [
            [k0, w0],
            [k1, w1],
            [k2, w2],
          ] as const) {
            mo[3 * k] -= bb * wk * mx;
            mo[3 * k + 1] -= bb * wk * my;
            mo[3 * k + 2] -= bb * wk * mz;
          }
        }
      }
      f[3 * i] += fx;
      f[3 * i + 1] += fy;
      f[3 * i + 2] += fz;
      f[3 * k0] -= w0 * fx;
      f[3 * k0 + 1] -= w0 * fy;
      f[3 * k0 + 2] -= w0 * fz;
      f[3 * k1] -= w1 * fx;
      f[3 * k1 + 1] -= w1 * fy;
      f[3 * k1 + 2] -= w1 * fz;
      f[3 * k2] -= w2 * fx;
      f[3 * k2 + 1] -= w2 * fy;
      f[3 * k2 + 2] -= w2 * fz;
    }
  }
}
