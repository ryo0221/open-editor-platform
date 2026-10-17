import { expect, it, vi } from 'vitest';
import { EditorInputs } from './inputs';
it('retains accepted and unexecuted buffers after partial refusal and retries without double commit', () => {
  const inputs = new EditorInputs();
  const dirty = [true, true, true],
    commits = [0, 0, 0];
  let accept = false;
  dirty.forEach((_, index) =>
    inputs.register({
      label: `Input ${index}`,
      read: () => ({ dirty: dirty[index] }),
      focus: vi.fn(),
      prepare: () => () => {
        if (index === 1 && !accept) return false;
        commits[index]++;
        dirty[index] = false;
        inputs.changed();
      },
    }),
  );
  const persist = vi.fn();
  const save = () => {
    inputs.flush();
    persist();
  };
  expect(save).toThrow('Input 1');
  expect(commits).toEqual([1, 0, 0]);
  expect(inputs.getSnapshot().dirty).toBe(2);
  expect(persist).not.toHaveBeenCalled();
  accept = true;
  save();
  expect(commits).toEqual([1, 1, 1]);
  expect(inputs.getSnapshot().dirty).toBe(0);
  expect(persist).toHaveBeenCalledOnce();
});
it('preflights all buffers before committing any and focuses invalid input', () => {
  const inputs = new EditorInputs(),
    commit = vi.fn(),
    focus = vi.fn();
  inputs.register({
    label: 'First',
    read: () => ({ dirty: true }),
    prepare: () => commit,
    focus: vi.fn(),
  });
  inputs.register({
    label: 'Invalid',
    read: () => ({ dirty: true }),
    prepare: () => {
      throw new Error('invalid number');
    },
    focus,
  });
  expect(() => inputs.flush()).toThrow('Invalid: invalid number');
  expect(commit).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledOnce();
});
it('blocks composing clean buffers and retains rejected commits', () => {
  const inputs = new EditorInputs(),
    commit = vi.fn(),
    focus = vi.fn();
  const remove = inputs.register({
    label: 'IME',
    read: () => ({ dirty: false, composing: true }),
    prepare: () => commit,
    focus,
  });
  expect(inputs.getSnapshot()).toEqual({ dirty: 0, composing: 1, canUndo: false, canRedo: false });
  expect(() => inputs.flush()).toThrow('入力変換');
  expect(commit).not.toHaveBeenCalled();
  remove();
  inputs.register({
    label: 'Authority',
    read: () => ({ dirty: true }),
    prepare: () => () => false,
    focus,
  });
  expect(() => inputs.flush()).toThrow('変更を確定できません');
  expect(inputs.getSnapshot().dirty).toBe(1);
});
it('publishes stable snapshots when pending state changes and removes unmounted buffers', () => {
  const inputs = new EditorInputs(),
    notify = vi.fn();
  let dirty = false;
  const remove = inputs.register({
    label: 'Field',
    read: () => ({ dirty }),
    prepare: () => () => {
      dirty = false;
    },
    focus: vi.fn(),
  });
  const stop = inputs.subscribe(notify),
    clean = inputs.getSnapshot();
  inputs.changed();
  expect(inputs.getSnapshot()).toBe(clean);
  dirty = true;
  inputs.changed();
  expect(notify).toHaveBeenCalledOnce();
  inputs.flush();
  expect(inputs.getSnapshot().dirty).toBe(0);
  dirty = true;
  inputs.changed();
  remove();
  expect(inputs.getSnapshot().dirty).toBe(0);
  stop();
});
it('retains rejected input and reports failure before a Host save can proceed', () => {
  const inputs = new EditorInputs(),
    focus = vi.fn();
  inputs.register({
    label: 'Rejected input',
    read: () => ({ dirty: true }),
    prepare: () => () => false,
    focus,
  });
  expect(() => inputs.flush()).toThrow('変更を確定');
  expect(focus).toHaveBeenCalledOnce();
  expect(inputs.getSnapshot().dirty).toBe(1);
});
it('routes private view draft Undo before native history and keeps Redo available after undoing to clean', () => {
  const inputs = new EditorInputs();
  let dirty = true,
    past = 1,
    future = 0;
  inputs.register({
    label: 'Data view',
    read: () => ({ dirty, canUndo: past > 0, canRedo: future > 0 }),
    prepare: () => () => {
      dirty = false;
    },
    focus: vi.fn(),
    history: (direction) => {
      if (direction === 'undo' && past) {
        past--;
        future++;
        dirty = false;
        return true;
      }
      if (direction === 'redo' && future) {
        future--;
        past++;
        dirty = true;
        return true;
      }
      return false;
    },
  });
  expect(inputs.history('undo')).toBe(true);
  expect(inputs.getSnapshot().dirty).toBe(0);
  expect(inputs.getSnapshot().canRedo).toBe(true);
  expect(inputs.history('redo')).toBe(true);
  expect(inputs.getSnapshot().dirty).toBe(1);
  expect(inputs.history('redo')).toBe(false);
});
it('rolls back a registration when synchronous listener notification throws', () => {
  const inputs = new EditorInputs();
  const prepare = vi.fn(() => () => {});
  const stop = inputs.subscribe(() => {
    throw new Error('listener failed');
  });
  expect(() =>
    inputs.register({
      label: 'never-owned',
      read: () => ({ dirty: true }),
      prepare,
      focus: () => {},
    }),
  ).toThrow('Input registration rollback notification failed');
  stop();
  expect(inputs.getSnapshot().dirty).toBe(0);
  inputs.flush();
  expect(prepare).not.toHaveBeenCalled();
});
