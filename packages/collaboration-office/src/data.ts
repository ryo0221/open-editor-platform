import { copy, fail, type Action, type DomainCodec } from '@editor-platform/collaboration-core';
import {
  isStructuredData,
  validateData,
  type StructuredData,
  type Cell,
  type Column,
} from '@editor-platform/structured-data/model';
export const dataCodec: DomainCodec<StructuredData> = {
  domain: 'data',
  validate: isStructuredData,
  resource: (d, key) => {
    const [type, id, column] = key.split('/');
    return type === 'cell'
      ? d.rows.find((r) => r.id === id)?.values[column]
      : type === 'column'
        ? d.columns.find((c) => c.id === id)
        : undefined;
  },
  validateAnchor: (d, a) =>
    a.type === 'element' &&
    (d.rows.some((r) => r.id === a.elementId) || d.columns.some((c) => c.id === a.elementId)),
  mapAnchor: (a, _d, op) =>
    a.type === 'element' && op.type === 'data.delete-row' && a.elementId === op.target
      ? { ...a, orphan: true }
      : a,
  apply(d, op) {
    const before = copy(d),
      p = op.payload;
    if (op.type === 'domain.restore') {
      if (!isStructuredData(p.content)) fail('invalid-operation', 'Invalid data restore');
      return {
        content: copy(p.content),
        required: ['*'],
        touched: ['*'],
        targets: ['*'],
        inverse: [{ type: 'domain.restore', target: '*', payload: { content: before } }],
      };
    }
    if (op.type === 'cell.set') {
      const row = d.rows.find((r) => r.id === op.target),
        col = d.columns.find((c) => c.id === p.columnId);
      if (!row || !col) fail('target-deleted', 'Row or column is missing');
      if (col.readOnly || col.type === 'formula') fail('unauthorized', 'Computed/read-only cell');
      if (p.value !== null && !['string', 'number', 'boolean'].includes(typeof p.value))
        fail('invalid-operation', 'Invalid cell value');
      const previous = row.values[col.id] ?? null;
      row.values[col.id] = p.value as Cell;
      const errors = validateData(d, [row]);
      if (errors.length) fail('invalid-operation', errors.map((e) => e.message).join(';'));
      const key = `cell/${row.id}/${col.id}`;
      return {
        content: d,
        required: [key, `column/${col.id}`],
        touched: [key],
        targets: [row.id, col.id],
        inverse: [
          { type: op.type, target: row.id, payload: { columnId: col.id, value: previous } },
        ],
      };
    }
    if (op.type === 'data.column') {
      const col = d.columns.find((c) => c.id === op.target);
      if (!col) fail('target-deleted', 'Column missing');
      if (!['name', 'type', 'formula', 'required'].includes(String(p.field)))
        fail('unsupported-operation', 'Unsupported column field');
      Object.assign(col, { [String(p.field)]: p.value });
      if (!isStructuredData(d) || validateData(d).length)
        fail('invalid-operation', 'Column update invalidates data');
      return {
        content: d,
        required: ['*'],
        touched: ['*', `column/${col.id}`],
        targets: [col.id],
        inverse: [{ type: 'domain.restore', target: '*', payload: { content: before } }],
      };
    }
    if (op.type === 'data.order') {
      if (
        !Array.isArray(p.ids) ||
        p.ids.length !== d.rows.length ||
        new Set(p.ids).size !== d.rows.length ||
        !p.ids.every((id) => d.rows.some((r) => r.id === id))
      )
        fail('invalid-operation', 'Invalid row order');
      d.rows = p.ids.map((id) => d.rows.find((r) => r.id === id)!);
    } else if (op.type === 'data.delete-row') {
      if (!d.rows.some((r) => r.id === op.target)) fail('target-deleted', 'Row missing');
      // Relation values need a domain-specific rewrite; reject deletion while referenced.
      if (
        d.columns.some(
          (c) => c.type === 'relation' && d.rows.some((r) => r.values[c.id] === op.target),
        )
      )
        fail('invalid-operation', 'Row is referenced');
      d.rows = d.rows.filter((r) => r.id !== op.target);
    } else fail('unsupported-operation', `Unsupported shared data operation: ${op.type}`);
    return {
      content: d,
      required: ['*'],
      touched: ['*'],
      targets: op.type === 'data.order' ? before.rows.map((r) => r.id) : [op.target],
      inverse: [{ type: 'domain.restore', target: '*', payload: { content: before } }],
    };
  },
};
export function cell(target: string, columnId: string, value: Cell): Action {
  return { type: 'cell.set', target, payload: { columnId, value } };
}
export type { Column };
