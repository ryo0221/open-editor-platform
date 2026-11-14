import { describe, expect, it } from 'vitest';
import {
  applyLadderOperation,
  ladderAddBranch,
  ladderBlinkExample,
  ladderIds,
  ladderInsertSeries,
  ladderMove,
  ladderNewId,
  ladderNormalize,
  ladderRemove,
  ladderReplace,
  ladderSelfHoldExample,
  LadderOperationError,
  LadderValidationError,
  type LadderNode,
  type LadderRung,
} from './index';

/** The network as text: contacts by variable, `(a b)` series, `[a | b]` parallel. */
const text = (n: LadderNode): string =>
  n.kind === 'contact'
    ? n.variable
    : n.kind === 'series'
      ? `(${n.items.map(text).join(' ')})`
      : n.kind === 'parallel'
        ? `[${n.branches.map(text).join(' | ')}]`
        : n.kind;
const contact = (id: string, variable = id.toUpperCase()): LadderNode => ({
  id,
  kind: 'contact',
  variable,
  contact: 'no',
});
let counter = 0;
const newId = () => `w${++counter}`;
const rung = (network: LadderNode): LadderRung => ({
  id: 'r',
  network,
  coils: [{ id: 'c', variable: 'LAMP', coil: 'normal' }],
});
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof LadderOperationError || e instanceof LadderValidationError) return e.message;
    throw e;
  }
  return 'none';
};

