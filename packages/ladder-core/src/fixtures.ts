import type { LadderDocument } from './model';

/**
 * Example programs (SL6 tests and screens). Independent examples written for this project, not
 * taken from any vendor's program.
 */

/** Self-holding lamp: START (rising) sets it on through its own contact; STOP breaks the hold. */
export function ladderSelfHoldExample(): LadderDocument {
  return {
    schemaVersion: 1,
    name: 'Self hold',
    scanMs: 10,
    variables: [
      { name: 'START', type: 'BOOL', role: 'input', comment: 'Push button (pressed = TRUE)' },
      { name: 'STOP', type: 'BOOL', role: 'input', comment: 'Push button (pressed = TRUE)' },
      { name: 'LAMP', type: 'BOOL', role: 'output' },
    ],
    rungs: [
      {
        id: 'r1',
        comment: 'START or the lamp itself, while STOP is not pressed, keeps the lamp on.',
        network: {
          id: 'n1',
          kind: 'series',
          items: [
            {
              id: 'n2',
              kind: 'parallel',
              branches: [
                { id: 'n3', kind: 'contact', variable: 'START', contact: 'no' },
                { id: 'n4', kind: 'contact', variable: 'LAMP', contact: 'no' },
              ],
            },
            { id: 'n5', kind: 'contact', variable: 'STOP', contact: 'nc' },
          ],
        },
        coils: [{ id: 'c1', variable: 'LAMP', coil: 'normal' }],
      },
    ],
  };
}

/** Blinking lamp while ENABLE: two on-delay timers make a 500 ms on / 500 ms off cycle. */
export function ladderBlinkExample(): LadderDocument {
  return {
    schemaVersion: 1,
    name: 'Blink',
    scanMs: 10,
    variables: [
      { name: 'ENABLE', type: 'BOOL', role: 'input' },
      { name: 'LAMP', type: 'BOOL', role: 'output' },
      { name: 'T_ON', type: 'TON', role: 'internal', comment: 'Lamp-on time' },
      { name: 'T_OFF', type: 'TON', role: 'internal', comment: 'Lamp-off time' },
      { name: 'PHASE', type: 'BOOL', role: 'internal', comment: 'TRUE while the lamp is off' },
    ],
    rungs: [
      {
        id: 'r1',
        comment: 'Lamp on for 500 ms, then PHASE.',
        network: {
          id: 'n1',
          kind: 'series',
          items: [
            { id: 'n2', kind: 'contact', variable: 'ENABLE', contact: 'no' },
            { id: 'n3', kind: 'contact', variable: 'PHASE', contact: 'nc' },
            { id: 'n4', kind: 'timer', instance: 'T_ON', presetMs: 500 },
          ],
        },
        coils: [{ id: 'c1', variable: 'PHASE', coil: 'set' }],
      },
      {
        id: 'r2',
        comment: 'Lamp off for 500 ms, then back.',
        network: {
          id: 'n5',
          kind: 'series',
          items: [
            { id: 'n6', kind: 'contact', variable: 'PHASE', contact: 'no' },
            { id: 'n7', kind: 'timer', instance: 'T_OFF', presetMs: 500 },
          ],
        },
        coils: [{ id: 'c2', variable: 'PHASE', coil: 'reset' }],
      },
      {
        id: 'r3',
        network: {
          id: 'n8',
          kind: 'series',
          items: [
            { id: 'n9', kind: 'contact', variable: 'ENABLE', contact: 'no' },
            { id: 'n10', kind: 'contact', variable: 'PHASE', contact: 'nc' },
          ],
        },
        coils: [{ id: 'c3', variable: 'LAMP', coil: 'normal' }],
      },
    ],
  };
}

/** A counter: every rising PULSE counts; at 3 DONE is on; RESET clears. */
export function ladderCounterExample(): LadderDocument {
  return {
    schemaVersion: 1,
    name: 'Counter',
    scanMs: 10,
    variables: [
      { name: 'PULSE', type: 'BOOL', role: 'input' },
      { name: 'RESET', type: 'BOOL', role: 'input' },
      { name: 'DONE', type: 'BOOL', role: 'output' },
      { name: 'HALF', type: 'BOOL', role: 'output' },
      { name: 'COUNT', type: 'CTU', role: 'internal' },
    ],
    rungs: [
      {
        id: 'r1',
        network: {
          id: 'n1',
          kind: 'series',
          items: [
            { id: 'n2', kind: 'contact', variable: 'PULSE', contact: 'no' },
            { id: 'n3', kind: 'counter', instance: 'COUNT', preset: 3, reset: 'RESET' },
          ],
        },
        coils: [{ id: 'c1', variable: 'DONE', coil: 'normal' }],
      },
      {
        id: 'r2',
        network: {
          id: 'n4',
          kind: 'compare',
          op: 'ge',
          a: { variable: 'COUNT', member: 'CV' },
          b: { value: 2 },
        },
        coils: [{ id: 'c2', variable: 'HALF', coil: 'normal' }],
      },
    ],
  };
}

/** A new program: no variables, no rungs, a 10 ms scan (the Playground's starter). */
export function ladderStarter(): LadderDocument {
  return { schemaVersion: 1, name: 'Ladder', scanMs: 10, variables: [], rungs: [] };
}
