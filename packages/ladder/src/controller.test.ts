import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  ladderBlinkExample,
  ladderSelfHoldExample,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import { LadderController } from './controller';
import { ladderLayout } from './layout';

function setup(doc: LadderDocument, canEdit = () => true) {
  const session = new EditorSession<LadderDocument>(doc);
  let tick: (() => void) | undefined;
  const saved: LadderDocument[] = [];
  const controller = new LadderController({
    session,
    canEdit,
    onApplied: (c) => saved.push(c),
    every: (_ms, run) => {
      tick = run;
      return () => (tick = undefined);
    },
  });
  return { session, controller, saved, tick: () => tick?.() };
}

// TS-2113: the ladder Surface's controller and rung layout (no DOM).
describe('ladder Surface controller (TS-2113)', () => {
  it('lays a rung out on the grid with the source of every wire', () => {
    const rung = ladderSelfHoldExample().rungs[0];
    const l = ladderLayout(rung);
    expect(l.cells.map((c) => `${c.id}@${c.col},${c.row}`)).toEqual([
      'n3@0,0',
      'n4@0,1',
      'n5@1,0',
      'c1@4,0',
    ]);
    expect(l.rows).toBe(2);
    // The parallel's left bar is fed by the rail, its right bar by the parallel itself, and the
    // wire to the coil by the whole network.
    expect(l.wires).toEqual([
      { x1: 0, y1: 0.5, x2: 0, y2: 1.5, source: '' },
      { x1: 1, y1: 0.5, x2: 1, y2: 1.5, source: 'n2' },
      { x1: 2, y1: 0.5, x2: 4, y2: 0.5, source: 'n1' },
    ]);
    // An empty rung is a rail straight to its coil.
    const empty = ladderLayout({ ...rung, network: { id: 'e', kind: 'series', items: [] } });
    expect(empty.wires).toEqual([{ x1: 0, y1: 0.5, x2: 4, y2: 0.5, source: 'e' }]);
  });

  it('edits through the session, one command per edit, with the variables an element needs', () => {
    const { session, controller, saved } = setup(ladderSelfHoldExample());
    expect(controller.addRung()).toBeUndefined();
    const r2 = controller.state.selection!;
    // A new coil drives a fresh output, since LAMP is already driven.
    const rung = () => controller.state.content.rungs.find((r) => r.id === r2)!;
    expect(rung().coils[0].variable).toBe('Y1');
    expect(controller.addElement('no')).toBeUndefined();
    const contact = controller.state.selection!;
    expect(controller.addElement('timer')).toBeUndefined();
    expect(controller.state.content.variables.map((v) => v.name)).toContain('T1');
    expect(controller.addElement('rising', 'branch')).toBeUndefined();
    expect(rung().network).toMatchObject({
      kind: 'series',
      items: [
        { id: contact },
        { kind: 'parallel', branches: [{ kind: 'timer' }, { kind: 'contact' }] },
      ],
    });
    // Move the contact into the first rung, after STOP: both rungs change in one edit.
    const before = saved.length;
    expect(controller.moveElement(contact, 'n5', 'after')).toBeUndefined();
    expect(saved.length).toBe(before + 1);
    expect(JSON.stringify(controller.state.content.rungs[0].network)).toContain(contact);
    // Undo restores both rungs.
    session.undo();
    controller.sync();
    expect(JSON.stringify(rung().network)).toContain(contact);
    // Renaming a variable renames its uses; deleting one in use is refused and nothing changes.
    expect(
      controller.updateVariable('LAMP', { name: 'LIGHT', type: 'BOOL', role: 'output' }),
    ).toBeUndefined();
    expect(JSON.stringify(controller.state.content.rungs[0])).toContain('LIGHT');
    const key = controller.state.key;
    expect(controller.deleteVariable('STOP')).toBe('variable-missing');
    expect(controller.state.key).toBe(key);
    expect(controller.updateVariable('STOP', { name: '1x', type: 'BOOL', role: 'input' })).toBe(
      'name-invalid',
    );
    // Deleting the selected element, then a rung's only coil is refused (a rung needs a coil).
    controller.select(contact);
    expect(controller.deleteSelection()).toBeUndefined();
    controller.select(rung().coils[0].id);
    expect(controller.deleteSelection()).toBe('rung-no-coil');
    controller.select(r2);
    expect(controller.moveRung(r2, -1)).toBeUndefined();
    expect(controller.state.content.rungs[0].id).toBe(r2);
    expect(controller.deleteSelection()).toBeUndefined();
    expect(controller.state.content.rungs).toHaveLength(1);
  });

  it('runs scans from the clock, holds inputs and forcing, and refuses edits while running', () => {
    const { controller, tick } = setup(ladderSelfHoldExample());
    controller.setInput('START', true);
    controller.step();
    expect(controller.state.run.state.values.LAMP).toBe(true);
    expect(controller.state.run.power.c1).toBe(true);
    controller.setInput('START', false);
    controller.start();
    expect(controller.addRung()).toBe('running');
    tick();
    tick();
    expect(controller.state.run.state.scans).toBe(3);
    expect(controller.state.run.state.values.LAMP).toBe(true);
    // Forcing STOP on drops the lamp; releasing it keeps it off (the hold is broken).
    controller.force('STOP', true);
    tick();
    expect(controller.state.run.state.values.LAMP).toBe(false);
    controller.force('STOP', undefined);
    tick();
    expect(controller.state.run.state.values.LAMP).toBe(false);
    expect(controller.state.run.state.timeMs).toBe(50);
    controller.stop();
    tick();
    expect(controller.state.run.state.scans).toBe(5);
    controller.reset();
    expect(controller.state.run.state.scans).toBe(0);
    expect(controller.addRung()).toBeUndefined();
  });

  it('refuses input and forced values that do not fit the variable', () => {
    const doc: LadderDocument = {
      ...ladderSelfHoldExample(),
      variables: [
        ...ladderSelfHoldExample().variables,
        { name: 'LEVEL', type: 'INT', role: 'input' },
        { name: 'DELAY', type: 'TIME', role: 'input' },
      ],
    };
    const { controller } = setup(doc);
    expect(controller.setInput('LEVEL', 40000)).toBe('input-value');
    expect(controller.setInput('LEVEL', 1.5)).toBe('input-value');
    expect(controller.setInput('LEVEL', Infinity)).toBe('input-value');
    expect(controller.setInput('DELAY', -1)).toBe('input-value');
    expect(controller.setInput('LAMP', true)).toBe('input-value');
    expect(controller.setInput('START', 1)).toBe('input-value');
    expect(controller.force('LAMP', 3)).toBe('input-value');
    // A force set and released by another spelling of the name.
    expect(controller.force('stop', true)).toBeUndefined();
    expect({ ...controller.state.run.forced }).toEqual({ STOP: true });
    expect(controller.force('Stop', undefined)).toBeUndefined();
    expect({ ...controller.state.run.forced }).toEqual({});
    expect(controller.state.run.inputs).toEqual({});
    expect(controller.setInput('level', -32768)).toBeUndefined();
    expect(controller.setInput('DELAY', 2 ** 31 - 1)).toBeUndefined();
    expect({ ...controller.state.run.inputs }).toEqual({ LEVEL: -32768, DELAY: 2 ** 31 - 1 });
    controller.step();
    expect(controller.state.run.state.values.LEVEL).toBe(-32768);
  });

  it('times a blink with virtual time and refuses edits without authority', () => {
    const { controller } = setup(ladderBlinkExample(), () => false);
    expect(controller.state.readOnly).toBe(true);
    // Running needs no edit authority.
    controller.setInput('ENABLE', true);
    let changes = 0;
    let last = false;
    for (let i = 0; i < 200; i++) {
      controller.step();
      const lamp = controller.state.run.state.values.LAMP === true;
      if (lamp !== last) changes++;
      last = lamp;
    }
    expect(changes).toBeGreaterThanOrEqual(3);
    expect(controller.addRung()).toBe('permission-denied');
  });
});
