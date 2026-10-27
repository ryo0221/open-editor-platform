import { describe, expect, it } from 'vitest';
import {
  dispatched,
  effectIntent,
  planBasis,
  plainExternalText,
  summarizeOperation,
  type OperationStep,
  type OverlayRead,
} from './host';
import { createMockScheduleHost } from './mock-host';
import { finishedOperation } from './apply-state';
import { readScheduleArtifact } from './native';
import { displayedTime, placeOverlay, unknownDays, weekRange } from './view-model';
import { createSchedule, timedInstants, type ScheduleEvent } from './model';
import {
  commitVersion,
  contentHash,
  createArtifact,
  serializeArtifact,
} from '@editor-platform/artifact-core';
import { syntheticLane } from './test-fixtures';
import { utcDay } from '@editor-platform/time-axis';

const event: ScheduleEvent = {
  id: 'e1',
  title: 'Design review',
  notes: 'Internal agenda',
  time: {
    kind: 'timed',
    startLocal: '2026-10-26T10:00',
    endLocal: '2026-10-26T11:00',
    timeZone: 'Asia/Tokyo',
  },
  conference: 'meet',
  links: [{ laneId: 'lane-1', rowId: 'row-api' }],
};
const step = (state: OperationStep['state']): OperationStep => ({ id: state, label: state, state });

