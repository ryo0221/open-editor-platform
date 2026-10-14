import { canonicalJson, clone, newId } from '@editor-platform/artifact-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { command } from '@editor-platform/editor-core';
import {
  type StructuredData,
  type Cell,
  type Column,
  makeRow,
  cellValue,
  displayCell,
} from '@editor-platform/structured-data/model';
import { assertDataIntegrity, guardDataCommand } from '@editor-platform/structured-data/session';
import { setCells, deleteRows, insertRows } from '@editor-platform/structured-data/views';
import {
  createGraph,
  type GraphAdapter,
  type GraphProfile,
  type GraphDocument,
  type GraphIntent,
  type AttributeSchema,
  type GraphDiagnostic,
  validGraphId,
} from '@editor-platform/structured-graph/model';
/** Stable across retargeting, sorting and field renames; length prefixes avoid collisions. */
const digest = (value: unknown) => bytesToHex(sha256(canonicalJson(value)));
export const dataEdgeId = (rowId: string, columnId: string) => {
  const id = `edge:${rowId.length}:${rowId}${columnId.length}:${columnId}`;
  return id.length <= 512 ? id : `edge-hash:${digest([rowId, columnId])}`;
};
/** Disjoint graph/node/edge namespaces preserve arbitrary source IDs without collisions. */
export const dataNodeId = (rowId: string) =>
  rowId.length <= 507 ? `node:${rowId}` : `node-hash:${digest(rowId)}`;
/** Long identifiers are resolved against the canonical source, never array order. */
export function dataRowId(nodeId: string, data?: StructuredData) {
  if (nodeId.startsWith('node:')) return nodeId.slice(5);
  const matches = data?.rows.filter((r) => dataNodeId(r.id) === nodeId) ?? [];
  if (matches.length !== 1) throw new Error('Invalid or ambiguous projected Data record ID');
  return matches[0].id;
}
/** Retain ordinary field IDs; reserve both encoding namespaces to avoid source collisions. */
export function dataFieldId(columnId: string) {
  if (
    validGraphId(columnId) &&
    !columnId.startsWith('field:') &&
    !columnId.startsWith('field-hash:')
  )
    return columnId;
  return columnId.length <= 506 ? `field:${columnId}` : `field-hash:${digest(columnId)}`;
}
/** Resolve against canonical columns, including hashed IDs, without changing original IDs. */
export function dataColumnId(fieldId: string, data: StructuredData) {
  const matches = data.columns.filter((c) => dataFieldId(c.id) === fieldId);
  if (matches.length !== 1) throw new Error('Unknown or ambiguous projected Data field ID');
  return matches[0].id;
}
const relationValue = (value: Cell | undefined) =>
  value === null || value === undefined || value === '' ? null : dataNodeId(String(value));
