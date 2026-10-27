import { canonicalJson } from '@editor-platform/artifact-core';
import { escapeXml, drawingSvg } from '@editor-platform/editor-core';
import {
  ReferenceError,
  svgReferenceProjection,
  type ReferenceAdapter,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { verifyAnalysis, type AnalysisDocument, type Table } from '@editor-platform/analysis-core';
import { browserAnalysisWorker, workerRequest, type AnalysisWorkerFactory } from './host';
import { isCurrentRun } from './current-run';
export function resultSvg(table: Table, chart = false): string {
  if (table.rows.length > 100 || table.fields.length > 30)
    throw new ReferenceError(
      'error',
      '参照表示は100行・30列までです。結果の表示範囲を絞ってください。',
    );
  if (chart) {
    const numeric = table.fields.find((f) => f.type.kind === 'decimal');
    if (!numeric) throw new ReferenceError('unsupported', 'Chartにはdecimal列が必要です。');
    const numbers = table.rows.map((r) =>
      r.values[numeric.id] === null ? null : Number(r.values[numeric.id]),
    );
    const max = Math.max(1, ...numbers.filter((n): n is number => n !== null).map(Math.abs));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${Math.max(100, table.rows.length * 32 + 50)}"><rect width="100%" height="100%" fill="white"/><text x="10" y="22">${escapeXml(numeric.label)} · 描画は近似値、ラベルは正確な値</text>${table.rows.map((r, i) => `<g><title>${escapeXml(String(r.values[numeric.id] ?? 'null'))}</title><rect x="180" y="${40 + i * 32}" width="${(Math.abs(numbers[i] ?? 0) / max) * 400}" height="22" fill="#5364b8"/><text x="8" y="${57 + i * 32}">${escapeXml(String(r.values[table.fields[0].id] ?? 'null'))}</text><text x="590" y="${57 + i * 32}">${escapeXml(String(r.values[numeric.id] ?? 'null'))}</text></g>`).join('')}</svg>`;
  }
  const width = Math.max(400, table.fields.length * 160),
    height = Math.max(80, (table.rows.length + 1) * 40);
  return drawingSvg(
    [
      {
        id: 'analysis-table',
        kind: 'table',
        bounds: { x: 0, y: 0, width, height },
        text: '',
        fill: '#253044',
        table: {
          header: true,
          rows: [
            table.fields.map(
              (f) =>
                f.label +
                (f.type.kind === 'decimal' && f.type.unit !== 'dimensionless'
                  ? ` [${f.type.unit}]`
                  : ''),
            ),
            ...table.rows.map((r) =>
              table.fields.map((f) => (r.values[f.id] === null ? 'null' : String(r.values[f.id]))),
            ),
          ],
        },
      },
    ],
    { x: 0, y: 0, width, height },
    '#fff',
  );
}
/** A fresh instance per Host scope; serialized verified flags have no meaning. */
export function createAnalysisReferenceAdapter(
  options: {
    generation?: () => string;
    check?: (snapshot: ReferenceSnapshot) => void;
    worker?: AnalysisWorkerFactory;
  } = {},
): ReferenceAdapter {
  const ready = new Set<string>();
  const key = (s: ReferenceSnapshot) => canonicalJson([options.generation?.() ?? 'local', s]);
  return {
    domain: 'analysis',
    async prepare(snapshot) {
      options.check?.(snapshot);
      const before = key(snapshot);
      await workerRequest(
        options.worker ?? browserAnalysisWorker,
        snapshot.content as AnalysisDocument,
        'verify-reference',
        null,
        new AbortController().signal,
        'verify',
      );
      options.check?.(snapshot);
      if (before !== key(snapshot))
        throw new ReferenceError('stale', '参照の検証中にアクセスscopeが変わりました。');
      if (snapshot.dependencies.length)
        throw new ReferenceError('unsupported', 'Analysisの参照はdomain内の入力閉包を使用します。');
      // Worker output is not used as a replacement for immutable source bytes.
      ready.add(before);
      if (ready.size > 64) ready.delete(ready.values().next().value!);
    },
    validate(snapshot) {
      options.check?.(snapshot);
      if (!ready.has(key(snapshot)))
        throw new ReferenceError('unsupported', 'Analysis reference preflightが必要です。');
    },
    project(snapshot, target) {
      options.check?.(snapshot);
      if (!ready.has(key(snapshot)))
        throw new ReferenceError('unsupported', 'Analysis reference preflightが必要です。');
      const document = snapshot.content as AnalysisDocument;
      const [runId, outputId] = JSON.parse(target.viewId) as [string | null, string];
      const run =
          runId === null
            ? [...document.runs]
                .reverse()
                .find((r) => r.results[outputId] && isCurrentRun(document, r))
            : document.runs.find((r) => r.id === runId),
        table = run?.results[outputId];
      if (!run || !table || !['table', 'chart'].includes(target.kind) || target.nodeIds)
        throw new ReferenceError('missing-target', '保存結果がありません。');
      const fields = target.columnIds
        ? target.columnIds.map(
            (id) =>
              table.fields.find((f) => f.id === id) ??
              (() => {
                throw new ReferenceError('missing-target', '結果列がありません。');
              })(),
          )
        : table.fields;
      if (target.rowIds?.some((id) => !table.rows.some((r) => r.id === id)))
        throw new ReferenceError('missing-target', '結果行がありません。');
      const rows = table.rows.filter((r) => !target.rowIds || target.rowIds.includes(r.id));
      const historical = !isCurrentRun(document, run);
      return svgReferenceProjection(
        resultSvg({ ...table, fields, rows }, target.kind === 'chart'),
        document.title + (historical ? ' · 過去の条件の結果' : ' · 検証済み結果'),
      );
    },
  };
}
export { verifyAnalysis };
