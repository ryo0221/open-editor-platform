import { useState } from 'react';
import { owdIdTaken, validOwdId, workflowDefinitionReferrers, type OwdElementRef } from '../model';
import { kindLabels, useWorkflow } from './context';

/** Delete with the cascade confirmation (design §1 refusal 2), and the explicit ID change. */
export function ElementActions({
  target,
  index,
  count,
}: {
  target: OwdElementRef;
  index: number;
  count: number;
}) {
  const { definition, readOnly, edit } = useWorkflow();
  const [confirm, setConfirm] = useState<string[]>(),
    [renaming, setRenaming] = useState<string>(),
    [error, setError] = useState<string>();
  if (readOnly) return null;
  const label = `${kindLabels[target.kind]} ${target.id}`;
  const remove = () => {
    const users = workflowDefinitionReferrers(definition, target);
    const free = target.kind === 'phase' || target.kind === 'section';
    if (users.length && !free) return setConfirm(users.map((u) => `${kindLabels[u.kind]} ${u.id}`));
    setError(edit([{ type: 'delete', kind: target.kind, id: target.id }]));
  };
  const rename = () => {
    const to = renaming ?? '';
    if (!validOwdId(to)) return setError('ID は英小文字の語を - と . でつなぎます');
    if (to !== target.id && owdIdTaken(definition, target.kind, to))
      return setError(`ID ${to} はもう使われています`);
    const failed = edit([{ type: 'rename-id', kind: target.kind, id: target.id, to }]);
    setError(failed);
    if (!failed) setRenaming(undefined);
  };
  return (
    <div className="ep-wd-actions">
      <button
        type="button"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() =>
          setError(edit([{ type: 'move', kind: target.kind, id: target.id, index: index - 1 }]))
        }
      >
        ↑
      </button>
      <button
        type="button"
        aria-label={`Move ${label} down`}
        disabled={index >= count - 1}
        onClick={() =>
          setError(edit([{ type: 'move', kind: target.kind, id: target.id, index: index + 1 }]))
        }
      >
        ↓
      </button>
      {renaming === undefined ? (
        <button
          type="button"
          aria-label={`Change ID of ${label}`}
          onClick={() => setRenaming(target.id)}
        >
          ID を変える
        </button>
      ) : (
        <span className="ep-wd-rename">
          <input
            aria-label={`New ID of ${label}`}
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && rename()}
          />
          <button type="button" onClick={rename}>
            変える
          </button>
          <button type="button" onClick={() => setRenaming(undefined)}>
            やめる
          </button>
        </span>
      )}
      <button type="button" aria-label={`Delete ${label}`} onClick={remove}>
        削除
      </button>
      {confirm && (
        <div role="alertdialog" aria-label={`Confirm deleting ${label}`} className="ep-wd-confirm">
          <p>
            {label} は {confirm.join('、')} から使われています。参照も外して削除しますか。
          </p>
          <button
            type="button"
            onClick={() => {
              setConfirm(undefined);
              setError(edit([{ type: 'delete', kind: target.kind, id: target.id, cascade: true }]));
            }}
          >
            参照も外して削除
          </button>
          <button type="button" onClick={() => setConfirm(undefined)}>
            やめる
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="ep-wd-error">
          {error}
        </p>
      )}
    </div>
  );
}
