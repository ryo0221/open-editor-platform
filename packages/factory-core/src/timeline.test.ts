import { describe, expect, it } from 'vitest';
import { f170SmallLine, factoryHistogramBins, factoryStates, runFactory } from './index';

describe('FT1b timeline, flows and lead-time spread (TS-2652)', () => {
  it('records state intervals that tile the run for every place', () => {
    const doc = f170SmallLine();
    const r = runFactory(doc, { record: true });
    const t = r.timeline!;
    expect(t.truncated).toBe(false);
    doc.objects.forEach((o, i) => {
      const places = o.kind === 'parallel' ? o.count : 1;
      for (let p = 0; p < places; p++) {
        const rows: number[][] = [];
        for (let k = 0; k < t.states[i]!.length; k += 4)
          if (t.states[i]![k + 3] === p) rows.push(t.states[i]!.slice(k, k + 4));
        // Contiguous from 0 to the end, no zero-length rows. Two rows in the same state may meet
        // where a place hands on a part and takes the next at the same instant.
        expect(rows[0]![0]).toBe(0);
        expect(rows[rows.length - 1]![1]).toBe(r.endMs);
        rows.forEach((row, j) => {
          expect(row[1]!).toBeGreaterThan(row[0]!);
          expect(factoryStates[row[2]!]).toBeDefined();
          if (j) expect(row[0]).toBe(rows[j - 1]![1]);
        });
      }
    });
    // Within the period the intervals give the same totals as the statistics.
    const test = doc.objects.findIndex((o) => o.id === 'test');
    let working = 0;
    for (let k = 0; k < t.states[test]!.length; k += 4) {
      const [a, b, s] = t.states[test]!.slice(k, k + 3) as [number, number, number];
      if (factoryStates[s] === 'working') working += Math.max(0, b - Math.max(a, r.startMs));
    }
    expect(working).toBe(r.objects[test]!.states.working);
  });

  it('records each part from its source to a drain or into an assembly', () => {
    const doc = f170SmallLine();
    const r = runFactory(doc, { record: true });
    const m = r.timeline!.moves;
    const paths = new Map<number, number[]>();
    for (let k = 0; k < m.length; k += 5) {
      const [time, part, , from, to] = m.slice(k, k + 5) as number[];
      const path = paths.get(part!) ?? [];
      if (!path.length) expect(from).toBe(-1);
      else expect(from).toBe(path[path.length - 1]);
      expect(time).toBeLessThanOrEqual(r.endMs);
      path.push(to!);
      paths.set(part!, path);
    }
    const id = (i: number) => (i < 0 ? '-' : doc.objects[i]!.id);
    const routes = new Set([...paths.values()].map((p) => p.map(id).join(' ')));
    expect(routes).toContain('in-housing machining buffer-1 conveyor-1 assembly test out');
    expect(routes).toContain('in-gearset buffer-gear assembly -');
    // A housing becomes an e-Axle at the assembly: the product index changes on the way out.
    const eaxle = doc.products.findIndex((p) => p.id === 'eaxle');
    expect(m.some((_, k) => k % 5 === 2 && m[k] === eaxle)).toBe(true);
  });

  it('counts the flow on each link and spreads the lead times', () => {
    const r = runFactory(f170SmallLine());
    expect(r.timeline).toBeUndefined();
    expect(r.flows['test>out']).toBe(r.produced);
    expect(r.flows['buffer-gear>assembly']).toBe(r.assembled);
    const lt = r.leadTime;
    expect(lt.minMs).toBeLessThanOrEqual(lt.p50Ms);
    expect(lt.p50Ms).toBeLessThanOrEqual(lt.p90Ms);
    expect(lt.p90Ms).toBeLessThanOrEqual(lt.p95Ms);
    expect(lt.p95Ms).toBeLessThanOrEqual(lt.maxMs);
    expect(lt.histogram).toHaveLength(factoryHistogramBins);
    expect(lt.histogram.reduce((a, b) => a + b, 0)).toBe(r.produced);
  });

  it('stops recording at the limit and says so', () => {
    const r = runFactory(f170SmallLine(), { record: true, maxRecords: 100 });
    const t = r.timeline!;
    expect(t.truncated).toBe(true);
    // Past the limit only what began by the cut is kept: a state still open at each place, and
    // the events of that instant.
    const kept = t.moves.length / 5 + t.states.reduce((a, s) => a + s.length / 4, 0);
    expect(kept).toBeGreaterThanOrEqual(100);
    expect(kept).toBeLessThan(150);
    for (const rows of t.states)
      for (let i = 0; i < rows.length; i += 4)
        expect(rows[i]).toBeLessThanOrEqual(t.recordedUntilMs!);
    // FT4b: where it stopped, after every move kept.
    expect(t.recordedUntilMs).toBeGreaterThan(0);
    for (let i = 0; i < t.moves.length; i += 5)
      expect(t.moves[i]).toBeLessThanOrEqual(t.recordedUntilMs!);
    expect(runFactory(f170SmallLine(), { record: true }).timeline!.recordedUntilMs).toBe(undefined);
    // The statistics do not depend on recording.
    expect({ ...r, timeline: undefined }).toEqual({
      ...runFactory(f170SmallLine()),
      timeline: undefined,
    });
  });

  it('a malformed record limit falls back to the safety limit', () => {
    const a = runFactory(f170SmallLine(), { record: true });
    for (const maxRecords of [NaN, Infinity, -5])
      expect(runFactory(f170SmallLine(), { record: true, maxRecords }).timeline!.truncated).toBe(
        maxRecords === -5 ? true : a.timeline!.truncated,
      );
  });
});
