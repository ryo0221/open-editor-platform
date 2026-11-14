import { ladderSelfHoldExample, type LadderDocument } from '@editor-platform/ladder-core';
import {
  schematicHatExample,
  schematicLedExample,
  type SchematicDocument,
} from '@editor-platform/schematic-core';
import type { CosimBinding } from './cosim';

/**
 * SL8 examples written for this project: the schematic LED example with circuit models (R1, a
 * green LED D1, the push button SW1 from GPIO27 to ground) and the self-hold program, bound
 * START ← GPIO27 (pull-up, active low) and LAMP → GPIO17.
 */
export function cosimLedSchematic(ohms = 330): SchematicDocument {
  const doc = schematicLedExample();
  const models: Record<string, NonNullable<SchematicDocument['parts'][number]['model']>> = {
    r1: { kind: 'resistor', terminals: { a: '1', b: '2' }, params: { ohms } },
    d1: { kind: 'led', terminals: { anode: '2', cathode: '1' }, params: { color: 'green' } },
    sw1: {
      kind: 'switch',
      terminals: { a: '1', b: '2' },
      params: { closedOhms: 0.05, openOhms: 1e9 },
    },
  };
  for (const p of doc.parts) if (models[p.id]) p.model = models[p.id];
  return doc;
}

export function cosimSelfHoldBindings(): CosimBinding[] {
  return [
    { variable: 'START', net: 'GPIO27', kind: 'input', pull: 'up', activeLow: true },
    { variable: 'LAMP', net: 'GPIO17', kind: 'output' },
  ];
}

export function cosimSelfHoldExample(): {
  schematic: SchematicDocument;
  ladder: LadderDocument;
  bindings: CosimBinding[];
} {
  return {
    schematic: cosimLedSchematic(),
    ladder: ladderSelfHoldExample(),
    bindings: cosimSelfHoldBindings(),
  };
}

/**
 * F92: the co-simulation example. The sensor HAT+ schematic (F90, matching the F76 board) runs
 * the self-hold program (F91): SW1 on GPIO27 starts, the LED D1 on GPIO17 stays lit, STOP stops.
 */
export function cosimHatExample(): {
  schematic: SchematicDocument;
  ladder: LadderDocument;
  bindings: CosimBinding[];
} {
  return {
    schematic: schematicHatExample(),
    ladder: ladderSelfHoldExample(),
    bindings: cosimSelfHoldBindings(),
  };
}
