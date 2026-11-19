import { describe, expect, it } from 'vitest';
import {
  applyFactoryOperation,
  f170SmallLine,
  f174PlcLine,
  f175PlcLineBug,
  factoryIds,
  runFactory,
  validateFactory,
  type FactoryControl,
} from './index';

const codes = (v: unknown) => validateFactory(v).map((d) => `${d.code}@${d.path}`);

describe('FT6 PLC control in the model (TS-2686)', () => {
  it('refuses wrong wiring and programs with code and path', () => {
    const base = f174PlcLine();
    const edit = (patch: (c: FactoryControl) => void) => {
      const d = structuredClone(base);
      patch(d.control!);
      return codes(d);
    };
    expect(edit((c) => (c.sensors[0]!.signal = 'hot' as never))).toEqual([
      'signal@$.control.sensors.0.signal',
    ]);
    expect(edit((c) => (c.actuators[0]!.objectId = 'press'))).toEqual([
      'signal-kind@$.control.actuators.0.signal',
    ]);
    expect(edit((c) => (c.sensors[1]!.signal = 'failed'))).toEqual([]);
    expect(edit((c) => (c.sensors[0]!.objectId = 'out'))).toEqual([
      'signal-kind@$.control.sensors.0.signal',
    ]);
    expect(edit((c) => (c.sensors[0]!.objectId = 'nowhere'))).toEqual([
      'object-missing@$.control.sensors.0.objectId',
    ]);
    expect(edit((c) => (c.sensors[0]!.variable = 'NOPE'))).toEqual([
      'variable-missing@$.control.sensors.0.variable',
    ]);
    expect(edit((c) => (c.sensors[0]!.variable = 'C1_RUN'))).toEqual([
      'variable-type@$.control.sensors.0.variable',
    ]);
    expect(edit((c) => (c.actuators[0]!.variable = 'C1_HOLD'))).toEqual([
      'variable-type@$.control.actuators.0.variable',
    ]);
    // IEC names compare without case; one input cannot be written by two sensors.
    expect(edit((c) => (c.sensors[1]!.variable = 'c1_at_end'))).toEqual([
      'duplicate-variable@$.control.sensors.1.variable',
    ]);
    // One output may drive two actuators, but an object's signal is wired once.
    expect(edit((c) => (c.actuators[1]!.variable = 'C1_RUN'))).toEqual([]);
    expect(edit((c) => (c.actuators[1]!.signal = 'run'))).toEqual([
      'duplicate-signal@$.control.actuators.1',
    ]);
    expect(edit((c) => (c.actuators[1]!.id = 'press'))).toEqual([
      'duplicate-id@$.control.actuators.1.id',
    ]);
    expect(edit((c) => (c.program.scanMs = 0))).toEqual(['program@$.control.program.scanMs']);
    expect(edit((c) => (c.stallMs = 0))).toEqual(['time@$.control.stallMs']);
    expect(edit((c) => ((c as unknown as Record<string, unknown>).extra = 1))).toEqual([
      'unknown-key@$.control.extra',
    ]);
    expect(edit((c) => ((c as unknown as Record<string, unknown>).sensors = {}))).toEqual([
      'signals@$.control.sensors',
    ]);
    // A value the ladder check cannot even print is refused, not thrown.
    expect(
      edit((c) => ((c.program.variables[0] as { name: unknown }).name = { toString: null })),
    ).toEqual(['program@$.control.program']);
    // A program too deep for the old JSON limit (16) is still plain data.
    expect(validateFactory(f175PlcLineBug())).toEqual([]);
    // Too many scans for the run: refused before it starts.
    const long = f174PlcLine();
    long.run.durationMs = 31 * 24 * 3_600_000;
    expect(() => runFactory(long)).toThrow(expect.objectContaining({ code: 'limit-scans' }));
  });

  it('edits the control as one operation; removing an object takes its signals', () => {
    const doc = f174PlcLine();
    const control = structuredClone(doc.control!);
    let next = applyFactoryOperation(doc, { type: 'setControl', control: null });
    expect(next.control).toBeUndefined();
    expect(next.retiredIds).toEqual(
      expect.arrayContaining(['sn-c1-end', 'sn-inspect-busy', 'ac-c1-run', 'ac-c1-gate']),
    );
    // Retired IDs are not reused.
    expect(() => applyFactoryOperation(next, { type: 'setControl', control })).toThrow(
      expect.objectContaining({ code: 'retired-id' }),
    );
    next = applyFactoryOperation(doc, { type: 'removeObject', id: 'inspect' });
    expect(next.control!.sensors.map((s) => s.id)).toEqual(['sn-c1-end']);
    expect(next.retiredIds).toContain('sn-inspect-busy');
    expect(factoryIds(doc)).toContain('ac-c1-gate');
    expect(() =>
      applyFactoryOperation(doc, {
        type: 'setControl',
        control: { ...control, actuators: [{ ...control.actuators[0]!, objectId: 'press' }] },
      }),
    ).toThrow(expect.objectContaining({ code: 'signal-kind' }));
    // Models without control are unchanged.
    expect(runFactory(f170SmallLine()).produced).toBe(477);
  });
});
