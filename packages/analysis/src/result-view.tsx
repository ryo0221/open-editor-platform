import { useState } from 'react';
import { ReferenceError } from '@editor-platform/artifact-references';
import { resultSvg } from './references';
import type {
  AnalysisDocument,
  AnalysisDifference,
  Run,
  Table,
} from '@editor-platform/analysis-core';
import type { ScalarType } from '@editor-platform/calculation-core';
/** Display only: never coerce decimal strings through binary64. */
export function displayValue(value: unknown, type?: ScalarType): string {
  if (value === undefined) return '欠落';
  if (value === null) return 'null（値なし）';
  if (value === '') return '空文字';
  const s = String(value);
  return type?.kind === 'decimal'
    ? s.replace(
        /^(-?\d+)(\.\d+)?$/,
        (_, integer: string, fraction: string = '') =>
          integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction,
      )
    : s;
}
export function runLabel(run: Run, document: AnalysisDocument) {
  const index = document.runs.findIndex((r) => r.id === run.id) + 1;
  const name =
    document.scenarios.find((s) => s.id === run.basis.scenarioId)?.name ?? '現在のparameter';
  return `実行 ${index} — ${name} (${Object.values(run.results).reduce((n, t) => n + t.rows.length, 0)}件)`;
}
/** The table remains usable when a requested Chart exceeds the projection contract. */
export function ResultChart({ table }: { table: Table }) {
  if (table.rows.length > 100)
    return (
      <p>
        Chartは100件までです（現在{table.rows.length}
        件）。結果表を表示しています。filterやaggregateで100件以内に絞って再実行してください。
      </p>
    );
  try {
    return (
      <img
        alt="分析Chart（描画値は近似）"
        src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(resultSvg(table, true))}
      />
    );
  } catch (error) {
    if (!(error instanceof ReferenceError)) throw error;
    return (
      <p>
        Chartを表示できません。{error.message}{' '}
        結果表を表示しています。selectでdecimal列を含む30列以内の出力にしてください。
      </p>
    );
  }
}
export function ResultTable({ table, select }: { table: Table; select?(id: string): void }) {
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0);
  const rows = table.rows.filter(
    (r) =>
      !query ||
      table.fields.some(
        (f) =>
          String(r.values[f.id] ?? 'null').includes(query) ||
          displayValue(r.values[f.id], f.type).includes(query),
      ),
  );
  const last = Math.max(0, Math.ceil(rows.length / 50) - 1),
    current = Math.min(page, last);
  return (
    <>
      <label>
        結果を検索
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
      </label>
      <p>
        {rows.length}件 / 全{table.rows.length}件 · {current + 1} / {last + 1}ページ
      </p>
      <div className="analysis-table">
        <table>
          <thead>
            <tr>
              {table.fields.map((f) => (
                <th key={f.id}>
                  {f.label}
                  {f.type.kind === 'decimal' &&
                    f.type.unit !== 'dimensionless' &&
                    ` [${f.type.unit}]`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(current * 50, current * 50 + 50).map((r) => (
              <tr key={r.id} onClick={() => select?.(r.id)}>
                {table.fields.map((f) => (
                  <td
                    key={f.id}
                    title={`原値: ${r.values[f.id] === null ? 'null' : String(r.values[f.id])}`}
                  >
                    {displayValue(r.values[f.id], f.type)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button disabled={current === 0} onClick={() => setPage(current - 1)}>
        前の50件
      </button>
      <button disabled={current === last} onClick={() => setPage(current + 1)}>
        次の50件
      </button>
    </>
  );
}
const labels: Record<string, string> = {
  inputs: '入力版',
  parameters: 'Parameter',
  steps: '処理',
  expression: '式',
  outputs: '出力',
  'basis-inputs': '実行時の入力版',
  'basis-sources': '入力の依存版',
  'basis-parameters': '実行時のParameter',
  'basis-steps': '実行時の処理',
  'row-count': '結果件数',
  value: '値・単位',
  'row-added': '行追加',
  'row-removed': '行削除',
  'field-removed': '列削除',
  regrouped: '集計・結合の構造変更',
  run: '成功結果',
  snapshotKey: '保存版',
  valueKey: '値',
  type: '型',
  kind: '型',
  unit: '単位',
  label: '名前',
  selectedColumnIds: '選択列',
  columnMapping: '列対応',
  groupBy: 'グループ列',
  metrics: '集計',
  operation: '演算',
  fieldId: '列',
  scale: '小数桁',
  rounding: '丸め',
  parameterValues: '条件値',
};
const binaryOperators: Record<string, string> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
  eq: '=',
  lt: '<',
  gt: '>',
  and: 'かつ',
  or: 'または',
};
function typeText(value: unknown): string {
  const type = value as ScalarType;
  return type.kind === 'decimal' ? `decimal [${type.unit}]` : type.kind;
}
/** Keep AST operands and stable reference targets in the visible before/after cells. */
function expressionText(
  value: Record<string, unknown>,
  document: AnalysisDocument,
): string | undefined {
  const child = (value: unknown) => readable(value, document);
  if (value.op === 'field') return `列 [${String(value.id)}]`;
  if (value.op === 'parameter') return `Parameter [${String(value.id)}]`;
  if (value.op === 'literal')
    return `定数 ${displayValue(value.value, value.type as ScalarType)} · ${typeText(value.type)}`;
  if (value.op === 'cast') return `型・単位変換(${child(value.value)}) → ${typeText(value.type)}`;
  if (value.op === 'quantize')
    return `丸め(${child(value.value)}) · 小数${String(value.scale)}桁 / ${String(value.rounding)}`;
  if (value.op === 'if')
    return `条件分岐(${child(value.condition)} ? ${child(value.then)} : ${child(value.else)})`;
  if (typeof value.op === 'string' && Object.hasOwn(binaryOperators, value.op))
    return `(${child(value.left)} ${binaryOperators[value.op]} ${child(value.right)})${value.op === 'divide' ? ` · 小数${String(value.scale)}桁 / ${String(value.rounding)}` : ''}`;
}
function readable(value: unknown, document: AnalysisDocument): string {
  if (typeof value === 'string') {
    const source = document.retainedSources.find((s) => s.key === value);
    if (source) {
      const index =
        document.retainedSources
          .filter((s) => s.pin.artifactId === source.pin.artifactId)
          .findIndex((s) => s.key === value) + 1;
      const name =
        [...document.inputs, ...document.runs.flatMap((r) => r.basis.inputs)].find(
          (i) => i.snapshotKey === value,
        )?.name ?? '入力';
      return `${name} / 保持版 ${index} (${source.pin.versionId})`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => readable(v, document)).join('\n');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const expression = expressionText(record, document);
    if (expression !== undefined) return expression;
    if (
      'value' in record &&
      'type' in record &&
      (record.value === null || typeof record.value !== 'object')
    ) {
      const type = record.type as ScalarType | null;
      return `${typeof record.label === 'string' ? record.label + ': ' : ''}${displayValue(record.value, type ?? undefined)}${type?.kind === 'decimal' ? ` [${type.unit}]` : type ? ` [${type.kind}]` : ''}`;
    }
    return Object.entries(record)
      .filter(([key]) => key !== 'id')
      .map(([k, v]) => `${labels[k] ?? k}: ${readable(v, document)}`)
      .join('\n');
  }
  return displayValue(value);
}
export function DifferenceTable({
  changes,
  document,
  label,
}: {
  changes: AnalysisDifference[];
  document: AnalysisDocument;
  label: string;
}) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(changes.length / 50) - 1),
    current = Math.min(page, last);
  return (
    <section aria-label={label}>
      <p>{changes.length}項目 · 同じ安定IDの値を比較します。構造変更時は行対応を推測しません。</p>
      <div className="analysis-table">
        <table className="analysis-diff">
          <thead>
            <tr>
              <th>変更対象</th>
              <th>変更前</th>
              <th>変更後</th>
              <th>差額（同じ単位）</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(current * 50, current * 50 + 50).map((d, i) => (
              <tr key={i}>
                <th>
                  {labels[d.kind] ?? d.kind}
                  <details>
                    <summary>識別子</summary>
                    {d.id}
                  </details>
                </th>
                <td>{readable(d.before, document)}</td>
                <td>{readable(d.after, document)}</td>
                <td>
                  {d.delta === undefined
                    ? '—'
                    : displayValue(d.delta, { kind: 'decimal', unit: 'dimensionless' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button disabled={current === 0} onClick={() => setPage(current - 1)}>
        前の差分
      </button>
      <button disabled={current === last} onClick={() => setPage(current + 1)}>
        次の差分
      </button>
      <details>
        <summary>差分の詳細JSON</summary>
        <pre>{JSON.stringify(changes, null, 2)}</pre>
      </details>
    </section>
  );
}
