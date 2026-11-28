import { useState } from 'react';
import {
  applyWorkflowDefinitionIntents,
  workflowDefinitionDiff,
  type WorkflowDefinitionIntent,
} from '../model';
import { kindLabels, useWorkflow } from './context';

/** An edit proposed from outside (for example an AI draft), as definition intents. */
export interface WorkflowDefinitionProposal {
  label: string;
  intents: WorkflowDefinitionIntent[];
}
const words = { added: '追加', removed: '削除', changed: '変更', moved: '移動' };
/**
 * Preview, apply or reject (design §7): nothing enters the definition until the person applies
 * it, and then as one command through the same intents as the views.
 */
export function ProposalPanel({
  proposal,
  resolve,
}: {
  proposal: WorkflowDefinitionProposal;
  resolve(decision: 'applied' | 'rejected'): void;
}) {
  const { definition, readOnly, edit } = useWorkflow();
  const [failed, setFailed] = useState<string>();
  let preview: ReturnType<typeof workflowDefinitionDiff> | undefined, refused: string | undefined;
  try {
    preview = workflowDefinitionDiff(
      definition,
      applyWorkflowDefinitionIntents(definition, proposal.intents),
    );
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  return (
    <section aria-label="Proposal" className="ep-wd-proposal">
      <h3>提案：{proposal.label}</h3>
      {refused ? (
        <p role="alert" className="ep-wd-error">
          この提案は今の定義に適用できません：{refused}
        </p>
      ) : (
        <ul>
          {preview!.map((c, i) => (
            <li key={i}>
              {words[c.change]}{' '}
              {c.target ? `${kindLabels[c.target.kind]} ${c.target.id}` : `定義の ${c.field}`}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={readOnly || !!refused}
        onClick={() => {
          const reason = edit(proposal.intents);
          setFailed(reason);
          if (!reason) resolve('applied');
        }}
      >
        提案を適用
      </button>
      <button type="button" onClick={() => resolve('rejected')}>
        提案を断る
      </button>
      {failed && (
        <p role="alert" className="ep-wd-error">
          {failed}
        </p>
      )}
    </section>
  );
}
