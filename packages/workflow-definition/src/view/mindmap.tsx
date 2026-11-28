import { useState } from 'react';
import {
  owdBranchStatus,
  owdElementKinds,
  owdIdTaken,
  owdMindmapLink,
  validOwdId,
  type OwdElementKind,
  type OwdMindmapBranch,
  type OwdRecord,
} from '../model';
import { kindLabels, sameRef, useWorkflow } from './context';

/** Kinds a branch can become (design §7): the ones with a name or a text. */
const branchKinds = owdElementKinds.filter((k) => k !== 'rule');
const fieldsFor = (kind: OwdElementKind, id: string, title: string): OwdRecord =>
  kind === 'acceptance'
    ? { text: title }
    : kind === 'item'
      ? {
          name: title,
          idForm: `${
            id
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')
              .slice(0, 4) || 'X'
          }-{nn}`,
        }
      : { name: title };
/** A suggestion for the ID: the title's ASCII words, else empty (the person types it). */
const suggestId = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function Branch({ branch }: { branch: OwdMindmapBranch }) {
  const { definition, readOnly, edit, select, selected, mindmap } = useWorkflow();
  const [kind, setKind] = useState<OwdElementKind>('phase'),
    [id, setId] = useState(() => suggestId(branch.title)),
    [message, setMessage] = useState<string>();
  const status = owdBranchStatus(definition, branch);
  const problem = !id
    ? undefined
    : !validOwdId(id)
      ? 'ID は英小文字の語を - と . でつなぎます'
      : owdIdTaken(definition, kind, id)
        ? `ID ${id} はもう使われています`
        : undefined;
  const add = () => {
    if (!id || problem) return setMessage(problem ?? 'ID を入れてください');
    const failed = edit([{ type: 'add', kind, id, fields: fieldsFor(kind, id, branch.title) }]);
    if (failed) return setMessage(failed);
    select({ kind, id });
    // Two artifacts, two Undo records: the definition took the element; now the Mind Map's link.
    const linkFailed = mindmap!.requestLinks([
      { nodeId: branch.nodeId, link: owdMindmapLink(definition, { kind, id }) },
    ]);
    setMessage(linkFailed && `定義には足しました。枝の対応は付いていません（${linkFailed}）`);
  };
  const unlink = () => setMessage(mindmap!.requestLinks([{ nodeId: branch.nodeId, link: null }]));
  const label = branch.title || '（無題）';
  return (
    <li data-branch={branch.nodeId} className={`ep-wd-branch ep-wd-branch-${status.status}`}>
      <span className="ep-wd-branch-title">{label}</span>
      {status.status === 'linked' && (
        <button
          type="button"
          aria-pressed={sameRef(selected, status.target)}
          onClick={() => select(status.target)}
        >
          {kindLabels[status.target.kind]} {status.target.id}
        </button>
      )}
      {status.status === 'missing' && (
        <>
          <span role="status" className="ep-wd-error">
            対応先が無い：{kindLabels[status.target.kind]} {status.target.id}
          </span>
          {!readOnly && (
            <button type="button" aria-label={`Unlink branch ${label}`} onClick={unlink}>
              対応を外す
            </button>
          )}
        </>
      )}
      {status.status === 'other' && <span>ほかの定義か対象への対応</span>}
      {status.status === 'unlinked' && (
        <>
          <span>対応が付いていない</span>
          {!readOnly && (
            <span className="ep-wd-branch-add">
              <select
                aria-label={`Kind for branch ${label}`}
                value={kind}
                onChange={(e) => setKind(e.target.value as OwdElementKind)}
              >
                {branchKinds.map((k) => (
                  <option key={k} value={k}>
                    {kindLabels[k]}にする
                  </option>
                ))}
              </select>
              <input
                aria-label={`ID for branch ${label}`}
                placeholder="ID（英小文字）"
                value={id}
                aria-invalid={!!problem || undefined}
                onChange={(e) => {
                  setId(e.target.value);
                  setMessage(undefined);
                }}
              />
              <button type="button" aria-label={`Add branch ${label}`} onClick={add}>
                定義に足す
              </button>
            </span>
          )}
        </>
      )}
      {(message || (status.status === 'unlinked' && problem)) && (
        <span role="alert" className="ep-wd-error">
          {message ?? problem}
        </span>
      )}
    </li>
  );
}
/** 「マインドマップから足す」(design §7): branches, their link to this definition, and the drift. */
export function WorkflowMindmap() {
  const { definition, mindmap } = useWorkflow();
  if (!mindmap) return null;
  const counts = { linked: 0, missing: 0, other: 0, unlinked: 0 };
  for (const b of mindmap.branches) counts[owdBranchStatus(definition, b).status]++;
  return (
    <section aria-label="Mind Map branches" className="ep-wd-mindmap">
      <p>
        対応あり {counts.linked}・対応先が無い {counts.missing}・対応が付いていない{' '}
        {counts.unlinked}
        {counts.other ? `・ほか ${counts.other}` : ''}
      </p>
      <ul>
        {mindmap.branches.map((b) => (
          <Branch key={b.nodeId} branch={b} />
        ))}
      </ul>
    </section>
  );
}
