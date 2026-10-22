import { useEffect, useRef, useState } from 'react';
import {
  canPrepare,
  canSend,
  finishedOperation,
  shownPlan,
  stalePlan,
  type ApplyAction,
  type ApplyState,
} from './apply-state';
import {
  dispatched,
  effectIntent,
  planBasis,
  summarizeOperation,
  type ScheduleEffectPort,
  type StepState,
} from './host';
import type { ScheduleEvent } from './model';

export const stepText: Record<StepState, string> = {
  prepared: 'Not sent yet',
  dispatching: 'Sending',
  accepted: 'Accepted, not yet confirmed',
  'failed-after-acceptance': 'Failed after it was accepted',
  unknown: 'Result unknown',
  verified: 'Confirmed',
  rejected: 'Refused',
  conflict: 'Conflict',
  'cancelled-before-dispatch': 'Cancelled before sending',
};
const summaryText = {
  pending: 'Waiting to send.',
  verified: 'Added to the calendar and confirmed.',
  partial: 'Partly done. Some steps finished and some did not. Nothing was rolled back.',
  unknown:
    'Result unknown. The calendar did not confirm whether this was created. Do not send it again; the Host has to check it first.',
  rejected: 'Not added. The calendar refused the request.',
  'failed-after-acceptance':
    'Failed after the calendar accepted it. Something may already be in the calendar; check it there before sending again.',
  cancelled: 'Cancelled before sending. Nothing was sent.',
  conflict: 'The calendar changed. Prepare a new plan.',
};

const sendingText = 'Sending. The Host has not answered yet; nothing else is sent for this event.';
const unknownSendText =
  'Result unknown. The request may have reached the Host, so this event may already be in the calendar. Check the calendar or ask the Host to reconcile it before sending again.';

/** Plan, confirm and observe one external effect. The Host owns the plan, the permission
 * checks and the dispatch; this dialog never sends anything by itself. */
