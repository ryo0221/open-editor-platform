/** Deterministic mock Host for tests and the reference Host. Synthetic data only: no network,
 * no credentials and no real people. It proves Editor reactions, not provider behavior. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { DAY_MS } from '@editor-platform/time-axis';
import type {
  EffectIntent,
  OperationStatus,
  OperationStep,
  OverlayEvent,
  OverlayNotice,
  OverlayRead,
  PreparedPlan,
  ScheduleEffectPort,
  ScheduleReadPort,
  ScheduleSourceInfo,
} from './host';

export type MockEffectScenario =
  | 'verified'
  | 'unknown'
  | 'partial'
  | 'rejected'
  | 'failed-after-acceptance'
  | 'send-error'
  | 'conflict'
  | 'queued';
export interface MockScheduleHost {
  read: ScheduleReadPort;
  effects: ScheduleEffectPort;
  /** Test controls. A real Host has none of these. */
  controls: {
    setEffectScenario(scenario: MockEffectScenario): void;
    setPrepareFailure(message: string | undefined): void;
    setOverlayComplete(complete: boolean): void;
    failTeamReads(fail: boolean): void;
    /** Hold the next reads until released, to deliver them late. */
    holdReads(hold: boolean): void;
    releaseReads(): void;
    /** Hold execution answers until released, to answer a send late. */
    holdSends(hold: boolean): void;
    releaseSends(): void;
    switchAccount(): void;
    readonly calls: { prepare: number; execute: number; read: number; cancel: number };
    /** Every intent the mock was asked to plan, as the Host received it. */
    readonly intents: EffectIntent[];
  };
}

const conferenceNames = {
  none: 'None',
  meet: 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
};

