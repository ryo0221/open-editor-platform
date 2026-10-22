import { summarizeOperation, type OperationStatus, type PreparedPlan } from './host';

/** Sending one event to the calendar. The Surface keeps one per event across closing the dialog;
 * the dialog draws from it. A plan is shown only in the dialog that prepared it. */
export type ApplyState =
  | { kind: 'idle' }
  | { kind: 'planned'; plan: PreparedPlan }
  /** The Host has the request and has not answered: nothing else is sent for this event. */
  | { kind: 'sending'; plan?: PreparedPlan }
  | { kind: 'answered'; operation: OperationStatus; plan?: PreparedPlan }
  /** The request failed without an answer: it may have reached the calendar, so this event is
   * not planned or sent again until the Host has reconciled it. */
  | { kind: 'noAnswer'; plan?: PreparedPlan };

export type ApplyAction =
  /** The dialog opens: an earlier plan and a finished answer are not shown again. */
  | { type: 'open' }
  /** Planning starts again; the plan on screen stays until the new one arrives. */
  | { type: 'replan' }
  | { type: 'planned'; plan: PreparedPlan }
  | { type: 'planFailed' }
  | { type: 'send' }
  /** The Host's answer to the send. */
  | { type: 'answered'; operation: OperationStatus }
  /** A later answer about an operation already shown (Check status, Cancel sending). */
  | { type: 'status'; operation: OperationStatus }
  | { type: 'noAnswer' };

export const idleApply: ApplyState = { kind: 'idle' };

/** A finished operation has a final answer; anything else still needs checking with the Host. */
export const finishedOperation = (status: OperationStatus) =>
  ['verified', 'rejected', 'failed-after-acceptance', 'cancelled', 'conflict'].includes(
    summarizeOperation(status.steps),
  );

/** Nothing was applied, so a new plan is the way on. */
const replannable = (status: OperationStatus) =>
  ['conflict', 'rejected', 'cancelled'].includes(summarizeOperation(status.steps));

export function canPrepare(state: ApplyState) {
  if (state.kind === 'answered') return replannable(state.operation);
  return state.kind === 'idle' || state.kind === 'planned';
}

/** The plan this dialog prepared, while it is shown. */
export const shownPlan = (state: ApplyState) => ('plan' in state ? state.plan : undefined);

/** The plan was made from an event that has changed since. */
export const stalePlan = (state: ApplyState, basis: string) => {
  const plan = shownPlan(state);
  return state.kind !== 'answered' && !!plan && plan.basis !== basis;
};

/** One request per plan: only a plan that is current and not yet sent can be sent. */
export const canSend = (state: ApplyState, basis: string) =>
  state.kind === 'planned' && !stalePlan(state, basis);

export function applyTransition(state: ApplyState, action: ApplyAction): ApplyState {
  switch (action.type) {
    case 'open':
      if (state.kind === 'planned') return idleApply;
      if (state.kind === 'answered' && finishedOperation(state.operation)) return idleApply;
      return state.kind !== 'idle' && state.plan ? { ...state, plan: undefined } : state;
    case 'replan':
      if (!canPrepare(state)) return state;
      return shownPlan(state) ? { kind: 'planned', plan: shownPlan(state)! } : idleApply;
    case 'planned':
      return canPrepare(state) ? { kind: 'planned', plan: action.plan } : state;
    case 'planFailed':
      return canPrepare(state) ? idleApply : state;
    case 'send':
      return state.kind === 'planned' ? { kind: 'sending', plan: state.plan } : state;
    case 'answered':
      // A late answer is shown in whichever dialog is open, finished or not.
      return state.kind === 'sending'
        ? { kind: 'answered', operation: action.operation, plan: state.plan }
        : state;
    case 'status':
      // Only while that operation is still the one shown: a slow answer never overwrites a plan
      // or send started after it.
      return state.kind === 'answered' && state.operation.operation === action.operation.operation
        ? { ...state, operation: action.operation }
        : state;
    case 'noAnswer':
      return state.kind === 'sending' ? { kind: 'noAnswer', plan: state.plan } : state;
  }
}
