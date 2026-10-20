import { expect, it } from 'vitest';
import { EditorSession, command } from './index';
const edit = (n: number, mergeKey?: string) =>
  command('set', 'set', () => ({ n }), {
    origin: 'local',
    transactionId: String(n),
    ...(mergeKey ? { mergeKey } : {}),
  });
const state = (s: EditorSession<{ n: number }>) => ({
  content: s.content,
  revision: s.revision,
  canUndo: s.canUndo,
  canRedo: s.canRedo,
});
const historyMethods = ['undo', 'redo', 'undoView', 'redoView'] as const;
function setup(direction: (typeof historyMethods)[number]) {
  const s = new EditorSession({ n: 0 });
  s.execute(edit(1, 'a'));
  s.execute(edit(2, 'b'));
  if (direction.startsWith('redo')) s.undo();
  return s;
}
it.each(historyMethods)(
  '%s validates private copy synchronously and commits original candidate',
  (direction) => {
    const s = setup(direction),
      before = s.revision.sequence;
    const expected = direction.startsWith('undo') ? 1 : 2;
    let candidate: { n: number } | undefined;
    s[direction]((v) => {
      expect(v.n).toBe(expected);
      candidate = v;
      v.n = 999;
    });
    expect(s.content).toEqual({ n: expected });
    expect(s.revision.sequence).toBe(before + 1);
    candidate!.n = 123;
    expect(s.content.n).toBe(expected);
    s[direction.startsWith('undo') ? 'redo' : 'undo']();
    expect(s.content.n).toBe(direction.startsWith('undo') ? 2 : 1);
  },
);
it.each(historyMethods)(
  '%s rejection preserves both history directions and revision',
  (direction) => {
    const s = setup(direction),
      before = state(s);
    expect(() =>
      s[direction](() => {
        throw Error('RejectNative');
      }),
    ).toThrow('RejectNative');
    expect(state(s)).toEqual(before);
    if (direction.startsWith('undo')) {
      expect(s.undo().n).toBe(1);
      expect(s.undo().n).toBe(0);
      expect(s.redo().n).toBe(1);
      expect(s.redo().n).toBe(2);
    } else {
      expect(s.redo().n).toBe(2);
      expect(s.undo().n).toBe(1);
      expect(s.undo().n).toBe(0);
    }
  },
);
it('rejected undo retains the typing merge key', () => {
  const s = setup('undo');
  expect(() =>
    s.undo(() => {
      throw Error('no');
    }),
  ).toThrow('no');
  s.execute(edit(3, 'b'));
  expect(s.undo()).toEqual({ n: 1 });
  expect(s.undo()).toEqual({ n: 0 });
});
for (const direction of ['undo', 'redo'] as const) {
  for (const mutation of [
    'execute',
    'executeView',
    'undo',
    'redo',
    'undoView',
    'redoView',
    'breakHistoryGroup',
  ] as const) {
    it(`${direction} validator refuses reentrant ${mutation} without changing any state`, () => {
      const s = setup(direction),
        before = state(s);
      expect(() =>
        s[direction](() => {
          if (mutation === 'execute' || mutation === 'executeView') s[mutation](edit(99));
          else s[mutation]();
        }),
      ).toThrow('HistoryValidationReentrancy');
      expect(state(s)).toEqual(before);
      s[direction]();
      expect(s.content.n).toBe(direction.startsWith('undo') ? 1 : 2);
    });
  }
}
it.each(historyMethods)('%s rejects asynchronous validation before commit', (direction) => {
  const s = setup(direction),
    before = state(s);
  expect(() => s[direction](() => Promise.resolve())).toThrow('HistoryValidationMustBeSynchronous');
  expect(state(s)).toEqual(before);
});
it('empty history skips validation and preserves legacy return behavior', () => {
  const s = new EditorSession({ n: 0 });
  const reject = () => {
    throw Error('must not run');
  };
  expect(s.undo(reject)).toEqual({ n: 0 });
  expect(s.redo(reject)).toEqual({ n: 0 });
  expect(s.revision.sequence).toBe(0);
});
