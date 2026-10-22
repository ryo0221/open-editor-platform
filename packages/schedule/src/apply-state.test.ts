import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  canPrepare,
  canSend,
  idleApply,
  shownPlan,
  stalePlan,
  type ApplyAction,
  type ApplyState,
} from './apply-state';
import type { OperationStatus, PreparedPlan, StepState } from './host';

const plan = (basis = 'b1', handle = 'plan-1'): PreparedPlan => ({
  handle,
  basis,
  calendar: 'Work',
  organizer: 'person-a@example.test',
  conference: 'none',
  sends: [{ label: 'Title', value: 'Review' }],
  notifies: 'Nobody',
});
const operation = (...states: StepState[]): OperationStatus => ({
  operation: 'op-1',
  steps: states.map((state, i) => ({ id: `s${i}`, label: state, state })),
});
const operationOf = (id: string, ...states: StepState[]): OperationStatus => ({
  operation: id,
  steps: states.map((state, i) => ({ id: `s${i}`, label: state, state })),
});
const run = (...actions: ApplyAction[]) =>
  actions.reduce<ApplyState>((state, action) => applyTransition(state, action), idleApply);

describe('Sending one event to the calendar', () => {
  it('sends one request per plan and never a stale one', () => {
    const planned = run({ type: 'open' }, { type: 'planned', plan: plan() });
    expect(canSend(planned, 'b1')).toBe(true);
    // The event changed after planning: the plan is stale and cannot be sent.
    expect(stalePlan(planned, 'b2')).toBe(true);
    expect(canSend(planned, 'b2')).toBe(false);
    const sending = applyTransition(planned, { type: 'send' });
    expect(sending).toEqual({ kind: 'sending', plan: plan() });
    // A double click finds the send already started: nothing moves, nothing is sent again.
    expect(applyTransition(sending, { type: 'send' })).toBe(sending);
    expect(canSend(sending, 'b1')).toBe(false);
    expect(canPrepare(sending)).toBe(false);
  });

  it('reopened while sending, offers no plan or send and shows the late answer', () => {
    const reopened = applyTransition(run({ type: 'planned', plan: plan() }, { type: 'send' }), {
      type: 'open',
    });
    expect(reopened).toEqual({ kind: 'sending', plan: undefined });
    expect(canPrepare(reopened)).toBe(false);
    expect(applyTransition(reopened, { type: 'planned', plan: plan('b1', 'plan-2') })).toBe(
      reopened,
    );
    // The answer arrives while the reopened dialog is open: it is shown there, finished or not.
    const verified = applyTransition(reopened, {
      type: 'answered',
      operation: operation('verified'),
    });
    expect(verified).toEqual({ kind: 'answered', operation: operation('verified') });
    const unfinished = applyTransition(reopened, {
      type: 'answered',
      operation: operation('accepted'),
    });
    expect(unfinished.kind).toBe('answered');
    expect(canPrepare(unfinished)).toBe(false);
  });

  it('keeps an unfinished answer across reopening and lets a finished one plan again', () => {
    const sent = run({ type: 'planned', plan: plan() }, { type: 'send' });
    const unknown = applyTransition(sent, { type: 'answered', operation: operation('unknown') });
    // Reopening shows the result to check, not a plan.
    const reopened = applyTransition(unknown, { type: 'open' });
    expect(reopened).toEqual({ kind: 'answered', operation: operation('unknown') });
    expect(shownPlan(reopened)).toBeUndefined();
    expect(canPrepare(reopened)).toBe(false);
    const done = applyTransition(sent, { type: 'answered', operation: operation('verified') });
    expect(applyTransition(done, { type: 'open' })).toBe(idleApply);
  });

  it('plans again after a conflict, in the same dialog and after reopening', () => {
    const conflict = run(
      { type: 'planned', plan: plan() },
      { type: 'send' },
      { type: 'answered', operation: operation('conflict') },
    );
    expect(canPrepare(conflict)).toBe(true);
    // Planning again keeps the old plan on screen until the new one arrives.
    const replanning = applyTransition(conflict, { type: 'replan' });
    expect(replanning).toEqual({ kind: 'planned', plan: plan() });
    const replanned = applyTransition(replanning, { type: 'planned', plan: plan('b2', 'plan-2') });
    expect(canSend(replanned, 'b2')).toBe(true);
    // Reopened, a conflict is finished: the event starts from no plan.
    expect(applyTransition(conflict, { type: 'open' })).toBe(idleApply);
    // An accepted step beside it is not "nothing applied": no new plan.
    const partly = applyTransition(conflict, {
      type: 'status',
      operation: operation('conflict', 'failed-after-acceptance'),
    });
    expect(canPrepare(partly)).toBe(false);
  });

  it('does not plan or send again after a send got no answer', () => {
    const noAnswer = run({ type: 'planned', plan: plan() }, { type: 'send' }, { type: 'noAnswer' });
    expect(noAnswer).toEqual({ kind: 'noAnswer', plan: plan() });
    expect(canPrepare(noAnswer)).toBe(false);
    expect(canSend(noAnswer, 'b1')).toBe(false);
    for (const action of [
      { type: 'replan' },
      { type: 'planned', plan: plan('b1', 'plan-2') },
      { type: 'send' },
    ] as ApplyAction[])
      expect(applyTransition(noAnswer, action)).toBe(noAnswer);
    const reopened = applyTransition(noAnswer, { type: 'open' });
    expect(reopened).toEqual({ kind: 'noAnswer', plan: undefined });
    expect(canPrepare(reopened)).toBe(false);
  });

  it('ignores a slow status answer about an operation that is no longer shown', () => {
    const accepted = run(
      { type: 'planned', plan: plan() },
      { type: 'send' },
      { type: 'answered', operation: operation('accepted') },
    );
    // Check status and Cancel sending update the operation they asked about.
    const checked = applyTransition(accepted, { type: 'status', operation: operation('verified') });
    expect(checked).toEqual({ kind: 'answered', operation: operation('verified'), plan: plan() });
    // A cancel answered, a new plan was sent, and only then the old Check status answers.
    const resending = run(
      { type: 'planned', plan: plan() },
      { type: 'send' },
      { type: 'answered', operation: operation('cancelled-before-dispatch') },
      { type: 'replan' },
      { type: 'planned', plan: plan('b1', 'plan-2') },
      { type: 'send' },
    );
    const late = { type: 'status', operation: operation('rejected') } as const;
    expect(applyTransition(resending, late)).toBe(resending);
    expect(canPrepare(resending)).toBe(false);
    // Nor does it replace the answer of the newer operation, or a plan being prepared.
    const newer = applyTransition(resending, {
      type: 'answered',
      operation: operationOf('op-2', 'accepted'),
    });
    expect(applyTransition(newer, late)).toBe(newer);
    const planned = run({ type: 'planned', plan: plan() });
    expect(applyTransition(planned, late)).toBe(planned);
    // A send answer only answers a send in flight.
    expect(applyTransition(newer, { type: 'answered', operation: operation('rejected') })).toBe(
      newer,
    );
  });

  it('drops a plan that was not sent when the dialog closes, and a failed plan', () => {
    expect(applyTransition(run({ type: 'planned', plan: plan() }), { type: 'open' })).toBe(
      idleApply,
    );
    expect(run({ type: 'planned', plan: plan() }, { type: 'planFailed' })).toBe(idleApply);
  });
});
