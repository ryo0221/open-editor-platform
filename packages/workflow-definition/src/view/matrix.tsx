import { useState, type ReactNode } from 'react';
import { owdElements, validOwdId, owdIdTaken, type OwdJson, type OwdRecord } from '../model';
import { choicesOf, kindLabels, sameRef, useWorkflow } from './context';
import { IdList, SelectField, TextField } from './fields';
import { ElementActions } from './element-actions';

/** Rows and columns a matrix draws (design §5: several times the largest OWD definition today). */
export const matrixLimit = 200;
const ids = (v: OwdJson | undefined) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const str = (v: OwdJson | undefined) => (typeof v === 'string' ? v : '');

function Grid(props: {
  label: string;
  rows: string[];
  columns: string[];
  cell: (row: string, column: string) => ReactNode;
}) {
  if (props.rows.length > matrixLimit || props.columns.length > matrixLimit)
    return (
      <p role="status">
        {props.label}：行・列が {matrixLimit} を超えるので表にしません。一覧で編集します。
      </p>
    );
  if (!props.rows.length || !props.columns.length)
    return <p className="ep-wd-empty">{props.label}：まだ行か列がありません。</p>;
  return (
    <div className="ep-wd-scroll">
      <table className="ep-wd-matrix" aria-label={props.label}>
        <thead>
          <tr>
            <th />
            {props.columns.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r}>
              <th scope="row">{r}</th>
              {props.columns.map((c) => (
                <td key={c}>{props.cell(r, c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** A rule ID in a cell: selecting it highlights all of that rule's cells. */
function RuleChip({ id }: { id: string }) {
  const { selected, select } = useWorkflow();
  const target = { kind: 'rule' as const, id };
  return (
    <button
      type="button"
      className={sameRef(selected, target) ? 'ep-wd-rule ep-wd-selected' : 'ep-wd-rule'}
      aria-label={`Select rule ${id}`}
      aria-pressed={sameRef(selected, target)}
      onClick={() => select(target)}
    >
      {id}
    </button>
  );
}
/**
 * An empty pair cell: add the column kind to an existing rule of the row (same `from` for cites,
 * same `of` for covered) or make a new rule. A rule is always edited as a whole (`set-rule`).
 */
function EmptyPair({
  type,
  row,
  column,
}: {
  type: 'cites' | 'covered';
  row: string;
  column: string;
}) {
  const { definition, edit, readOnly } = useWorkflow();
  const [open, setOpen] = useState(false),
    [newId, setNewId] = useState(''),
    [error, setError] = useState<string>();
  if (readOnly) return null;
  const rules = owdElements(definition, 'rule').filter(
    (r) => r.type === type && (type === 'cites' ? r.from === row : r.of === row),
  );
  const label = `${row} → ${column}`;
  if (!open)
    return (
      <button
        type="button"
        className="ep-wd-add-pair"
        aria-label={`Allow ${type} ${label}`}
        onClick={() => setOpen(true)}
      >
        ＋
      </button>
    );
  const extend = (rule: OwdRecord) => {
    const key = type === 'cites' ? 'to' : 'by';
    const { id, ...rest } = rule;
    setError(
      edit([
        {
          type: 'set-rule',
          id: id as string,
          rule: { ...rest, [key]: [...ids(rule[key]), column] } as OwdRecord,
        },
      ]),
    );
  };
  const create = () => {
    if (!validOwdId(newId)) return setError('ID は英小文字の語を - と . でつなぎます');
    if (owdIdTaken(definition, 'rule', newId)) return setError(`規則 ${newId} はもうあります`);
    const fields: OwdRecord =
      type === 'cites'
        ? { type, from: row, to: [column], min: 0 }
        : { type, of: row, by: [column] };
    setError(edit([{ type: 'add', kind: 'rule', id: newId, fields }]));
  };
  return (
    <div className="ep-wd-pair" role="group" aria-label={`New ${type} ${label}`}>
      {rules.map((r) => (
        <button key={r.id as string} type="button" onClick={() => extend(r)}>
          {r.id as string} に足す
        </button>
      ))}
      <input
        aria-label={`New rule ID for ${label}`}
        value={newId}
        placeholder="新しい規則の ID"
        onChange={(e) => setNewId(e.target.value)}
      />
      <button type="button" onClick={create}>
        新しい規則
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        やめる
      </button>
      {error && (
        <p role="alert" className="ep-wd-error">
          {error}
        </p>
      )}
    </div>
  );
}
function RuleEditor({ rule }: { rule: OwdRecord }) {
  const { definition, readOnly, edit } = useWorkflow();
  const items = choicesOf(definition, 'item');
  const { id, ...content } = rule;
  const set = (patch: OwdRecord) => {
    const next: OwdRecord = { ...content, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
    return edit([{ type: 'set-rule', id: id as string, rule: next }]);
  };
  return (
    <section className="ep-wd-rule-editor" aria-label={`Rule ${String(id)}`}>
      <h4>規則 {id as string}</h4>
      <SelectField
        label={`Type of rule ${String(id)}`}
        value={str(rule.type)}
        choices={[
          { value: 'cites', label: 'cites（引用）' },
          { value: 'covered', label: 'covered（網羅）' },
        ]}
        readOnly={readOnly}
        onChange={(v) =>
          v &&
          set(
            v === 'cites'
              ? { type: v, of: null, by: null, exempt: null, to: [], min: 0 }
              : { type: v, from: null, to: null, min: null, by: [] },
          )
        }
      />
      {rule.type === 'cites' ? (
        <>
          <SelectField
            label={`From of rule ${String(id)}`}
            value={str(rule.from)}
            choices={items}
            readOnly={readOnly}
            onChange={(v) => v && set({ from: v })}
          />
          <IdList
            label={`To of rule ${String(id)}`}
            values={ids(rule.to)}
            choices={items}
            readOnly={readOnly}
            onChange={(v) => void set({ to: v })}
          />
          <TextField
            label={`Min of rule ${String(id)}`}
            value={rule.min === undefined ? '' : String(rule.min)}
            readOnly={readOnly}
            onCommit={(v) => (/^\d+$/.test(v) ? set({ min: Number(v) }) : '0 以上の整数です')}
          />
        </>
      ) : (
        <>
          <SelectField
            label={`Of of rule ${String(id)}`}
            value={str(rule.of)}
            choices={items}
            readOnly={readOnly}
            onChange={(v) => v && set({ of: v })}
          />
          <IdList
            label={`By of rule ${String(id)}`}
            values={ids(rule.by)}
            choices={items}
            readOnly={readOnly}
            onChange={(v) => void set({ by: v })}
          />
          <label>
            <input
              type="checkbox"
              aria-label={`Exempt of rule ${String(id)}`}
              checked={rule.exempt === true}
              disabled={readOnly}
              onChange={(e) => set({ exempt: e.target.checked ? true : null })}
            />
            理由を書けば除ける
          </label>
        </>
      )}
    </section>
  );
}
/** The matrix tab (design §5): item kinds and rules, and four matrices. */
export function WorkflowMatrices() {
  const { definition, readOnly, edit, selected } = useWorkflow();
  const phases = owdElements(definition, 'phase'),
    deliverables = owdElements(definition, 'deliverable'),
    acceptance = owdElements(definition, 'acceptance'),
    items = owdElements(definition, 'item'),
    rules = owdElements(definition, 'rule');
  const itemIds = items.map((i) => i.id as string);
  const pairRules = (type: 'cites' | 'covered', row: string, column: string) =>
    rules
      .filter((r) =>
        type === 'cites'
          ? r.type === 'cites' && r.from === row && ids(r.to).includes(column)
          : r.type === 'covered' && r.of === row && ids(r.by).includes(column),
      )
      .map((r) => r.id as string);
  const pairCell = (type: 'cites' | 'covered') => (row: string, column: string) => {
    const found = pairRules(type, row, column);
    return found.length ? (
      found.map((id) => <RuleChip key={id} id={id} />)
    ) : (
      <EmptyPair type={type} row={row} column={column} />
    );
  };
  const selectedRule =
    selected?.kind === 'rule' ? rules.find((r) => r.id === selected.id) : undefined;
  return (
    <div className="ep-wd-matrices">
      <section aria-label={`${kindLabels.item} list`} className="ep-wd-list">
        <h3>項目の種類（{items.length}）</h3>
        <div className="ep-wd-scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>名前</th>
                <th>ID の形</th>
                <th>親</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.id as string} data-element={`item:${String(item.id)}`}>
                  <th scope="row">{item.id as string}</th>
                  <td>
                    <TextField
                      label={`Name of item ${String(item.id)}`}
                      value={str(item.name)}
                      readOnly={readOnly}
                      required
                      onCommit={(v) =>
                        edit([
                          {
                            type: 'set-fields',
                            kind: 'item',
                            id: item.id as string,
                            fields: { name: v },
                          },
                        ])
                      }
                    />
                  </td>
                  <td>
                    <TextField
                      label={`ID form of item ${String(item.id)}`}
                      value={str(item.idForm)}
                      readOnly={readOnly}
                      required
                      onCommit={(v) =>
                        edit([
                          {
                            type: 'set-fields',
                            kind: 'item',
                            id: item.id as string,
                            fields: { idForm: v },
                          },
                        ])
                      }
                    />
                  </td>
                  <td>
                    <SelectField
                      label={`Parent of item ${String(item.id)}`}
                      value={str(item.parent)}
                      choices={choicesOf(definition, 'item').filter((c) => c.value !== item.id)}
                      readOnly={readOnly}
                      onChange={(v) =>
                        edit([
                          {
                            type: 'set-fields',
                            kind: 'item',
                            id: item.id as string,
                            fields: { parent: v || null },
                          },
                        ])
                      }
                    />
                  </td>
                  <td>
                    <ElementActions
                      target={{ kind: 'item', id: item.id as string }}
                      index={index}
                      count={items.length}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-label={`${kindLabels.rule} list`} className="ep-wd-list">
        <h3>規則（{rules.length}）</h3>
        <ul className="ep-wd-rules">
          {rules.map((r, index) => (
            <li key={r.id as string} data-element={`rule:${String(r.id)}`}>
              <RuleChip id={r.id as string} />
              <span>
                {r.type === 'cites'
                  ? `${str(r.from)} → ${ids(r.to).join('・')}（${String(r.min ?? '')} 件以上）`
                  : `${str(r.of)} ← ${ids(r.by).join('・')}${r.exempt ? '（除ける）' : ''}`}
              </span>
              <ElementActions
                target={{ kind: 'rule', id: r.id as string }}
                index={index}
                count={rules.length}
              />
            </li>
          ))}
        </ul>
        {selectedRule && <RuleEditor rule={selectedRule} />}
      </section>
      <h3>工程と成果物</h3>
      <Grid
        label="Phases and deliverables"
        rows={phases.map((p) => p.id as string)}
        columns={deliverables.map((d) => d.id as string)}
        cell={(row, column) => {
          const p = phases.find((x) => x.id === row)!;
          const makes = ids(p.deliverables).includes(column);
          const checks = ids(p.acceptance).filter(
            (a) => acceptance.find((x) => x.id === a)?.target === column,
          ).length;
          return (
            <label className="ep-wd-cell">
              <input
                type="checkbox"
                aria-label={`${row} makes ${column}`}
                checked={makes}
                disabled={readOnly}
                onChange={() =>
                  edit([
                    {
                      type: 'set-fields',
                      kind: 'phase',
                      id: row,
                      fields: {
                        deliverables: makes
                          ? ids(p.deliverables).filter((d) => d !== column)
                          : [...ids(p.deliverables), column],
                      },
                    },
                  ])
                }
              />
              {checks > 0 && <span title="確かめる条件の数">✓{checks}</span>}
            </label>
          );
        }}
      />
      <h3>引用（行の項目が列の項目を引く）</h3>
      <Grid label="Citations" rows={itemIds} columns={itemIds} cell={pairCell('cites')} />
      <h3>網羅（行の項目が列の項目から引かれる）</h3>
      <Grid label="Coverage" rows={itemIds} columns={itemIds} cell={pairCell('covered')} />
      <h3>条件と規則</h3>
      <Grid
        label="Acceptance and rules"
        rows={acceptance.map((a) => a.id as string)}
        columns={rules.map((r) => r.id as string)}
        cell={(row, column) => {
          const a = acceptance.find((x) => x.id === row)!;
          const on = ids(a.rules).includes(column);
          return (
            <input
              type="checkbox"
              aria-label={`${row} checks rule ${column}`}
              checked={on}
              disabled={readOnly}
              onChange={() => {
                const next = on
                  ? ids(a.rules).filter((r) => r !== column)
                  : [...ids(a.rules), column];
                edit([
                  {
                    type: 'set-fields',
                    kind: 'acceptance',
                    id: row,
                    fields: { rules: next.length ? next : null },
                  },
                ]);
              }}
            />
          );
        }}
      />
    </div>
  );
}