function field(column: Column, data: StructuredData): AttributeSchema {
  const readOnly = column.readOnly || column.type === 'formula';
  return {
    ...(column.type === 'number' || column.type === 'formula'
      ? { type: 'number' as const }
      : column.type === 'boolean'
        ? { type: 'boolean' as const }
        : column.type === 'select'
          ? {
              type: 'enum' as const,
              enum: column.options?.length ? [...new Set(column.options)] : [''],
            }
          : column.type === 'relation'
            ? {
                type: 'enum' as const,
                enum: data.rows.some((r) => r.id !== '')
                  ? data.rows.filter((r) => r.id !== '').map((r) => dataNodeId(r.id))
                  : [''],
              }
            : { type: 'string' as const }),
    ...(column.required ? { required: true } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  };
}
export function dataGraphProfile(data: StructuredData): GraphProfile {
  return {
    schemaVersion: 1,
    id: 'structured-data',
    version: 1,
    graph: { schema: {}, readOnly: false, ui: { label: 'Dataset' } },
    nodes: {
      record: {
        schema: Object.fromEntries(data.columns.map((c) => [dataFieldId(c.id), field(c, data)])),
        ui: {
          label: 'Record',
          labelField: data.columns.length
            ? dataFieldId(data.graphView?.labelColumnId ?? data.columns[0].id)
            : '',
          order: data.columns.map((c) => dataFieldId(c.id)),
          fields: Object.fromEntries(
            data.columns.map((c) => [
              dataFieldId(c.id),
              {
                label: c.name,
                ...(c.type === 'relation'
                  ? {
                      options: data.rows
                        .filter((row) => row.id !== '')
                        .map((row) => ({
                          value: dataNodeId(row.id),
                          label: data.columns.length
                            ? displayCell(
                                data,
                                row,
                                data.columns.find(
                                  (column) => column.id === data.graphView?.labelColumnId,
                                ) ?? data.columns[0],
                              ) || row.id
                            : row.id,
                        })),
                    }
                  : {}),
              },
            ]),
          ),
        },
      },
    },
    edges: Object.fromEntries(
      data.columns
        .filter((c) => c.type === 'relation')
        .map((c) => [
          dataFieldId(c.id),
          {
            schema: {},
            readOnly: !!c.readOnly,
            ui: { label: c.name },
            connection: {
              from: ['record'],
              to: ['record'],
              allowSelf: true,
              allowCycles: true,
              allowParallel: false,
              maxOutgoing: 1,
            },
          },
        ]),
    ),
  };
}
export function projectDataGraph(data: StructuredData): GraphDocument {
  assertDataIntegrity(data);
  const graph = createGraph({ id: 'structured-data', version: 1 }, 'data-graph');
  graph.nodes = data.rows.map((r) => ({
    id: dataNodeId(r.id),
    type: 'record',
    attributes: Object.fromEntries(
      data.columns.map((c) => {
        let value: Cell = null;
        try {
          value = cellValue(data, r, c);
        } catch {
          /* Formula diagnostic belongs to Data; preserve its source expression. */
        }
        return [dataFieldId(c.id), c.type === 'relation' ? relationValue(value) : value];
      }),
    ),
  }));
  graph.edges = data.rows.flatMap((r) =>
    data.columns
      .filter(
        (c) =>
          c.type === 'relation' &&
          r.values[c.id] !== null &&
          r.values[c.id] !== undefined &&
          r.values[c.id] !== '',
      )
      .map((c) => ({
        id: dataEdgeId(r.id, c.id),
        type: dataFieldId(c.id),
        from: dataNodeId(r.id),
        to: dataNodeId(String(r.values[c.id])),
        attributes: {},
      })),
  );
  graph.layout = Object.fromEntries(
    data.rows.map((r, i) => [
      dataNodeId(r.id),
      clone(
        (data.graphView && Object.hasOwn(data.graphView.positions, r.id)
          ? data.graphView.positions[r.id]
          : undefined) ?? {
          x: 40 + (i % 3) * 260,
          y: 40 + Math.floor(i / 3) * 160,
        },
      ),
    ]),
  );
  return graph;
}
function cell(value: unknown): Cell {
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
    throw new Error('Data supports scalar attributes and single relation IDs only');
  return value as Cell;
}
export function prepareDataGraph(data: StructuredData, intents: GraphIntent[]) {
  const fingerprint = canonicalJson(data),
    fixed = clone(intents);
  return guardDataCommand(
    command<StructuredData>('data.graph-edit', 'Edit Data graph', (current) => {
      if (canonicalJson(current) !== fingerprint) throw new Error('Stale Data graph projection');
      let next = clone(current);
      for (const intent of fixed) {
        switch (intent.type) {
          case 'set-attribute':
          case 'remove-attribute': {
            if (intent.scope !== 'node' || intent.path.length !== 1)
              throw new Error('Data graph only edits scalar record fields');
            const columnId = dataColumnId(intent.path[0], next);
            next = setCells([
              {
                rowId: dataRowId(intent.id, next),
                columnId,
                value:
                  intent.type === 'set-attribute'
                    ? next.columns.find((c) => c.id === columnId)?.type === 'relation'
                      ? intent.value === null
                        ? null
                        : dataRowId(String(intent.value), next)
                      : cell(intent.value)
                    : null,
              },
            ]).apply(next);
            break;
          }
          case 'add-edge': {
            const e = intent.edge,
              c = next.columns.find((c) => dataFieldId(c.id) === e.type && c.type === 'relation'),
              r = next.rows.find((r) => r.id === dataRowId(e.from, next));
            if (
              !c ||
              !r ||
              e.id !== dataEdgeId(r.id, c.id) ||
              Object.keys(e.attributes).length ||
              (r.values[c.id] !== null && r.values[c.id] !== undefined && r.values[c.id] !== '')
            )
              throw new Error('A relation uses one empty source cell and its stable edge ID');
            const target = dataRowId(e.to, next);
            if (target === '') throw new Error('An empty record ID cannot be a relation target');
            next = setCells([{ rowId: r.id, columnId: c.id, value: target }]).apply(next);
            break;
          }
          case 'delete-edge':
          case 'reconnect-edge': {
            const edge = projectDataGraph(next).edges.find((e) => e.id === intent.id);
            if (!edge) throw new Error('Relation is missing');
            if (intent.type === 'reconnect-edge' && dataRowId(intent.to, next) === '')
              throw new Error('An empty record ID cannot be a relation target');
            if (intent.type === 'reconnect-edge' && intent.from !== edge.from) {
              const rowId = dataRowId(intent.from, next),
                columnId = dataColumnId(edge.type, next);
              const row = next.rows.find((row) => row.id === rowId);
              if (
                !row ||
                (row.values[columnId] !== null &&
                  row.values[columnId] !== undefined &&
                  row.values[columnId] !== '')
              )
                throw new Error(
                  '移動先のレコードには既にこの関係があります。関係を解除してから接続してください。',
                );
              next = setCells([
                { rowId: dataRowId(edge.from, next), columnId, value: null },
                { rowId, columnId, value: dataRowId(intent.to, next) },
              ]).apply(next);
              break;
            }
            next = setCells([
              {
                rowId: dataRowId(edge.from, next),
                columnId: dataColumnId(edge.type, next),
                value: intent.type === 'delete-edge' ? null : dataRowId(intent.to, next),
              },
            ]).apply(next);
            break;
          }
          case 'delete-node': {
            const incoming = projectDataGraph(next).edges.some(
              (e) => e.from === intent.id || e.to === intent.id,
            );
            if (incoming && !intent.cascade)
              throw new Error('Confirm related cell updates before deleting this record');
            if (!next.rows.some((r) => r.id === dataRowId(intent.id, next)))
              throw new Error('Record is missing');
            next = deleteRows([dataRowId(intent.id, next)]).apply(next);
            break;
          }
          case 'move-node': {
            if (!next.rows.some((r) => r.id === dataRowId(intent.id, next)))
              throw new Error('Record is missing');
            next = {
              ...next,
              graphView: {
                schemaVersion: 1,
                labelColumnId: next.graphView?.labelColumnId ?? next.columns[0]?.id ?? null,
                positions: {
                  ...next.graphView?.positions,
                  [dataRowId(intent.id, next)]: clone(intent.position),
                },
              },
            };
            break;
          }
          case 'add-node': {
            if (intent.node.type !== 'record') throw new Error('Data only represents record nodes');
            const row = makeRow(next, dataRowId(intent.node.id, next));
            for (const [key, v] of Object.entries(intent.node.attributes)) {
              const columnId = dataColumnId(key, next),
                c = next.columns.find((c) => c.id === columnId);
              if (!c || c.readOnly || c.type === 'formula')
                throw new Error('Unknown or read-only record field');
              row.values[columnId] =
                c.type === 'relation' ? (v === null ? null : dataRowId(String(v), next)) : cell(v);
            }
            next = insertRows([row]).apply(next);
            next = {
              ...next,
              graphView: {
                schemaVersion: 1,
                labelColumnId: next.graphView?.labelColumnId ?? next.columns[0]?.id ?? null,
                positions: { ...next.graphView?.positions, [row.id]: clone(intent.position) },
              },
            };
            break;
          }
        }
      }
      return next;
    }),
  );
}
export const dataGraphAdapter: GraphAdapter<StructuredData> = {
  id: 'structured-data-single-relation',
  version: 1,
  layoutMode: 'source',
  profile: dataGraphProfile,
  project: projectDataGraph,
  prepare: prepareDataGraph,
  diagnostics(data): GraphDiagnostic[] {
    const result: GraphDiagnostic[] = [];
    for (const row of data.rows)
      for (const column of data.columns.filter((c) => c.type === 'formula'))
        try {
          cellValue(data, row, column);
        } catch (error) {
          result.push({
            scope: 'node',
            elementId: dataNodeId(row.id),
            path: [dataFieldId(column.id)],
            code: 'formula',
            message: String(error),
            severity: 'error',
            blocking: false,
          });
        }
    return result;
  },
};
export function createDataGraphFixture(): StructuredData {
  return {
    schemaVersion: 2,
    columns: [
      { id: 'name', name: 'Name', type: 'text', required: true, defaultValue: 'New record' },
      {
        id: 'category',
        name: 'Category',
        type: 'select',
        options: ['Topic', 'Resource'],
        defaultValue: 'Topic',
      },
      { id: 'related', name: 'Related', type: 'relation' },
      { id: 'active', name: 'Active', type: 'boolean', defaultValue: false },
      { id: 'private-note', name: 'Note', type: 'text' },
    ],
    rows: [
      {
        id: 'research',
        values: {
          name: 'Research',
          category: 'Resource',
          related: 'planning',
          active: true,
          'private-note': 'Unshown value retained',
        },
      },
      {
        id: 'planning',
        values: { name: 'Planning', category: 'Topic', related: null, active: false },
      },
      {
        id: 'delivery',
        values: { name: 'Delivery', category: 'Topic', related: null, active: false },
      },
    ],
  };
}
export const newDataGraphNodeId = () => newId('row');

/** Use Data defaults without inventing an implicit relationship on creation. */
export function createDataGraphNode(data: StructuredData, id: string) {
  const row = makeRow(data, id);
  return {
    id: dataNodeId(id),
    type: 'record',
    attributes: Object.fromEntries(
      data.columns
        .filter((c) => c.type !== 'formula' && !c.readOnly)
        .map((c) => [
          dataFieldId(c.id),
          c.type === 'relation' ? relationValue(row.values[c.id]) : (row.values[c.id] ?? null),
        ]),
    ),
  };
}
