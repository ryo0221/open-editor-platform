import { describe, it, expect } from 'vitest';
import {
  Authority,
  initial,
  type DomainCodec,
  type Principal,
} from '@editor-platform/collaboration-core';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  createDesign,
  makeDesignElement,
  createComponent,
  insertInstance,
  updateComponentPart,
  overrideInstance,
  reparentElement,
  patchDesign,
} from '@editor-platform/design/model';
import {
  createWhiteboard,
  makeWhiteboardNode,
  connectNodes,
  pasteBoard,
  copyBoard,
  deleteNodes,
} from '@editor-platform/whiteboard/model';
import { createSection, transformBoardCommand, dissolveSection } from '@editor-platform/whiteboard';
import {
  createData,
  makeRow,
  addColumn,
  removeColumn,
  cellValue,
} from '@editor-platform/structured-data/model';
import {
  defaultView,
  saveView,
  pasteCells,
  updateColumn,
  reorderRow,
  reorderColumn,
} from '@editor-platform/structured-data';
import {
  designEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
  prepareEditorCommand,
} from './editor-transactions';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
function harness<T>(codec: DomainCodec<T>, content: T) {
  const authority = new Authority(codec, initial('domain', codec, content));
  return {
    authority,
    execute(cmd: EditorCommand<T>) {
      const before = authority.snapshot().content;
      const op = prepareEditorCommand(codec, authority.snapshot(), A, cmd)!;
      expect(op, cmd.type).toBeDefined();
      const receipt = authority.commit(A, op);
      expect(receipt, `${cmd.type}: ${JSON.stringify(receipt)}`).toMatchObject({
        status: 'accepted',
      });
      const after = authority.snapshot().content;
      expect(codec.validate(after)).toBe(true);
      const undo = authority.undo(A, op.operationId);
      expect(undo, `${cmd.type} Undo: ${JSON.stringify(undo)}`).toMatchObject({
        status: 'accepted',
      });
      expect(authority.snapshot().content).toEqual(before);
      expect(authority.undo(A, undo.operationId, true)).toMatchObject({ status: 'accepted' });
      expect(authority.snapshot().content).toEqual(after);
      return after;
    },
  };
}
describe('mandatory domain operations through normal editor preparation and selective history', () => {
  it('Whiteboard Sections, membership, movement, connectors, paste and delete are atomic', () => {
    const a = {
        ...makeWhiteboardNode('sticky'),
        bounds: { x: 10, y: 10, width: 100, height: 100 },
      },
      b = { ...makeWhiteboardNode('sticky'), bounds: { x: 200, y: 10, width: 100, height: 100 } };
    const h = harness(whiteboardEditorCodec, { ...createWhiteboard(), nodes: [a, b] });
    let d = h.execute(
      createSection({ x: 0, y: 0, width: 400, height: 200 }, 'Research', [a.id, b.id]),
    );
    d = h.execute(connectNodes(a.id, b.id));
    const connector = d.connectors[0].id;
    d = h.execute(transformBoardCommand([d.sections![0].id], { dx: 200, dy: 100, dw: 0, dh: 0 }));
    expect(d.nodes[0].bounds.x).toBe(210);
    expect(d.connectors[0].id).toBe(connector);
    d = h.execute(pasteBoard(copyBoard(d, [a.id, b.id])));
    expect(new Set(d.nodes.map((n) => n.id)).size).toBe(4);
    h.execute(deleteNodes([a.id]));
    h.execute(dissolveSection(d.sections![0].id));
  });
  it('Design Frames, layout, component definitions and overrides preserve references', () => {
    const frame = makeDesignElement('frame'),
      a = makeDesignElement('shape'),
      b = makeDesignElement('text');
    const h = harness(designEditorCodec, { ...createDesign(), elements: [frame, a, b] });
    h.execute(reparentElement(a.id, frame.id));
    h.execute(reparentElement(b.id, frame.id));
    let d = h.execute(
      patchDesign([frame.id], {
        layout: { direction: 'row', gap: 12, padding: 20, align: 'start', sizing: 'fixed' },
      }),
    );
    expect(d.elements[1].bounds.x).toBe(frame.bounds.x + 20);
    d = h.execute(createComponent([frame.id]));
    const component = d.components[0],
      part = component.elements!.find((e) => e.type === 'text')!;
    d = h.execute(insertInstance(component.id));
    const instance = d.elements.at(-1)!;
    h.execute(updateComponentPart(component.id, part.id, { fill: '#334455' }));
    d = h.execute(overrideInstance(instance.id, part.id, { fill: '#778899' }));
    expect(d.elements.find((e) => e.id === instance.id)!.overrides?.[part.id]?.fill).toBe(
      '#778899',
    );
  });
  it('Data paste, schema, named view and order retain cells/formulas and atomic Undo', () => {
    const data = createData();
    data.rows = [makeRow(data), makeRow(data)];
    const h = harness(dataEditorCodec, data),
      ids = data.rows.map((r) => r.id),
      columns = data.columns.map((c) => c.id);
    let d = h.execute(pasteCells(data, ids, columns, 0, 2, '20\t4\n30\t5', false));
    expect(cellValue(d, d.rows[0], d.columns[4])).toBe(80);
    d = h.execute(addColumn({ id: 'extra', name: 'Extra', type: 'text' }));
    d = h.execute(updateColumn('extra', { name: 'Detail', required: false }));
    d = h.execute(saveView({ ...defaultView(d), name: 'Team view' }));
    expect(d.views?.[0].name).toBe('Team view');
    h.execute(reorderRow(ids[1], ids[0]));
    h.execute(reorderColumn('extra', columns[0]));
    h.execute(removeColumn('extra'));
  });
});