// TS-2112: editing a ladder program (operations and network helpers).
describe('ladder-core editing (TS-2112)', () => {
  it('inserts in series and in parallel, and normalizes nested series and parallels', () => {
    let r = rung({ id: 'n', kind: 'series', items: [] });
    r = ladderInsertSeries(r, 'n', 'after', contact('a'), newId);
    expect(text(r.network)).toBe('(A)');
    r = ladderInsertSeries(r, 'a', 'after', contact('b'), newId);
    r = ladderInsertSeries(r, 'a', 'before', contact('z'), newId);
    expect(text(r.network)).toBe('(Z A B)');
    r = ladderAddBranch(r, 'a', contact('p'), newId);
    expect(text(r.network)).toBe('(Z [A | P] B)');
    // A branch on a branch adds to the same parallel; a series after a parallel's branch wraps it.
    r = ladderAddBranch(r, 'p', contact('q'), newId);
    r = ladderInsertSeries(r, 'p', 'after', contact('s'), newId);
    expect(text(r.network)).toBe('(Z [A | (P S) | Q] B)');
    // The whole network: at its end.
    r = ladderInsertSeries(r, 'n', 'after', contact('e'), newId);
    expect(text(r.network)).toBe('(Z [A | (P S) | Q] B E)');
    expect(
      text(
        ladderNormalize({
          id: 'x',
          kind: 'series',
          items: [
            {
              id: 'y',
              kind: 'series',
              items: [contact('a'), { id: 'e', kind: 'series', items: [] }],
            },
            {
              id: 'p',
              kind: 'parallel',
              branches: [{ id: 'q', kind: 'parallel', branches: [contact('b'), contact('c')] }],
            },
          ],
        }),
      ),
    ).toBe('(A [B | C])');
    expect(
      code(() =>
        ladderAddBranch(rung({ id: 'n', kind: 'series', items: [] }), 'n', contact('a'), newId),
      ),
    ).toBe('branch-target');
  });

  it('removes and moves elements, keeping the IDs of what stays', () => {
    const hold = ladderSelfHoldExample().rungs[0];
    expect(text(hold.network)).toBe('([START | LAMP] STOP)');
    // Removing a branch leaves one: the parallel goes, the contact stays with its ID.
    let r = ladderRemove(hold, 'n4', newId);
    expect(text(r.network)).toBe('(START STOP)');
    expect(ladderIds({ ...ladderSelfHoldExample(), rungs: [r] }).has('n3')).toBe(true);
    // Move STOP before START, then into the branch after LAMP.
    r = ladderMove(hold, 'n5', 'n2', 'before', newId);
    expect(text(r.network)).toBe('(STOP [START | LAMP])');
    r = ladderMove(hold, 'n5', 'n4', 'after', newId);
    expect(text(r.network)).toBe('([START | (LAMP STOP)])');
    expect(code(() => ladderMove(hold, 'n2', 'n3', 'after', newId))).toBe('move-into-self');
    // Removing the whole network leaves the rail; removing a coil empties the coils.
    expect(text(ladderRemove(hold, 'n1', newId).network)).toBe('()');
    expect(ladderRemove(hold, 'c1', newId).coils).toEqual([]);
    expect(code(() => ladderRemove(hold, 'nope', newId))).toBe('not-found');
    // Replacing a leaf and a coil.
    r = ladderReplace(hold, { id: 'n5', kind: 'contact', variable: 'STOP', contact: 'no' });
    expect(r.network.kind === 'series' && r.network.items[1]).toMatchObject({ contact: 'no' });
    r = ladderReplace(hold, { id: 'c1', variable: 'LAMP', coil: 'set' });
    expect(r.coils[0].coil).toBe('set');
    expect(code(() => ladderReplace(hold, { id: 'n2', kind: 'series', items: [] }))).toBe(
      'not-leaf',
    );
  });

  it('applies program operations, validated as a whole', () => {
    const doc = ladderSelfHoldExample();
    const rung2: LadderRung = {
      id: 'r2',
      network: { id: 'm1', kind: 'series', items: [contact('m2', 'LAMP')] },
      coils: [{ id: 'm3', variable: 'BUZZ', coil: 'normal' }],
    };
    // A coil on a variable that does not exist is refused; with the variable in one batch it is not.
    expect(
      code(() => applyLadderOperation(doc, { type: 'insertRung', rung: rung2, index: 9 })),
    ).toBe('variable-missing');
    let next = applyLadderOperation(doc, {
      type: 'batch',
      ops: [
        { type: 'insertVariable', variable: { name: 'BUZZ', type: 'BOOL', role: 'output' } },
        { type: 'insertRung', rung: rung2, index: 9 },
      ],
    });
    expect(next.rungs.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(doc.rungs).toHaveLength(1);
    next = applyLadderOperation(next, { type: 'moveRung', id: 'r2', index: 0 });
    expect(next.rungs.map((r) => r.id)).toEqual(['r2', 'r1']);
    // Renaming a variable renames its references (names compare without case).
    next = applyLadderOperation(next, {
      type: 'updateVariable',
      name: 'lamp',
      variable: { name: 'LIGHT', type: 'BOOL', role: 'output' },
    });
    expect(JSON.stringify(next.rungs)).not.toContain('"LAMP"');
    expect(JSON.stringify(next.rungs).match(/"LIGHT"/g)).toHaveLength(3);
    // A variable in use cannot be deleted, nor change to a type its uses refuse.
    expect(
      code(() => applyLadderOperation(next, { type: 'deleteVariables', names: ['STOP'] })),
    ).toBe('variable-missing');
    expect(
      code(() =>
        applyLadderOperation(next, {
          type: 'updateVariable',
          name: 'STOP',
          variable: { name: 'STOP', type: 'INT', role: 'input' },
        }),
      ),
    ).toBe('variable-type');
    // A rung without coils, a bad scan period, unknown IDs and malformed operations.
    expect(
      code(() =>
        applyLadderOperation(next, {
          type: 'updateRungs',
          rungs: [ladderRemove(next.rungs[0], 'm3', newId)],
        }),
      ),
    ).toBe('rung-no-coil');
    expect(code(() => applyLadderOperation(next, { type: 'setProgram', scanMs: 0 }))).toBe(
      'scan-ms',
    );
    expect(applyLadderOperation(next, { type: 'setProgram', scanMs: 50 }).scanMs).toBe(50);
    expect(code(() => applyLadderOperation(next, { type: 'deleteRungs', ids: ['x'] }))).toBe(
      'not-found',
    );
    expect(code(() => applyLadderOperation(next, { type: 'setProgram' }))).toBe('operation');
    expect(
      code(() =>
        applyLadderOperation(next, {
          type: 'batch',
          ops: [{ type: 'batch', ops: [{ type: 'setProgram', scanMs: 5 }] }],
        }),
      ),
    ).toBe('operation');
    expect(applyLadderOperation(next, { type: 'deleteRungs', ids: ['r2'] }).rungs).toHaveLength(1);
  });

  it('gives new IDs that no element uses', () => {
    const doc = ladderBlinkExample();
    const ids = ladderIds(doc);
    const fixed = ['n1', 'n1', 'abc'];
    const random = () => `${fixed.shift()}`;
    // 'n-n1' is free in the blink example; a taken one is skipped.
    expect(ladderNewId(doc, 'n', new Set(['n-n1']), random)).toBe('n-abc');
    expect(ids.has('r1')).toBe(true);
    expect(ladderNewId(doc, 'n')).toMatch(/^n-[0-9a-f]{12}$/);
  });
});
