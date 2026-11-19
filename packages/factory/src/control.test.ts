import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { f174PlcLine, f175PlcLineBug, type FactoryDocument } from '@editor-platform/factory-core';
import { ladderToPlcopen } from '@editor-platform/ladder-core';
import { readLadderProgram } from './control';
import { FactoryController } from './controller';

// TS-2687: reading a ladder program for the PLC control, and control edits as commands.
describe('factory PLC control on the Surface (TS-2687)', () => {
  const program = f174PlcLine().control!.program;

  it('reads a program from PLCopen XML, ladder JSON or a Playground export', () => {
    // PLCopen gives the elements new IDs and groups the variables by role; they all stay.
    const xml = readLadderProgram(ladderToPlcopen(program));
    const byName = (vs: typeof program.variables) =>
      [...vs].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(xml.variables)).toEqual(byName(program.variables));
    expect(xml.rungs.map((r) => r.comment)).toEqual(program.rungs.map((r) => r.comment));
    expect(readLadderProgram(JSON.stringify(program))).toEqual(program);
    expect(readLadderProgram(JSON.stringify({ name: 'x', content: program }))).toEqual(program);
    // The Playground's "Export JSON" of a ladder artifact (the record with its draft).
    const exported = {
      id: 'a1',
      kind: 'ladder',
      name: 'Transfer',
      draft: { baseVersionId: null, content: program },
      versions: [],
    };
    expect(readLadderProgram(JSON.stringify(exported))).toEqual(program);
    expect(() => readLadderProgram('not json')).toThrow('program-unreadable');
    expect(() => readLadderProgram('{"schemaVersion":1}')).toThrow(/^program-invalid:/);
    const hostile = JSON.parse(JSON.stringify(program));
    hostile.variables[0].name = { toString: null };
    expect(() => readLadderProgram(JSON.stringify(hostile))).toThrow(/^program-invalid:/);
    expect(() => readLadderProgram(JSON.stringify({ ...program, scanMs: 0 }))).toThrow(
      'program-invalid:scan-ms',
    );
  });

  it('replaces the program keeping the wiring, one Undo step, and refuses wiring it lacks', () => {
    const session = new EditorSession<FactoryDocument>(f175PlcLineBug());
    const controller = new FactoryController({ session, canEdit: () => true });
    const control = session.content.control!;
    expect(
      controller.apply({ type: 'setControl', control: { ...control, program } }),
    ).toBeUndefined();
    expect(session.content.control!.program.rungs).toHaveLength(4);
    expect(session.content.control!.sensors).toEqual(control.sensors);
    session.undo();
    expect(session.content.control!.program.rungs).toHaveLength(3);
    // A program without the wired variables is refused as a whole.
    expect(
      controller.apply({
        type: 'setControl',
        control: { ...control, program: { ...program, variables: [], rungs: [] } },
      }),
    ).toBe('variable-missing');
    expect(controller.state.notice).toMatchObject({ code: 'variable-missing' });
    // Read only: refused before anything changes.
    const ro = new FactoryController({ session, canEdit: () => false });
    expect(ro.apply({ type: 'setControl', control: null })).toBe('permission-denied');
    expect(session.content.control).toBeDefined();
  });
});
