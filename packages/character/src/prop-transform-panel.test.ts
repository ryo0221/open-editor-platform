import { describe, expect, it } from 'vitest';
import { assignedGroup } from './prop-transform-panel';

describe('transform groups in the panel (MR4b)', () => {
  it('puts a joint with no choice in the first group, whatever its ID', () => {
    expect(assignedGroup({}, 'toString', 2)).toBe(0);
    expect(assignedGroup({}, 'valueOf', 1)).toBe(0);
    expect(assignedGroup({ toString: 1 }, 'toString', 2)).toBe(1);
    // A group removed since: the last one left.
    expect(assignedGroup({ 'j-knee': 3 }, 'j-knee', 2)).toBe(1);
  });
});
