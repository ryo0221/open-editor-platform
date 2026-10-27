import { canonicalJson } from '@editor-platform/artifact-core';
import { drawingSvg, escapeXml } from '@editor-platform/editor-core';
import {
  ReferenceError,
  svgReferenceProjection,
  type ReferenceAdapter,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import {
  verifyEstimate,
  assertEstimate,
  makeEstimateBasis,
  estimateData,
  calculationDifference,
  ENGINE,
  type EstimateDocument,
  type QuantityVerification,
} from '@editor-platform/estimate-core';
import {
  decimal,
  add,
  subtract,
  formatDecimal,
  type SourcePin,
} from '@editor-platform/calculation-core';
const displayDecimal = (value: string) =>
  value.replace(
    /^(-?\d+)(\.\d+)?$/,
    (_, whole: string, fraction = '') => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction,
  );
function tableSvg(rows: string[][]) {
  const width = Math.max(600, rows[0].length * 160),
    height = Math.max(100, rows.length * 40);
  return drawingSvg(
    [
      {
        id: 'estimate-table',
        kind: 'table',
        bounds: { x: 0, y: 0, width, height },
        text: '',
        fill: '#253044',
        table: { header: true, rows },
      },
    ],
    { x: 0, y: 0, width, height },
    '#fff',
  );
}
/** Synchronous validate/project use only this instance's asynchronously verified snapshot keys. */
export function createEstimateReferenceAdapter(
  options: {
    generation?: () => string;
    canRead?: (pin: SourcePin) => boolean;
    verification?: QuantityVerification;
    check?: (snapshot: ReferenceSnapshot) => void;
  } = {},
): ReferenceAdapter {
  const ready = new Set<string>();
  const key = (s: ReferenceSnapshot) => canonicalJson([options.generation?.() ?? 'local', s]);
  const check = (s: ReferenceSnapshot) => {
    assertEstimate(s.content);
    options.check?.(s);
    const doc = s.content as EstimateDocument;
    if (options.canRead && doc.retainedSources.some((source) => !options.canRead!(source.pin)))
      throw new ReferenceError('forbidden', '数量/単価入力への閲覧権限がありません。');
  };
  return {
    domain: 'estimate',
    async prepare(snapshot) {
      // Strict async admission includes every saved calculation; hashes/verified flags do not authorize output.
      assertEstimate(snapshot.content);
      check(snapshot);
      const before = key(snapshot);
      await verifyEstimate(snapshot.content, snapshot.artifactId, false, options.verification);
      check(snapshot);
      if (before !== key(snapshot))
        throw new ReferenceError('stale', '検証中に参照scopeが変わりました。');
      if (snapshot.dependencies.length)
        throw new ReferenceError('unsupported', '見積の入力閉包はdomain内に保持します。');
      ready.add(before);
      if (ready.size > 64) ready.delete(ready.values().next().value!);
    },
    validate(snapshot) {
      check(snapshot);
      if (!ready.has(key(snapshot)))
        throw new ReferenceError('unsupported', 'Estimate reference preflightが必要です。');
    },
    project(snapshot, target) {
      check(snapshot);
      if (!ready.has(key(snapshot)))
        throw new ReferenceError('unsupported', 'Estimate reference preflightが必要です。');
      if (!['table', 'chart'].includes(target.kind) || target.nodeIds)
        throw new ReferenceError('unsupported', '見積参照はtable/chartのみです。');
      let selection: unknown;
      try {
        selection = JSON.parse(target.viewId);
      } catch {
        throw new ReferenceError('missing-target', '計算IDが不正です。');
      }
      if (
        !Array.isArray(selection) ||
        ![2, 3].includes(selection.length) ||
        (selection.length === 3 && (selection[2] !== 'summary' || selection[1] !== null)) ||
        selection.some((v) => v !== null && typeof v !== 'string')
      )
        throw new ReferenceError('missing-target', '計算IDが不正です。');
      const [id, baselineId] = selection as [string | null, string | null],
        doc = snapshot.content as EstimateDocument;
      const calculation =
        id === null
          ? [...doc.calculations].reverse().find((c) => {
              try {
                return (
                  canonicalJson(c.basis) ===
                  canonicalJson(makeEstimateBasis(doc, c.basis.scenarioId))
                );
              } catch {
                // A removed scenario remains available only through its historical ID.
                return false;
              }
            })
          : doc.calculations.find((c) => c.id === id);
      if (!calculation || calculation.basis.engine !== ENGINE)
        throw new ReferenceError('missing-target', '保存済みの検証可能な計算がありません。');
      const numeric = 'cost';
      let rows: { id: string; values: Record<string, string> }[],
        columns: { id: string; name: string }[];
      if (baselineId !== null) {
        const baseline = doc.calculations.find((c) => c.id === baselineId);
        if (!baseline) throw new ReferenceError('missing-target', '比較元の計算がありません。');
        if (canonicalJson(baseline.basis.currency) !== canonicalJson(calculation.basis.currency))
          throw new ReferenceError('unsupported', '異なる通貨の比較はできません。');
        columns = [
          { id: 'name', name: '費目' },
          { id: 'before', name: '以前' },
          { id: 'after', name: '比較先' },
          { id: 'cost', name: '差額' },
        ];
        rows = calculationDifference(baseline, calculation).map((d) => ({
          id: JSON.stringify(['line', d.id]),
          values: {
            name: d.name,
            before: d.before?.cost ?? 'なし',
            after: d.after?.cost ?? 'なし',
            cost: d.delta,
          },
        }));
        for (const id of new Set(
          [...baseline.result.adjustments, ...calculation.result.adjustments].map((a) => a.id),
        )) {
          const before = baseline.result.adjustments.find((a) => a.id === id)?.value ?? '0',
            after = calculation.result.adjustments.find((a) => a.id === id)?.value ?? '0';
          rows.push({
            id: JSON.stringify(['adjustment', id]),
            values: {
              name:
                calculation.basis.adjustments.find((a) => a.id === id)?.name ??
                baseline.basis.adjustments.find((a) => a.id === id)!.name,
              before,
              after,
              cost: formatDecimal(subtract(decimal(after), decimal(before))),
            },
          });
        }
        rows.push({
          id: JSON.stringify(['total']),
          values: {
            name: '見積合計',
            before: baseline.result.total!,
            after: calculation.result.total!,
            cost: formatDecimal(
              subtract(decimal(calculation.result.total!), decimal(baseline.result.total!)),
            ),
          },
        });
      } else {
        const data = estimateData(calculation);
        columns = data.columns.filter((c) => c.id !== 'basis');
        rows = data.rows.map((r) => ({
          id: r.id,
          values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, String(v)])),
        }));
      }
      if ((selection as unknown[])[2] === 'summary') {
        const groups = new Map<string, string>();
        for (const line of calculation.result.lines)
          groups.set(
            line.category,
            formatDecimal(add(decimal(groups.get(line.category) ?? '0'), decimal(line.cost))),
          );
        columns = [
          { id: 'name', name: '区分・調整' },
          { id: 'cost', name: `金額 (${calculation.basis.currency.code})` },
        ];
        rows = [...groups].map(([category, cost]) => ({
          id: JSON.stringify(['category', category]),
          values: { name: category, cost },
        }));
        for (const adjustment of calculation.result.adjustments)
          rows.push({
            id: JSON.stringify(['adjustment', adjustment.id]),
            values: {
              name: calculation.basis.adjustments.find((a) => a.id === adjustment.id)!.name,
              cost: adjustment.value,
            },
          });
        rows.push({
          id: JSON.stringify(['total']),
          values: { name: '見積合計', cost: calculation.result.total! },
        });
      }
      if (
        target.rowIds?.some((id) => !rows.some((r) => r.id === id)) ||
        target.columnIds?.some((id) => !columns.some((c) => c.id === id))
      )
        throw new ReferenceError('missing-target', '参照する行/列がありません。');
      rows = rows.filter((r) => !target.rowIds || target.rowIds.includes(r.id));
      columns = columns.filter((c) => !target.columnIds || target.columnIds.includes(c.id));
      if (rows.length > 100 || !columns.length)
        throw new ReferenceError('unsupported', '見積参照は100行までです。無断で切り捨てません。');
      let svg: string;
      if (target.kind === 'chart') {
        if (!columns.some((c) => c.id === numeric))
          throw new ReferenceError('unsupported', 'Chartには金額列が必要です。');
        const values = rows.map((r) => Number(r.values[numeric])),
          max = Math.max(1, ...values.map(Math.abs));
        svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${Math.max(120, rows.length * 32 + 50)}"><rect width="100%" height="100%" fill="white"/><text x="10" y="22">${escapeXml(calculation.basis.currency.code)} · 棒は近似値、ラベルは正確な値</text>${rows
          .map((r, i) => {
            const w = (Math.abs(values[i]) / max) * 250;
            return `<g><text x="8" y="${58 + i * 32}">${escapeXml(r.values.name)}</text><rect x="${values[i] < 0 ? 500 - w : 500}" y="${40 + i * 32}" width="${w}" height="22" fill="#5364b8"/><text x="770" y="${58 + i * 32}">${escapeXml(displayDecimal(r.values[numeric]))}</text></g>`;
          })
          .join('')}</svg>`;
      } else
        svg = tableSvg([
          columns.map((c) => c.name),
          ...rows.map((r) =>
            columns.map((c) =>
              ['cost', 'quantity', 'price', 'before', 'after'].includes(c.id)
                ? displayDecimal(r.values[c.id])
                : r.values[c.id],
            ),
          ),
        ]);
      let current = false;
      try {
        current =
          canonicalJson(calculation.basis) ===
          canonicalJson(makeEstimateBasis(doc, calculation.basis.scenarioId));
      } catch {
        /* Removed scenario: this remains a verified historical result. */
      }
      return svgReferenceProjection(
        svg,
        `${doc.title} · ${current ? '検証済み' : '過去の条件'} · ${calculation.basis.currency.code} / ${calculation.basis.rounding}`,
      );
    },
  };
}