export function createMockScheduleHost(): MockScheduleHost {
  let scenario: MockEffectScenario = 'verified',
    prepareFailure: string | undefined,
    complete = true,
    failTeam = false,
    hold = false,
    holdSend = false,
    account = 1,
    sequence = 0;
  const calls = { prepare: 0, execute: 0, read: 0, cancel: 0 };
  const intents: EffectIntent[] = [];
  const plans = new Map<string, { intent: EffectIntent; account: number; operation?: string }>();
  const operations = new Map<string, OperationStatus>();
  const held: (() => void)[] = [];
  const heldSends: (() => void)[] = [];
  const watchers = new Set<(notice: OverlayNotice) => void>();
  const notify = (notice: OverlayNotice) => watchers.forEach((w) => w(notice));
  const sources = (): ScheduleSourceInfo[] => [
    {
      handle: `mock-work-${account}`,
      label: 'Work calendar (synthetic)',
      provider: 'Mock',
      account: `account ${account} (synthetic)`,
      access: 'details',
    },
    {
      handle: `mock-team-${account}`,
      label: 'Team availability (busy only)',
      provider: 'Mock',
      account: `account ${account} (synthetic)`,
      access: 'busy',
    },
  ];
  function events(handle: string, from: number, to: number): OverlayEvent[] {
    const result: OverlayEvent[] = [];
    for (let day = Math.floor(from / DAY_MS); day * DAY_MS < to; day++) {
      const weekday = new Date(day * DAY_MS).getUTCDay();
      if (handle.startsWith('mock-work') && weekday === 2)
        result.push({
          id: `work-${day}`,
          sourceHandle: handle,
          start: day * DAY_MS + 9 * 3_600_000,
          end: day * DAY_MS + 10 * 3_600_000,
          title: 'Weekly sync (synthetic)',
          notes:
            'Agenda <img src="https://tracker.invalid/p.gif"> <script>alert(1)</script> https://example.invalid/agenda',
        });
      if (handle.startsWith('mock-work') && weekday === 5)
        result.push({
          id: `offsite-${day}`,
          sourceHandle: handle,
          start: day * DAY_MS,
          end: (day + 1) * DAY_MS,
          allDay: {
            startDate: new Date(day * DAY_MS).toISOString().slice(0, 10),
            endDate: new Date((day + 1) * DAY_MS).toISOString().slice(0, 10),
          },
          title: 'Offsite (synthetic)',
        });
      if (handle.startsWith('mock-team') && weekday === 4)
        result.push({
          id: `team-${day}`,
          sourceHandle: handle,
          start: day * DAY_MS + 13 * 3_600_000,
          end: day * DAY_MS + 15 * 3_600_000,
        });
    }
    return result.filter((e) => e.end > from && e.start < to);
  }
  const read: ScheduleReadPort = {
    async listSources() {
      return sources();
    },
    readRange({ sourceHandle, range }, signal) {
      calls.read++;
      const generation = String(account);
      const respond = (): OverlayRead => {
        const middle = complete ? range.to : range.from + Math.floor((range.to - range.from) / 2);
        return {
          sourceHandle,
          generation,
          range,
          complete,
          missing: complete ? [] : [{ from: middle, to: range.to }],
          fetchedAt: range.from,
          events: events(sourceHandle, range.from, middle).map((e) =>
            sourceHandle.startsWith('mock-team') ? { ...e, title: undefined, notes: undefined } : e,
          ),
        };
      };
      return new Promise((resolve, reject) => {
        const finish = () =>
          signal.aborted
            ? reject(new DOMException('Aborted', 'AbortError'))
            : failTeam && sourceHandle.startsWith('mock-team')
              ? reject(new Error('Team availability could not be read.'))
              : resolve(respond());
        if (hold) held.push(finish);
        else queueMicrotask(finish);
      });
    },
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
  };
  function steps(intent: EffectIntent): OperationStep[] {
    const event = { id: 'event', label: 'Calendar event' };
    const meeting = intent.conference === 'none' ? undefined : { id: 'meeting', label: 'Meeting' };
    if (scenario === 'queued')
      return [event, ...(meeting ? [meeting] : [])].map((s) => ({ ...s, state: 'prepared' }));
    if (scenario === 'unknown')
      return [
        {
          ...event,
          state: 'unknown',
          detail: 'No response from the calendar. The event may or may not exist.',
        },
      ];
    if (scenario === 'rejected')
      return [{ ...event, state: 'rejected', detail: 'The calendar refused the request.' }];
    if (scenario === 'conflict')
      return [{ ...event, state: 'conflict', detail: 'The calendar changed after planning.' }];
    if (scenario === 'failed-after-acceptance')
      return [
        {
          ...event,
          state: 'failed-after-acceptance',
          detail: 'The calendar accepted the event, then failed to finish it.',
        },
      ];
    if (scenario === 'partial')
      return [
        { ...event, state: 'verified' },
        {
          ...(meeting ?? { id: 'meeting', label: 'Meeting' }),
          state: 'failed-after-acceptance',
          detail: 'The meeting link could not be created.',
        },
      ];
    return [event, ...(meeting ? [meeting] : [])].map((s) => ({ ...s, state: 'verified' }));
  }
  const effects: ScheduleEffectPort = {
    async prepare(intent, basis) {
      calls.prepare++;
      if (prepareFailure) throw new Error(prepareFailure);
      intents.push(structuredClone(intent));
      const handle = `plan-${++sequence}`;
      plans.set(handle, { intent: structuredClone(intent), account });
      const when =
        intent.time.kind === 'allDay'
          ? `${intent.time.startDate} – ${intent.time.endDateExclusive} (all day, end excluded)`
          : `${intent.time.startLocal.replace('T', ' ')} – ${intent.time.endLocal.replace('T', ' ')} ${intent.time.timeZone}`;
      const plan: PreparedPlan = {
        handle,
        basis,
        calendar: sources()[0].label,
        organizer: sources()[0].account,
        conference: conferenceNames[intent.conference],
        sends: [
          { label: 'Title', value: intent.title },
          { label: 'When', value: when },
          { label: 'Meeting', value: conferenceNames[intent.conference] },
          ...(intent.notes !== undefined ? [{ label: 'Notes', value: intent.notes }] : []),
        ],
        notifies: 'No participants (synthetic)',
      };
      return plan;
    },
    async requestExecution(planHandle) {
      const plan = plans.get(planHandle);
      if (!plan) throw new Error('The plan is no longer available. Prepare it again.');
      // The Host claims the plan once; a second request returns the same operation.
      if (plan.operation) return structuredClone(operations.get(plan.operation)!);
      // A plan names the organizer of the account it was prepared for; never send it as another.
      // Nothing left the Host, so this is a refusal with a final answer, not an unknown result.
      if (plan.account !== account) {
        const operation = `op-${canonicalJson([planHandle, 'account'])}`;
        plan.operation = operation;
        operations.set(operation, {
          operation,
          steps: [
            {
              id: 'event',
              label: 'Calendar event',
              state: 'rejected',
              detail: 'The account changed after this plan was prepared. Prepare it again.',
            },
          ],
        });
        return structuredClone(operations.get(operation)!);
      }
      calls.execute++;
      if (holdSend) await new Promise<void>((resolve) => heldSends.push(resolve));
      // The request left the Host but no answer came back.
      if (scenario === 'send-error') throw new Error('The Host did not answer.');
      const operation = `op-${canonicalJson([planHandle, sequence])}`;
      plan.operation = operation;
      operations.set(operation, { operation, steps: steps(plan.intent) });
      return structuredClone(operations.get(operation)!);
    },
    async getStatus(operation) {
      const status = operations.get(operation);
      if (!status) throw new Error('Unknown operation');
      return structuredClone(status);
    },
    async cancelPending(operation) {
      calls.cancel++;
      const status = operations.get(operation);
      if (!status) throw new Error('Unknown operation');
      if (status.steps.every((s) => s.state === 'prepared'))
        status.steps = status.steps.map((s) => ({ ...s, state: 'cancelled-before-dispatch' }));
      return structuredClone(status);
    },
  };
  return {
    read,
    effects,
    controls: {
      setEffectScenario: (value) => void (scenario = value),
      setPrepareFailure: (value) => void (prepareFailure = value),
      setOverlayComplete: (value) => void (complete = value),
      failTeamReads: (value) => void (failTeam = value),
      holdReads: (value) => void (hold = value),
      releaseReads: () => held.splice(0).forEach((finish) => finish()),
      holdSends: (value) => void (holdSend = value),
      releaseSends: () => heldSends.splice(0).forEach((finish) => finish()),
      switchAccount() {
        account++;
        notify({ kind: 'revoked' });
      },
      calls,
      intents,
    },
  };
}
