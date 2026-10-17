import {
  ReferenceError,
  svgReferenceProjection,
  type ReferenceAdapter,
  type ReferenceSnapshot,
  type ReferenceTarget,
} from '@editor-platform/artifact-references';
import { drawingSvg, escapeXml, unionBounds, type Bounds } from '@editor-platform/editor-core';
import {
  isStructuredData,
  validateData,
  displayCell,
  type StructuredData,
} from '@editor-platform/structured-data/model';
import { defaultView, viewRows } from '@editor-platform/structured-data/views';
import { chartSvg } from '@editor-platform/structured-data/charts';
import {
  isGraphDocument,
  isGraphProfile,
  validateGraph,
  graphElementLabel,
  routeGraphEdge,
  type GraphDocument,
  type GraphProfile,
} from '@editor-platform/structured-graph/model';

function missing(message: string): never {
  throw new ReferenceError('missing-target', message);
}
export const dataReferenceAdapter: ReferenceAdapter = {
  domain: 'data',
  validate(snapshot) {
    if (
      !isStructuredData(snapshot.content) ||
      validateData(snapshot.content).length ||
      snapshot.dependencies.length
    )
      throw new ReferenceError('error', 'Dataの保存版が不正です。');
    const views = snapshot.content.views ?? [];
    if (
      views.some((view) => view.id === 'default') ||
      new Set(views.map((view) => view.id)).size !== views.length
    )
      throw new ReferenceError(
        'error',
        'Dataの参照元ではview IDの重複と予約ID defaultを使用できません。',
      );
  },
  project(snapshot, target) {
    const data = snapshot.content as StructuredData;
    if (!['table', 'chart'].includes(target.kind) || target.nodeIds)
      throw new ReferenceError('unsupported', 'Dataは表／グラフの参照に対応しています。');
    const view =
      target.viewId === 'default'
        ? defaultView(data)
        : data.views?.find((v) => v.id === target.viewId);
    if (!view) missing('保存されたviewが削除されました。');
    const required = [
      ...view.filters.map((f) => f.columnId),
      ...view.sorts.map((s) => s.columnId),
      view.groupBy,
      ...(target.columnIds ?? []),
      ...(target.kind === 'chart' ? [view.chart.x, view.chart.y, view.chart.series ?? ''] : []),
    ].filter(Boolean);
    if (required.some((id) => !data.columns.some((c) => c.id === id)))
      missing('参照する列が削除されました。');
    if (target.rowIds?.some((id) => !data.rows.some((r) => r.id === id)))
      missing('参照するrecordが削除されました。');
    const rows = viewRows(data, view).filter((r) => !target.rowIds || target.rowIds.includes(r.id));
    if (rows.length > 100)
      throw new ReferenceError(
        'error',
        '参照表示は100 recordsまでです。表示範囲を絞ってください。',
      );
    if (target.kind === 'chart')
      return svgReferenceProjection(
        chartSvg(data, rows, view.chart, 900, 430, view.accent),
        view.name + ' · Chart',
      );
    const columns = target.columnIds
      ? target.columnIds.map((id) => data.columns.find((c) => c.id === id)!)
      : data.columns.filter((c) => !view.hidden.includes(c.id));
    if (!columns.length) missing('表示する列がありません。');
    if (columns.length > 30) throw new ReferenceError('error', '表の参照表示は30列までです。');
    const width = Math.max(400, columns.length * 160),
      height = Math.max(64, (rows.length + 1) * 40);
    return svgReferenceProjection(
      drawingSvg(
        [
          {
            id: 'reference-table',
            kind: 'table',
            bounds: { x: 0, y: 0, width, height },
            text: '',
            fill: '#253044',
            table: {
              header: true,
              rows: [
                columns.map((c) => c.name),
                ...rows.map((r) => columns.map((c) => displayCell(data, r, c))),
              ],
            },
          },
        ],
        { x: 0, y: 0, width, height },
        '#fff',
      ),
      view.name + ' · Table',
    );
  },
};
function graphSource(snapshot: ReferenceSnapshot): { graph: GraphDocument; profile: GraphProfile } {
  const graph = snapshot.content;
  if (!isGraphDocument(graph)) throw new ReferenceError('error', 'Graphの保存版が不正です。');
  if (snapshot.dependencies.length !== 1)
    throw new ReferenceError('error', 'Graphの依存は保存版のProfile一件に限定してください。');
  const profile = snapshot.dependencies.find(
    (d) => d.id === `profile:${graph.profile.id}:${graph.profile.version}`,
  )?.content;
  if (
    !isGraphProfile(profile) ||
    profile.id !== graph.profile.id ||
    profile.version !== graph.profile.version ||
    validateGraph(graph, profile).some((d) => d.blocking)
  )
    throw new ReferenceError('error', 'Graph Profileが欠落、または保存版と一致しません。');
  return { graph, profile };
}
export const graphReferenceAdapter: ReferenceAdapter = {
  domain: 'structured-graph',
  validate(snapshot) {
    graphSource(snapshot);
  },
  project(snapshot, target: ReferenceTarget) {
    const { graph, profile } = graphSource(snapshot);
    if (target.kind !== 'graph' || target.viewId !== graph.id || target.columnIds || target.rowIds)
      missing('参照するGraph viewがありません。');
    if (target.nodeIds?.some((id) => !graph.nodes.some((n) => n.id === id)))
      missing('参照するnodeが削除されました。');
    const nodes = graph.nodes.filter((n) => !target.nodeIds || target.nodeIds.includes(n.id));
    const boxes = new Map(
      nodes.map((n, i) => [
        n.id,
        {
          ...(graph.layout[n.id] ?? { x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 160 }),
          width: 200,
          height: 70,
        },
      ]),
    );
    const edges = graph.edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
    if (nodes.length > 100 || edges.length > 300)
      throw new ReferenceError('error', 'Graph参照は100 nodes／300 edgesまでです。');
    const e = escapeXml,
      allBounds: Bounds[] = [...boxes.values()];
    let body =
      '<defs><marker id="reference-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#697386"/></marker></defs>';
    for (const edge of edges) {
      const route = routeGraphEdge(
        boxes.get(edge.from)!,
        boxes.get(edge.to)!,
        [...boxes.values()],
        edge.from === edge.to,
      );
      if (!route.path)
        throw new ReferenceError(
          'error',
          'Graph edgeの経路を描画できません。元の配置を確認してください。',
        );
      const ui = profile.edges[edge.type]?.ui,
        label = String(edge.attributes[ui?.labelField ?? 'label'] ?? ui?.label ?? edge.type);
      allBounds.push(...route.points.map((p) => ({ ...p, width: 1, height: 1 })), {
        x: route.label.x - 160,
        y: route.label.y - 20,
        width: 320,
        height: 30,
      });
      body += `<path d="${e(route.path)}" fill="none" stroke="#697386" stroke-width="2" marker-end="url(#reference-arrow)"/><text x="${route.label.x}" y="${route.label.y - 8}" text-anchor="middle" font-size="14">${e(label)}</text>`;
    }
    for (const node of nodes) {
      const b = boxes.get(node.id)!;
      body += `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="8" fill="#eef2ff" stroke="#5269c8"/><text x="${b.x + 12}" y="${b.y + 39}" font-size="18">${e(graphElementLabel(graph, profile, node.id))}</text>`;
    }
    const bounds = allBounds.length
      ? unionBounds(allBounds)
      : { x: 0, y: 0, width: 400, height: 200 };
    return svgReferenceProjection(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x - 20} ${bounds.y - 20} ${bounds.width + 40} ${bounds.height + 40}" width="${bounds.width + 40}" height="${bounds.height + 40}" role="img" aria-label="${e(String(graph.attributes.title ?? 'Graph'))}"><g font-family="Noto Sans CJK JP, sans-serif" fill="#253044">${body}</g></svg>`,
      String(graph.attributes.title ?? 'Graph'),
    );
  },
};
export const nativeReferenceAdapters = [dataReferenceAdapter, graphReferenceAdapter];
