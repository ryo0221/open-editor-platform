import { describe, expect, it } from 'vitest';
import { f76HatBoard } from '@editor-platform/pcb-core';
import { schematicBoardDiff, schematicErc, schematicHatExample, validateSchematic } from './index';

// F90 (TS-2122): the sensor HAT+ schematic matches the F76 board.
describe('F90 HAT schematic (TS-2122)', () => {
  it('is valid, has no ERC issues and sends nothing new to the F76 board', () => {
    const doc = schematicHatExample();
    expect(validateSchematic(doc)).toEqual([]);
    expect(schematicErc(doc)).toEqual([]);
    const diff = schematicBoardDiff(doc, f76HatBoard());
    expect(diff.skipped).toEqual([]);
    expect(diff.conflicts).toEqual([]);
    expect(diff.changes).toEqual([]);
  });
});
