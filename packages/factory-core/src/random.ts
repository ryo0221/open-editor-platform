import type { FactoryDistribution } from './model';

/** FNV-1a over the UTF-16 units of `text`, mixed with `seed`. */
function hash32(seed: number, text: string): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A small deterministic generator (sfc32). Each object of a model draws from its own stream,
 * seeded by the run's seed and the object's ID, so adding or removing one object does not change
 * the numbers the others draw (common random numbers across experiments).
 */
export class FactoryRandom {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number, stream: string) {
    this.a = hash32(seed, `a:${stream}`);
    this.b = hash32(seed, `b:${stream}`);
    this.c = hash32(seed, `c:${stream}`);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.next();
  }
  /** Uniform in [0, 1). */
  next(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  /** Uniform in (0, 1). */
  private open(): number {
    let u = this.next();
    while (u === 0) u = this.next();
    return u;
  }
  standardNormal(): number {
    return Math.sqrt(-2 * Math.log(this.open())) * Math.cos(2 * Math.PI * this.next());
  }
  /** Index into `weights` with probability proportional to the weight (all ≥ 0, sum > 0). */
  pick(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r < 0) return i;
    }
    return weights.length - 1;
  }
}

/** One draw of `d`, rounded to a whole millisecond and never below 0. */
export function sampleDistribution(d: FactoryDistribution, rng: FactoryRandom): number {
  let v: number;
  switch (d.type) {
    case 'const':
      v = d.value;
      break;
    case 'uniform':
      v = d.min + (d.max - d.min) * rng.next();
      break;
    case 'triangular': {
      const u = rng.next();
      const span = d.max - d.min;
      const f = span === 0 ? 0 : (d.mode - d.min) / span;
      v =
        u < f
          ? d.min + Math.sqrt(u * span * (d.mode - d.min))
          : d.max - Math.sqrt((1 - u) * span * (d.max - d.mode));
      break;
    }
    case 'normal': {
      const lo = d.min ?? 0;
      const hi = d.max ?? Infinity;
      v = d.mean + d.sd * rng.standardNormal();
      for (let i = 1; i < 100 && (v < lo || v > hi); i++) v = d.mean + d.sd * rng.standardNormal();
      v = Math.min(hi, Math.max(lo, v));
      break;
    }
    case 'lognormal': {
      const s2 = Math.log(1 + (d.sd * d.sd) / (d.mean * d.mean));
      const mu = Math.log(d.mean) - s2 / 2;
      v = Math.exp(mu + Math.sqrt(s2) * rng.standardNormal());
      break;
    }
    case 'exponential':
      v = -d.mean * Math.log(1 - rng.next());
      break;
    case 'empirical':
      v = d.values[rng.pick(d.values.map((x) => x.weight))]!.value;
      break;
  }
  return Math.max(0, Math.round(v));
}

/** The expected value of `d` before rounding (for checks and reports). */
export function distributionMean(d: FactoryDistribution): number {
  switch (d.type) {
    case 'const':
      return d.value;
    case 'uniform':
      return (d.min + d.max) / 2;
    case 'triangular':
      return (d.min + d.mode + d.max) / 3;
    case 'normal':
    case 'lognormal':
    case 'exponential':
      return d.mean;
    case 'empirical': {
      const total = d.values.reduce((s, x) => s + x.weight, 0);
      return d.values.reduce((s, x) => s + (x.value * x.weight) / total, 0);
    }
  }
}
