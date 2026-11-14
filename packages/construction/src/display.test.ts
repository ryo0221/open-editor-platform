import { describe, expect, it } from 'vitest';
import { addDays } from '@editor-platform/time-axis';
import {
  f85OfficeSchedule,
  f86OfficeSite,
  scheduleConstruction,
} from '@editor-platform/construction-core';
import {
  formatLinks,
  ghostLook,
  parseLinks,
  playbackDays,
  sliderDays,
  stateLook,
  stateLooks,
} from './index';

describe('CS1b 4D view looks and the task form (ST-542, TS-2073)', () => {
  it('draws each element state (ST-542#2)', () => {
    expect(stateLook('existing', false)).toBeUndefined();
    expect(stateLook('built', true)).toBeUndefined();
    expect(stateLook('absent', false)).toBeNull();
    expect(stateLook('absent', true)).toBe(ghostLook);
    expect(stateLook('building', false)).toBe(stateLooks.building);
    expect(stateLook('removing', false)).toBe(stateLooks.removing);
    expect(stateLook('temporary', true)).toBe(stateLooks.temporary);
  });

  it('runs the slider from the day before the start to the day after the finish (ST-542#2)', () => {
    expect(sliderDays('2027-04-01', '2027-08-27')).toEqual({
      first: '2027-03-31',
      last: '2027-08-28',
    });
  });

  it('widens the slider to actual dates outside the plan (ST-542#2)', () => {
    const doc = f85OfficeSchedule();
    const plan = scheduleConstruction(doc);
    expect(playbackDays(doc, plan)).toEqual(sliderDays(plan.projectStart, plan.projectFinish));
    doc.tasks.find((t) => t.id === 'roof')!.actual = { start: '2027-09-10', finish: '2027-09-20' };
    doc.tasks[0]!.actual = { start: '2027-03-25' };
    const late = scheduleConstruction(doc);
    expect(playbackDays(doc, late)).toEqual({ first: '2027-03-24', last: '2027-09-21' });
    // A milestone that builds elements after the last day worked is reached too.
    const m = f85OfficeSchedule();
    m.tasks.find((t) => t.id === 'complete')!.elementIds = ['m-1'];
    const mp = scheduleConstruction(m);
    const day = mp.byId.get('complete')!.start;
    expect(day > mp.projectFinish).toBe(true);
    expect(playbackDays(m, mp).last).toBe(addDays(day, 1));
    // So is one that takes temporary works down (CS2b): the day after shows them gone.
    const site = f86OfficeSite();
    const sp = scheduleConstruction(site);
    expect(playbackDays(site, sp).last).toBe(addDays(sp.byId.get('complete')!.finish, 1));
  });

  it('reads and writes predecessors as typed in the form (ST-542#3)', () => {
    const links = [
      { taskId: 'a', lagDays: 0 },
      { taskId: 'c-1-2', lagDays: 2 },
      { taskId: 'd', lagDays: -1 },
    ];
    expect(formatLinks(links)).toBe('a; c-1-2(2); d(-1)');
    expect(parseLinks(formatLinks(links))).toEqual(links);
    expect(parseLinks('  ;; ')).toEqual([]);
    expect(parseLinks('(2)')).toBe('"(2)" names no task');
  });
});
