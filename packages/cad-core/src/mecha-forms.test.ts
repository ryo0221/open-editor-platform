import { describe, expect, it } from 'vitest';
import { assertCadOperation } from './commands';
import {
  cadConfigurationLimits,
  configurationLimitViolations,
  configurationStale,
  currentConfigurationValues,
  matchingConfigurations,
} from './configurations';
import { compareCad } from './diff';
import { mr1ArmWings, mr2ArmWingsForms, mr7ToolMount } from './mecha-fixtures';
import { currentMounts } from './mounts';
import type { CadDocument } from './model';
import { applyCadOperation, type CadOperation } from './operations';
import { validateCad } from './validation';

const deg = Math.PI / 180;
const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const run = (doc: CadDocument, op: CadOperation) => {
  assertCadOperation(op);
  return applyCadOperation(doc, op);
};
const refused = (doc: CadDocument, op: CadOperation) => {
  try {
    run(doc, op);
  } catch (e) {
    return (e as Error).message;
  }
  return 'applied';
};
const angle = (doc: CadDocument, joint: string, key = 'angle') =>
  (doc.joints.find((j) => j.id === joint)!.values as Record<string, { literalRad: number }>)[key]!
    .literalRad;

describe('MR2 forms: save, recall, overwrite, rename, delete (TS-1704)', () => {
  it('validates the fixture and shows which form the values match', () => {
    const { assembly } = mr2ArmWingsForms();
    expect(codes(assembly)).toEqual([]);
    expect(matchingConfigurations(assembly)).toEqual(['form-stand']);
  });
  it('saves the current values of every moving joint, coupled values left out', () => {
    const { assembly } = mr1ArmWings();
    const values = currentConfigurationValues(assembly);
    expect(Object.keys(values).sort()).toEqual(['j-elbow', 'j-shoulder', 'j-wing-l', 'j-wrist']);
    const next = run(assembly, {
      type: 'insertConfiguration',
      configuration: { id: 'form-a', name: 'A', values },
    });
    expect(next.configurations).toHaveLength(1);
    expect(matchingConfigurations(next)).toEqual(['form-a']);
    // The input document is untouched (the edit is atomic), and the change is reported.
    expect(assembly.configurations).toBeUndefined();
    expect(compareCad(assembly, next).map((c) => `${c.kind}:${c.path}:${c.elementId}`)).toEqual([
      'added:configurations:form-a',
    ]);
  });
  it('recalls a form as one edit and the coupled wing follows', () => {
    const { assembly } = mr2ArmWingsForms();
    const flight = run(assembly, { type: 'recallConfiguration', id: 'form-flight' });
    expect(angle(flight, 'j-wing-l')).toBeCloseTo(80 * deg, 12);
    expect(angle(flight, 'j-shoulder', 'angle2')).toBeCloseTo(-80 * deg, 12);
    // The follower stores nothing of its own; it still follows.
    expect(flight.joints.find((j) => j.id === 'j-wing-r')!.values).toEqual({});
    expect(matchingConfigurations(flight)).toEqual(['form-flight']);
    const back = run(flight, { type: 'recallConfiguration', id: 'form-stand' });
    expect(back.joints).toEqual(assembly.joints);
  });
  it('matches within 0.01° and not beyond', () => {
    const { assembly } = mr2ArmWingsForms();
    const nudge = (d: number) =>
      run(assembly, {
        type: 'setJointValues',
        jointId: 'j-elbow',
        values: { angle: { literalRad: (45 + d) * deg } },
      });
    expect(matchingConfigurations(nudge(0.009))).toEqual(['form-stand']);
    expect(matchingConfigurations(nudge(0.011))).toEqual([]);
  });
  it('overwrites a form with the current values and keeps its ID and name', () => {
    const { assembly } = mr2ArmWingsForms();
    const moved = run(assembly, {
      type: 'setJointValues',
      jointId: 'j-elbow',
      values: { angle: { literalRad: 120 * deg } },
    });
    const next = run(moved, {
      type: 'overwriteConfiguration',
      id: 'form-stand',
      values: currentConfigurationValues(moved),
    });
    const f = next.configurations!.find((x) => x.id === 'form-stand')!;
    expect(f.name).toBe('Stand');
    expect(f.values['j-elbow']).toEqual({ angle: { literalRad: 120 * deg } });
    expect(matchingConfigurations(next)).toEqual(['form-stand']);
  });
  it('renames and deletes; the last delete removes the field', () => {
    const { assembly } = mr2ArmWingsForms();
    const renamed = run(assembly, { type: 'renameConfiguration', id: 'form-flight', name: '飛行' });
    expect(renamed.configurations![1]!.name).toBe('飛行');
    expect(refused(assembly, { type: 'renameConfiguration', id: 'form-flight', name: '' })).toMatch(
      /cad-invalid:configuration-name/,
    );
    const one = run(renamed, { type: 'removeConfiguration', id: 'form-stand' });
    expect(one.configurations!.map((f) => f.id)).toEqual(['form-flight']);
    const none = run(one, { type: 'removeConfiguration', id: 'form-flight' });
    expect(Object.hasOwn(none, 'configurations')).toBe(false);
    expect(refused(none, { type: 'recallConfiguration', id: 'form-flight' })).toBe(
      'target-missing',
    );
  });
  it('stores literals, so a parameter a joint read can be deleted with its joints', () => {
    const { assembly } = mr2ArmWingsForms();
    const doc = structuredClone(assembly);
    doc.parameters.push({ id: 'p-elbow', name: 'Elbow', type: 'angle', value: 45 * deg });
    doc.joints.find((j) => j.id === 'j-elbow')!.values = { angle: { parameterId: 'p-elbow' } };
    expect(codes(doc)).toEqual([]);
    const saved = run(doc, {
      type: 'insertConfiguration',
      configuration: { id: 'form-p', name: 'P', values: currentConfigurationValues(doc) },
    });
    expect(saved.configurations![2]!.values['j-elbow']).toEqual({
      angle: { literalRad: 45 * deg },
    });
    expect(matchingConfigurations(saved)).toEqual(['form-stand', 'form-p']);
    // A form naming a parameter is refused: forms never read one.
    const named = structuredClone(saved);
    named.configurations![2]!.values['j-elbow'] = { angle: { parameterId: 'p-elbow' } };
    expect(codes(named)).toContain('configuration-literal');
    // Deleting the parameter takes the elbow joint along; the forms stay, now stale.
    const gone = run(saved, { type: 'deleteClosure', ids: ['p-elbow'], cascade: true });
    expect(gone.joints.some((j) => j.id === 'j-elbow')).toBe(false);
    expect(gone.configurations).toHaveLength(3);
    expect(configurationStale(gone, { values: gone.configurations![2]!.values })).toBe(true);
  });
  it('refuses a recall that drives a value past its limits, followers included', () => {
    const { assembly } = mr2ArmWingsForms();
    const doc = structuredClone(assembly);
    doc.configurations![1]!.values['j-elbow'] = { angle: { literalRad: 170 * deg } };
    expect(codes(doc)).toEqual([]); // the shape is valid; the limit is checked on recall
    expect(configurationLimitViolations(doc, doc.configurations![1]!.values)).toEqual([
      { joint: 'j-elbow', of: 'angle', value: 170 * deg },
    ]);
    expect(refused(doc, { type: 'recallConfiguration', id: 'form-flight' })).toBe(
      'configuration-limit',
    );
    // The right wing's limit is ±90°: a left wing at 80° with a +20° offset puts it past.
    const off = structuredClone(assembly);
    off.joints.find((j) => j.id === 'j-wing-r')!.couplings![0]!.offset = -20 * deg;
    expect(refused(off, { type: 'recallConfiguration', id: 'form-flight' })).toBe(
      'configuration-limit',
    );
  });
});

