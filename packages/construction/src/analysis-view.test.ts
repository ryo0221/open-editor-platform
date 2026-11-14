import { describe, expect, it } from 'vitest';
import { deriveBim } from '@editor-platform/bim-core';
import {
  f88Building,
  f88OfficeFrame,
  frameCompleted,
  frameOnDay,
  scheduleConstruction,
} from '@editor-platform/construction-core';
import {
  analysedLook,
  analysisLooks,
  ghostLook,
  stateLook,
  comparisonRows,
  frameAnalysis,
  frameSize,
  nextSiteLoadId,
  ratioLook,
  ratioLooks,
  solveBoth,
} from './index';

describe('CS4b frame analysis view (ST-548, TS-2083)', () => {
  const bim = f88Building();
  const doc = f88OfficeFrame(bim);
  const plan = scheduleConstruction(doc);
  const world = { bim, derived: deriveBim(bim) };
  const day = plan.byId.get('slab-4')!.start;
  const stage = frameOnDay(doc, plan, world, day);
  const done = frameCompleted(doc, plan, world);
  /** A result with every element at `mpa` and every node still. */
  const flat = (f: typeof stage, mpa: (member: string) => number) => {
    const stress = new Float64Array(frameSize(f.model!).elements);
    for (const m of f.members) for (const e of m.elements) stress[e] = mpa(m.elementId);
    return { displacement: new Float64Array(f.model!.nodes.length), stress };
  };

  it('compares the day with the completed building, worst first (ST-548#1)', () => {
    // The 3F beams twice as hard on the day; the rest as when complete.
    const a = frameAnalysis(
      day,
      stage,
      flat(stage, (id) => (id.startsWith('b-3-') ? 8 : 4)),
      done,
      flat(done, () => 4),
      1.25,
    );
    expect(a.stage.results.length).toBe(stage.members.length);
    expect(a.comparison.length).toBe(stage.members.length);
    expect(a.comparison[0]!.elementId).toMatch(/^b-3-/);
    expect(a.comparison[0]!.ratio).toBe(2);
    const rows = comparisonRows(a, 3);
    expect(rows.length).toBe(3);
    expect(rows[0]!.cells.slice(1)).toEqual(['8.0 MPa', '4.0 MPa', '2.00×']);
    // The view: the 3F beams red, the rest green; members not standing keep their own look.
    const looks = analysisLooks(a);
    expect(looks.get(rows[0]!.id)).toBe(ratioLooks.high);
    expect(looks.get('c-1-1-1')).toBe(ratioLooks.usual);
    const later = done.members.find((m) => !stage.members.some((x) => x.elementId === m.elementId));
    expect(looks.has(later!.elementId)).toBe(false);
    expect(ratioLook(1.2)).toBe(ratioLooks.higher);
    // A member with no stress when complete reads "only now".
    const fresh = frameAnalysis(
      day,
      stage,
      flat(stage, () => 1),
      done,
      flat(done, () => 0),
      1,
    );
    expect(comparisonRows(fresh, 1)[0]!.cells[3]).toBe('only now');
  });

  it('sizes the job and names new site loads apart (ST-548#2)', () => {
    const size = frameSize(stage.model!);
    expect(size.nodes).toBe(stage.model!.nodes.length / 3);
    expect(size.elements).toBe(stage.members.reduce((t, m) => t + m.elements.length, 0));
    expect(nextSiteLoadId(new Set())).toBe('load-1');
    expect(nextSiteLoadId(new Set(['load-1', 'load-2']))).toBe('load-3');
  });

  it('colours only the members standing on the day; the unbuilt keep their ghost (ST-548#1)', () => {
    const red = ratioLooks.high;
    expect(analysedLook('built', undefined, red)).toBe(red);
    expect(analysedLook('building', stateLook('building', false), red)).toBe(red);
    // Not built yet: hidden, or a ghost with "Show unbuilt", never the ratio's solid colour.
    expect(analysedLook('absent', stateLook('absent', true), red)).toBe(ghostLook);
    expect(analysedLook('absent', null, red)).toBeNull();
    expect(analysedLook('built', undefined, undefined)).toBeUndefined();
  });

  it('stops the other solve when one fails (ST-548#2)', async () => {
    const model = stage.model!;
    const seen: AbortSignal[] = [];
    const solver = {
      label: 'test',
      destination: 'nowhere',
      solve: (_: unknown, signal: AbortSignal) => {
        seen.push(signal);
        return seen.length === 1
          ? Promise.reject(new Error('singular'))
          : new Promise<never>(() => undefined);
      },
    };
    const controller = new AbortController();
    await expect(solveBoth(solver, model, model, controller)).rejects.toThrow('singular');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe('singular');
  });
});