export function ApplyDialog({
  event,
  effects,
  state,
  onApply,
  prepareInputs,
  onClose,
}: {
  event: ScheduleEvent;
  effects: ScheduleEffectPort;
  /** This event's send, kept by the Surface across closing the dialog. */
  state: ApplyState;
  /** Moves this event's send on at once and returns the new state, or undefined when the action
   * does not apply now (so a double click finds the send already started). */
  onApply: (action: ApplyAction) => ApplyState | undefined;
  /** Commits the details' pending text first; throws when it is refused or still composing. */
  prepareInputs: () => void;
  onClose: () => void;
}) {
  const [includeNotes, setIncludeNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.querySelector<HTMLElement>('input,button')?.focus(), []);
  const intent = effectIntent(event, { includeNotes });
  const plan = shownPlan(state);
  const status = state.kind === 'answered' ? state.operation : undefined;
  const stale = stalePlan(state, planBasis(intent));
  // The event as last rendered: committing pending text re-renders before it is read.
  const latest = useRef(event);
  latest.current = event;
  /** The intent after the details' text is committed, or undefined when that text is refused. */
  function committedIntent() {
    try {
      prepareInputs();
      return effectIntent(latest.current, { includeNotes });
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    }
  }
  async function prepare() {
    const current = committedIntent();
    if (!current) return;
    setBusy(true);
    setError('');
    setMessage('');
    onApply({ type: 'replan' });
    try {
      onApply({
        type: 'planned',
        plan: await effects.prepare(current, planBasis(current), new AbortController().signal),
      });
    } catch (e) {
      onApply({ type: 'planFailed' });
      setError((e as Error).message || 'The Host could not prepare a plan.');
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    // Text typed after planning is committed first; a change makes the plan stale.
    const current = committedIntent();
    if (!current || !canSend(state, planBasis(current))) return;
    // Recorded on the Surface before dispatch, so a double click or closing and reopening
    // cannot send again: one request per plan.
    const sending = onApply({ type: 'send' });
    if (sending?.kind !== 'sending' || !sending.plan) return;
    setBusy(true);
    setError('');
    try {
      onApply({ type: 'answered', operation: await effects.requestExecution(sending.plan.handle) });
    } catch (e) {
      // No answer is not "not sent": a new plan would be a second event, so nothing is offered
      // again until the Host has reconciled what happened.
      onApply({ type: 'noAnswer' });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!status) return;
    setBusy(true);
    try {
      const next = await effects.cancelPending(status.operation);
      onApply({ type: 'status', operation: next });
      setMessage(
        dispatched(next.steps)
          ? 'Already sent. Cancelling here does not remove anything from the calendar.'
          : '',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    if (!status) return;
    try {
      onApply({ type: 'status', operation: await effects.getStatus(status.operation) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const summary = status ? summarizeOperation(status.steps) : undefined;
  const finished = status ? finishedOperation(status) : false;
  return (
    <div className="ep-schedule-apply">
      <div
        ref={dialog}
        role="dialog"
        aria-label="Apply to calendar"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2>Apply to calendar</h2>
        {state.kind === 'sending' && (
          <p role="status" className="ep-schedule-warning">
            {sendingText}
          </p>
        )}
        {state.kind === 'noAnswer' && (
          <p role="alert" className="ep-schedule-warning">
            {unknownSendText}
          </p>
        )}
        <p className="ep-schedule-muted">
          Saving or undoing never sends anything. Only this dialog asks the Host to send.
        </p>
        {!status && (
          <>
            <label className="ep-schedule-check">
              <input
                type="checkbox"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
              />
              Include notes in the invitation
            </label>
            <p className="ep-schedule-muted">
              Related work, lanes and project links are never sent.
            </p>
            <button
              type="button"
              disabled={busy || !canPrepare(state)}
              onClick={() => void prepare()}
            >
              {plan ? 'Prepare again' : 'Prepare plan'}
            </button>
          </>
        )}
        {plan && (
          <section aria-label="Plan" className="ep-schedule-plan">
            <dl>
              <dt>Calendar</dt>
              <dd>{plan.calendar}</dd>
              <dt>Organizer</dt>
              <dd>{plan.organizer}</dd>
              <dt>Notifies</dt>
              <dd>{plan.notifies}</dd>
            </dl>
            <h3>Will send</h3>
            <dl data-testid="plan-sends">
              {plan.sends.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {stale && (
              <p role="alert" className="ep-schedule-warning">
                The event changed after this plan was prepared. Prepare it again before sending.
              </p>
            )}
            {!status && (
              <button
                type="button"
                className="ep-schedule-primary"
                disabled={busy || !canSend(state, planBasis(intent))}
                onClick={() => void send()}
              >
                Send to calendar
              </button>
            )}
          </section>
        )}
        {status && summary && (
          <section aria-label="Result" className="ep-schedule-result">
            <p role="status" data-summary={summary}>
              {summaryText[summary]}
            </p>
            <ul>
              {status.steps.map((step) => (
                <li key={step.id} data-state={step.state}>
                  <strong>{step.label}:</strong> {stepText[step.state]}
                  {step.detail ? ` — ${step.detail}` : ''}
                </li>
              ))}
            </ul>
            {status.blocked === 'revoked' && (
              <p className="ep-schedule-warning">
                The calendar connection was revoked. Recorded results are kept.
              </p>
            )}
            {/* Nothing was applied: a new plan is the way on. */}
            {canPrepare(state) && (
              <button type="button" disabled={busy} onClick={() => void prepare()}>
                Prepare again
              </button>
            )}
            {!finished && (
              <button type="button" disabled={busy} onClick={() => void refresh()}>
                Check status
              </button>
            )}
            {!finished && (
              <button type="button" disabled={busy} onClick={() => void cancel()}>
                Cancel sending
              </button>
            )}
          </section>
        )}
        {message && <p className="ep-schedule-warning">{message}</p>}
        {error && (
          <p role="alert" className="ep-schedule-error">
            {error}
          </p>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