describe('Schedule Host contract', () => {
  it('builds intents from allowlisted fields only and keeps notes opt-in', () => {
    const intent = effectIntent(event, { includeNotes: false });
    expect(Object.keys(intent).sort()).toEqual(['conference', 'eventId', 'kind', 'time', 'title']);
    expect(JSON.stringify(intent)).not.toContain('row-api');
    expect(JSON.stringify(intent)).not.toContain('lane-1');
    expect(effectIntent(event, { includeNotes: true }).notes).toBe('Internal agenda');
    expect(planBasis(intent)).not.toBe(
      planBasis(effectIntent({ ...event, title: 'Changed' }, { includeNotes: false })),
    );
  });

  it('never hides an unknown or partial step behind success', () => {
    expect(summarizeOperation([step('verified'), step('verified')])).toBe('verified');
    expect(summarizeOperation([step('verified'), step('unknown')])).toBe('unknown');
    expect(summarizeOperation([step('verified'), step('failed-after-acceptance')])).toBe('partial');
    expect(summarizeOperation([step('rejected')])).toBe('rejected');
    // Accepted then failed: something may remain, so it is never summarized as refused.
    expect(summarizeOperation([step('failed-after-acceptance')])).toBe('failed-after-acceptance');
    expect(summarizeOperation([step('rejected'), step('failed-after-acceptance')])).toBe(
      'failed-after-acceptance',
    );
    expect(summarizeOperation([step('cancelled-before-dispatch')])).toBe('cancelled');
    // A conflict applied nothing and ends the operation; a new plan may follow. Beside a step the
    // calendar accepted, it never hides what may remain.
    expect(summarizeOperation([step('conflict')])).toBe('conflict');
    expect(finishedOperation({ operation: 'op', steps: [step('conflict')] })).toBe(true);
    expect(summarizeOperation([step('conflict'), step('failed-after-acceptance')])).toBe(
      'failed-after-acceptance',
    );
    expect(summarizeOperation([step('prepared')])).toBe('pending');
    // A step still being sent keeps the whole operation open.
    expect(summarizeOperation([step('dispatching'), step('rejected')])).toBe('pending');
    expect(summarizeOperation([step('dispatching'), step('failed-after-acceptance')])).toBe(
      'pending',
    );
    expect(summarizeOperation([step('verified'), step('dispatching')])).toBe('partial');
    expect(dispatched([step('prepared')])).toBe(false);
    expect(dispatched([step('prepared'), step('accepted')])).toBe(true);
  });

  it('keeps provider text plain and bounded', () => {
    expect(plainExternalText('a\u0000b\u0007c\nd')).toBe('abc\nd');
    expect(plainExternalText(42)).toBe('');
    expect(plainExternalText('x'.repeat(5), 3)).toBe('xxx…');
  });

  it('executes a prepared plan once and cancels only what was never sent', async () => {
    const host = createMockScheduleHost();
    const signal = new AbortController().signal;
    const intent = effectIntent(event, { includeNotes: false });
    const plan = await host.effects.prepare(intent, planBasis(intent), signal);
    expect(plan.sends.map((s) => s.label)).toEqual(['Title', 'When', 'Meeting']);
    const first = await host.effects.requestExecution(plan.handle);
    const second = await host.effects.requestExecution(plan.handle);
    expect(second.operation).toBe(first.operation);
    expect(host.controls.calls.execute).toBe(1);
    expect(host.controls.intents).toEqual([intent]);

    host.controls.setEffectScenario('queued');
    const queued = await host.effects.prepare(intent, planBasis(intent), signal);
    const pending = await host.effects.requestExecution(queued.handle);
    expect(summarizeOperation(pending.steps)).toBe('pending');
    const cancelled = await host.effects.cancelPending(pending.operation);
    expect(summarizeOperation(cancelled.steps)).toBe('cancelled');

    // After an account switch an unsent plan is refused; a sent one keeps its recorded result.
    const unsent = await host.effects.prepare(intent, planBasis(intent), signal);
    host.controls.switchAccount();
    // A known refusal before dispatch has a final answer, so a new plan can follow.
    const refused = await host.effects.requestExecution(unsent.handle);
    expect(summarizeOperation(refused.steps)).toBe('rejected');
    expect(refused.steps[0].detail).toContain('account changed');
    expect((await host.effects.requestExecution(plan.handle)).operation).toBe(first.operation);
    expect(host.controls.calls.execute).toBe(2);
  });

  it('marks unread ranges unknown and never shows details of busy-only sources', async () => {
    const host = createMockScheduleHost();
    host.controls.setOverlayComplete(false);
    const signal = new AbortController().signal;
    const sources = await host.read.listSources(signal);
    const range = {
      from: utcDay('2026-10-26')! * 86_400_000,
      to: utcDay('2026-11-02')! * 86_400_000,
    };
    const reads = await Promise.all(
      sources.map((s) => host.read.readRange({ sourceHandle: s.handle, range }, signal)),
    );
    expect(reads.every((r) => !r.complete && r.missing.length === 1)).toBe(true);
    const week = weekRange(utcDay('2026-10-26')!);
    expect(unknownDays(reads, week, 'UTC').size).toBeGreaterThan(0);
    const placed = placeOverlay(
      reads,
      new Map(sources.map((s) => [s.handle, { label: s.label, access: s.access }])),
      'UTC',
    );
    for (const p of placed)
      if (p.item.sourceHandle.startsWith('mock-team')) expect(p.busyOnly).toBe(true);
  });

  it('treats a never-read copy (fetchedAt null) as unknown for the whole range, not free', () => {
    const week = weekRange(utcDay('2026-10-26')!);
    const range = { from: week.start * 86_400_000, to: (week.end + 1) * 86_400_000 };
    const read: OverlayRead = {
      sourceHandle: 'src',
      generation: 'g1',
      range,
      complete: false,
      missing: [range],
      fetchedAt: null,
      events: [],
    };
    expect(unknownDays([read], week, 'UTC').size).toBe(week.end - week.start + 1);
    const sources = new Map([['src', { label: 'Mine', access: 'details' as const }]]);
    expect(placeOverlay([read], sources, 'UTC')).toEqual([]);
  });

  it('places an overlay event on every day it occupies, not on an exclusive midnight end', () => {
    const day = (iso: string) => utcDay(iso)! * 86_400_000;
    const read = {
      sourceHandle: 'src',
      generation: 'g1',
      range: { from: day('2026-10-26'), to: day('2026-11-02') },
      complete: true,
      missing: [],
      fetchedAt: 0,
      events: [
        {
          id: 'night',
          sourceHandle: 'src',
          start: day('2026-10-26') + 22 * 3_600_000,
          end: day('2026-10-27') + 2 * 3_600_000,
        },
        {
          id: 'trip',
          sourceHandle: 'src',
          start: day('2026-10-28'),
          end: day('2026-10-30'),
          allDay: { startDate: '2026-10-28', endDate: '2026-10-30' },
        },
      ],
    };
    const place = (zone: string) =>
      placeOverlay([read], new Map([['src', { label: 'Mine', access: 'details' as const }]]), zone);
    const days = (id: string, zone = 'UTC') =>
      place(zone)
        .filter((p) => p.item.id === id)
        .map((p) => p.day);
    expect(days('night')).toEqual([utcDay('2026-10-26'), utcDay('2026-10-27')]);
    // All-day dates do not move or grow with the display zone.
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'])
      expect(days('trip', zone)).toEqual([utcDay('2026-10-28'), utcDay('2026-10-29')]);
  });

  it('cuts a long overlay event to the shown days before the placement limit', () => {
    const read = {
      sourceHandle: 'src',
      generation: 'g1',
      range: { from: 0, to: 0 },
      complete: true,
      missing: [],
      fetchedAt: 0,
      events: [
        {
          id: 'leave',
          sourceHandle: 'src',
          start: Date.UTC(2025, 0, 1),
          end: Date.UTC(2026, 11, 31),
          allDay: { startDate: '2025-01-01', endDate: '2026-12-31' },
        },
      ],
    };
    const week = weekRange(utcDay('2026-10-26')!);
    const placed = placeOverlay(
      [read],
      new Map([['src', { label: 'Mine', access: 'details' as const }]]),
      'UTC',
      week,
    );
    expect(placed.map((p) => p.day)).toEqual(Array.from({ length: 7 }, (_, i) => week.start + i));
  });

  it('creates new-event times that stay valid across a DST fold in the Schedule zone', () => {
    // 10:00 in Tokyo on 2026-10-25 is 01:00 in London, the second (GMT) occurrence of that hour.
    const time = displayedTime(
      '2026-10-25T10:00',
      '2026-10-25T11:00',
      'Asia/Tokyo',
      'Europe/London',
    );
    expect(time).toMatchObject({ startLocal: '2026-10-25T01:00', startFold: 'later' });
    expect(time.endFold).toBeUndefined();
    expect(timedInstants(time).start).toBe(Date.UTC(2026, 9, 25, 1));
    expect(displayedTime('2026-10-26T10:00', '2026-10-26T11:00', 'UTC', 'UTC')).toEqual({
      kind: 'timed',
      startLocal: '2026-10-26T10:00',
      endLocal: '2026-10-26T11:00',
      timeZone: 'UTC',
    });
  });

  it('reads only valid, hash-checked Schedule artifacts', async () => {
    const saved = await commitVersion(
      createArtifact('schedule', 'Plan', createSchedule('UTC')),
      null,
      null,
    );
    await expect(readScheduleArtifact(serializeArtifact(saved))).resolves.toMatchObject({
      kind: 'schedule',
    });
    await expect(readScheduleArtifact('{}')).rejects.toThrow();
    await expect(
      readScheduleArtifact(serializeArtifact({ ...saved, kind: 'data' })),
    ).rejects.toThrow('Unsupported artifact kind');
    const tampered = structuredClone(saved);
    (tampered.versions[0].content as { timeZone: string }).timeZone = 'Asia/Tokyo';
    await expect(readScheduleArtifact(serializeArtifact(tampered))).rejects.toThrow('hash');
  });

  it('refuses an import whose embedded lane snapshot does not match its own hash', async () => {
    const lane = syntheticLane();
    lane.reference.snapshot.contentHash = await contentHash(lane.reference.snapshot.content);
    const good = await commitVersion(
      createArtifact('schedule', 'Plan', { ...createSchedule('UTC'), lanes: [lane] }),
      null,
      null,
    );
    await expect(readScheduleArtifact(serializeArtifact(good))).resolves.toMatchObject({
      kind: 'schedule',
    });
    // The outer version hash is recomputed over the forged lane, so only the lane check fails.
    const forged = structuredClone(good);
    const content = forged.versions[0].content as { lanes: (typeof lane)[] };
    content.lanes[0].reference.snapshot.content = { forged: true };
    forged.versions[0].contentHash = await contentHash(content);
    forged.draft.content = structuredClone(content) as never;
    await expect(readScheduleArtifact(serializeArtifact(forged))).rejects.toThrow(
      'does not match its snapshot hash',
    );
  });
});