describe('MR2 stale forms and form shape (TS-1705)', () => {
  it('keeps a stale form valid, shows it stale, and refuses its recall', () => {
    const { assembly } = mr2ArmWingsForms();
    // The wrist goes: both forms name a joint that is no longer there.
    const doc = run(assembly, { type: 'deleteClosure', ids: ['j-wrist'], cascade: false });
    expect(codes(doc)).toEqual([]);
    expect(configurationStale(doc, { values: doc.configurations![0]!.values })).toBe(true);
    expect(matchingConfigurations(doc)).toEqual([]);
    expect(refused(doc, { type: 'recallConfiguration', id: 'form-flight' })).toBe(
      'configuration-stale',
    );
    // Overwriting with the current joints mends it; a stale overwrite is refused.
    expect(
      refused(doc, {
        type: 'overwriteConfiguration',
        id: 'form-stand',
        values: assembly.configurations![0]!.values,
      }),
    ).toBe('configuration-stale');
    const mended = run(doc, {
      type: 'overwriteConfiguration',
      id: 'form-stand',
      values: currentConfigurationValues(doc),
    });
    expect(matchingConfigurations(mended)).toEqual(['form-stand']);
    // Renaming or deleting a stale form is fine.
    expect(refused(doc, { type: 'renameConfiguration', id: 'form-flight', name: 'Old' })).toBe(
      'applied',
    );
  });
  it('is stale when a joint becomes a follower or a new joint moves', () => {
    const { assembly } = mr2ArmWingsForms();
    const coupled = structuredClone(assembly);
    const elbow = coupled.joints.find((j) => j.id === 'j-elbow')!;
    elbow.values = {};
    elbow.couplings = [
      { of: 'angle', from: { joint: 'j-wing-l', of: 'angle' }, ratio: 1, offset: 0 },
    ];
    expect(configurationStale(coupled, { values: assembly.configurations![0]!.values })).toBe(true);
    const free = structuredClone(assembly);
    const r = free.joints.find((j) => j.id === 'j-wing-r')!;
    r.couplings = undefined;
    delete r.couplings;
    r.values = { angle: { literalRad: -40 * deg } };
    expect(codes(free)).toEqual([]);
    expect(configurationStale(free, { values: assembly.configurations![0]!.values })).toBe(true);
  });
  it('refuses a malformed form list', () => {
    const { assembly } = mr2ArmWingsForms();
    const bad = (edit: (d: Record<string, unknown>) => void) => {
      const d = structuredClone(assembly) as unknown as Record<string, unknown>;
      edit(d);
      return codes(d);
    };
    const forms = (d: Record<string, unknown>) => d.configurations as Record<string, unknown>[];
    expect(bad((d) => (d.configurations = []))).toContain('configurations');
    expect(bad((d) => (forms(d)[1]!.id = 'form-stand'))).toContain('duplicate-id');
    // A form ID shares the document's ID namespace.
    expect(bad((d) => (forms(d)[1]!.id = 'j-elbow'))).toContain('duplicate-id');
    expect(bad((d) => (forms(d)[0]!.extra = 1))).toContain('unknown-field');
    expect(
      bad((d) => ((forms(d)[0]!.values as Record<string, unknown>)['j-elbow'] = { spin: 1 })),
    ).toContain('unknown-field');
    expect(
      bad(
        (d) =>
          ((forms(d)[0]!.values as Record<string, unknown>)['j-elbow'] = {
            angle: { literalMm: 1 },
          }),
      ),
    ).toContain('configuration-literal');
    expect(
      bad((d) => ((forms(d)[0]!.values as Record<string, unknown>)['j-elbow'] = {})),
    ).toContain('configuration-values');
    expect(
      bad(
        (d) =>
          ((forms(d)[0]!.values as Record<string, unknown>)[' padded'] = {
            angle: { literalRad: 0 },
          }),
      ),
    ).toContain('configuration-joint');
    expect(
      bad((d) => {
        const list = forms(d);
        while (list.length <= cadConfigurationLimits.configurations)
          list.push({ ...list[0]!, id: `form-${list.length}` });
      }),
    ).toContain('limit-configurations');
  });
  it("reads only a form's own joint values, so joint IDs like toString recall", () => {
    const doc = JSON.parse(
      JSON.stringify(mr7ToolMount().assembly).replaceAll('"j-tool-hand"', '"toString"'),
    ) as CadDocument;
    expect(codes(doc)).toEqual([]);
    const values = currentConfigurationValues(doc);
    expect(Object.hasOwn(values, 'toString')).toBe(false);
    const saved = run(doc, {
      type: 'insertConfiguration',
      configuration: { id: 'form-a', name: 'A', values, mounts: currentMounts(doc)! },
    });
    expect(configurationStale(saved, saved.configurations![0]!)).toBe(false);
    expect(refused(saved, { type: 'recallConfiguration', id: 'form-a' })).toBe('applied');
    expect(configurationLimitViolations(saved, values)).toEqual([]);
  });
  it('refuses a 33rd form when saving', () => {
    const { assembly } = mr2ArmWingsForms();
    const doc = structuredClone(assembly);
    while (doc.configurations!.length < cadConfigurationLimits.configurations)
      doc.configurations!.push({
        ...doc.configurations![0]!,
        id: `form-${doc.configurations!.length}`,
      });
    expect(codes(doc)).toEqual([]);
    expect(
      refused(doc, {
        type: 'insertConfiguration',
        configuration: { id: 'form-x', name: 'X', values: currentConfigurationValues(doc) },
      }),
    ).toBe('limit-configurations');
  });
});
