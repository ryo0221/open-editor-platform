import { type ReactNode } from 'react';
import { owdElements, type OwdElementKind, type OwdJson, type OwdRecord } from '../model';
import { choicesOf, diagnosticsOf, kindLabels, sameRef, useWorkflow } from './context';
import { IdList, SelectField, TextField } from './fields';
import { ElementActions } from './element-actions';
import { OutlineEditor } from './outline';

const str = (v: OwdJson | undefined) => (typeof v === 'string' ? v : '');
const ids = (v: OwdJson | undefined) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function Row({
  kind,
  record,
  index,
  count,
  children,
}: {
  kind: OwdElementKind;
  record: OwdRecord;
  index: number;
  count: number;
  children: ReactNode;
}) {
  const { selected, select, diagnostics } = useWorkflow();
  const target = { kind, id: record.id as string };
  const own = diagnosticsOf(diagnostics, target);
  return (
    <tr
      className={sameRef(selected, target) ? 'ep-wd-selected' : undefined}
      data-element={`${kind}:${target.id}`}
      onFocus={() => select(target)}
    >
      <th scope="row">
        <button
          type="button"
          className="ep-wd-id"
          aria-label={`Select ${kindLabels[kind]} ${target.id}`}
          onClick={() => select(target)}
        >
          {target.id}
        </button>
        {own.length > 0 && (
          <span className="ep-wd-count" title={own.map((d) => d.message).join('\n')}>
            {own.length}
          </span>
        )}
      </th>
      {children}
      <td>
        <ElementActions target={target} index={index} count={count} />
      </td>
    </tr>
  );
}
function Table({
  kind,
  columns,
  cells,
}: {
  kind: OwdElementKind;
  columns: string[];
  cells: (record: OwdRecord) => ReactNode;
}) {
  const { definition } = useWorkflow();
  const list = owdElements(definition, kind);
  return (
    <section className="ep-wd-list" aria-label={`${kindLabels[kind]} list`}>
      <h3>
        {kindLabels[kind]}（{list.length}）
      </h3>
      {list.length === 0 ? (
        <p className="ep-wd-empty">まだありません。上の「追加」で足します。</p>
      ) : (
        <div className="ep-wd-scroll">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((record, index) => (
                <Row
                  key={`${String(record.id)}-${index}`}
                  kind={kind}
                  record={record}
                  index={index}
                  count={list.length}
                >
                  {cells(record)}
                </Row>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
/** The lists tab (design §5): phases, sections, deliverables, acceptance and roles as tables. */
export function WorkflowLists() {
  const { definition, readOnly, edit, selected } = useWorkflow();
  const set = (kind: OwdElementKind, id: string, field: string, value: OwdJson) =>
    edit([{ type: 'set-fields', kind, id, fields: { [field]: value } }]);
  const text = (
    kind: OwdElementKind,
    r: OwdRecord,
    field: string,
    label: string,
    optional = false,
  ) => (
    <td>
      <TextField
        label={`${label} of ${String(r.id)}`}
        value={str(r[field])}
        readOnly={readOnly}
        required={!optional}
        onCommit={(v) => set(kind, r.id as string, field, optional && !v ? null : v)}
      />
    </td>
  );
  const list = (
    kind: OwdElementKind,
    r: OwdRecord,
    field: string,
    label: string,
    of: OwdElementKind,
  ) => (
    <td>
      <IdList
        label={`${label} of ${String(r.id)}`}
        values={ids(r[field])}
        choices={choicesOf(definition, of).filter((c) => !(of === kind && c.value === r.id))}
        readOnly={readOnly}
        onChange={(v) =>
          void set(kind, r.id as string, field, v.length || field !== 'uses' ? v : null)
        }
      />
    </td>
  );
  const deliverable =
    selected?.kind === 'deliverable'
      ? owdElements(definition, 'deliverable').find((d) => d.id === selected.id)
      : undefined;
  return (
    <div className="ep-wd-lists">
      <Table
        kind="phase"
        columns={['名前', '目的', '先に終える工程', '成果物', '終える条件', 'アイコン']}
        cells={(r) => (
          <>
            {text('phase', r, 'name', 'Name')}
            {text('phase', r, 'purpose', 'Purpose')}
            {list('phase', r, 'after', 'After', 'phase')}
            {list('phase', r, 'deliverables', 'Deliverables', 'deliverable')}
            {list('phase', r, 'acceptance', 'Acceptance', 'acceptance')}
            {text('phase', r, 'icon', 'Icon', true)}
          </>
        )}
      />
      <Table
        kind="section"
        columns={['名前', '工程', 'アイコン']}
        cells={(r) => (
          <>
            {text('section', r, 'name', 'Name')}
            {list('section', r, 'phases', 'Phases', 'phase')}
            {text('section', r, 'icon', 'Icon', true)}
          </>
        )}
      />
      <Table
        kind="deliverable"
        columns={['名前', '表現形態', 'もとにする成果物', '章立て']}
        cells={(r) => (
          <>
            {text('deliverable', r, 'name', 'Name')}
            {text('deliverable', r, 'form', 'Form')}
            {list('deliverable', r, 'uses', 'Uses', 'deliverable')}
            <td>{Array.isArray(r.outline) ? `見出し ${r.outline.length}` : '—'}</td>
          </>
        )}
      />
      {deliverable && <OutlineEditor deliverable={deliverable} />}
      <Table
        kind="acceptance"
        columns={['条件', '確かめる', '確かめる成果物', '規則', '確かめる役割', '人数']}
        cells={(r) => {
          const approvers = (r.approvers ?? undefined) as OwdRecord | undefined;
          const roles = ids(approvers?.roles);
          return (
            <>
              {text('acceptance', r, 'text', 'Text')}
              <td>
                <SelectField
                  label={`Checked by of ${String(r.id)}`}
                  value={str(r.checkedBy)}
                  choices={[
                    { value: '人', label: '人' },
                    { value: 'AI', label: 'AI' },
                  ]}
                  readOnly={readOnly}
                  onChange={(v) => v && set('acceptance', r.id as string, 'checkedBy', v)}
                />
              </td>
              <td>
                <SelectField
                  label={`Target of ${String(r.id)}`}
                  value={str(r.target)}
                  choices={choicesOf(definition, 'deliverable')}
                  readOnly={readOnly}
                  onChange={(v) => v && set('acceptance', r.id as string, 'target', v)}
                />
              </td>
              {list('acceptance', r, 'rules', 'Rules', 'rule')}
              <td>
                <IdList
                  label={`Approver roles of ${String(r.id)}`}
                  values={roles}
                  choices={choicesOf(definition, 'role')}
                  readOnly={readOnly}
                  onChange={(v) =>
                    void set(
                      'acceptance',
                      r.id as string,
                      'approvers',
                      v.length ? { ...(approvers ?? {}), roles: v } : null,
                    )
                  }
                />
              </td>
              <td>
                <TextField
                  label={`Approver count of ${String(r.id)}`}
                  value={approvers?.count === undefined ? '' : String(approvers.count)}
                  readOnly={readOnly || !approvers}
                  onCommit={(v) => {
                    const next: OwdRecord = { ...(approvers ?? { roles: [] }) };
                    if (v === '') delete next.count;
                    else if (/^\d+$/.test(v)) next.count = Number(v);
                    else return '人数は 1 以上の整数です';
                    return set('acceptance', r.id as string, 'approvers', next);
                  }}
                />
              </td>
            </>
          );
        }}
      />
      <Table
        kind="role"
        columns={['名前', '説明']}
        cells={(r) => (
          <>
            {text('role', r, 'name', 'Name')}
            {text('role', r, 'text', 'Description', true)}
          </>
        )}
      />
    </div>
  );
}
