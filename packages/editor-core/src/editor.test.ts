import { describe, expect, it } from 'vitest';
import {
  addAnnotation,
  command,
  immutableCommand,
  EditorEventBus,
  EditorSession,
  transaction,
  type Selection,
} from './index';
describe('command history', () => {
  it('offers an immutable rendering result while legacy snapshots and commands stay isolated', () => {
    const s = new EditorSession({ rows: [{ value: 1 }, { value: 2 }] });
    const view = s.executeView(
      immutableCommand('cell', 'Edit', (d) => ({
        ...d,
        rows: d.rows.map((r, i) => (i ? r : { value: 3 })),
      })),
    );
    expect(() => view.rows[0].value++).toThrow();
    const next = s.executeView(
      immutableCommand('cell', 'Edit', (d) => ({
        ...d,
        rows: d.rows.map((r, i) => (i ? r : { value: 4 })),
      })),
    );
    expect(next.rows[1]).toBe(view.rows[1]);
    expect(view.rows[0].value).toBe(3);
    expect(s.undo()).toEqual(view);
    const result = s.execute(
      command('mutable', 'Mutable host command', (d) => {
        d.rows[0].value = 5;
        return d;
      }),
    );
    result.rows[0].value = 99;
    expect(s.content.rows[0].value).toBe(5);
    expect(s.undo()).toEqual(view);
    expect(s.redo().rows[0].value).toBe(5);
  });
  it('returns the same immutable history views while legacy copies remain isolated', () => {
    const s = new EditorSession({ rows: [{ value: 1 }] });
    const first = s.executeView(
      immutableCommand('first', 'First', () => ({ rows: [{ value: 2 }] })),
    );
    const second = s.executeView(
      immutableCommand('second', 'Second', () => ({ rows: [{ value: 3 }] })),
    );
    const before = s.revision.sequence;
    expect(s.undoView()).toBe(first);
    expect(() => {
      first.rows[0].value = 99;
    }).toThrow();
    expect(s.redoView()).toBe(second);
    const copy = s.undo();
    copy.rows[0].value = 99;
    expect(s.content.rows[0].value).toBe(2);
    expect(s.redoView()).toBe(second);
    expect(s.revision.sequence).toBe(before + 4);
  });
  it('does not move history when an immutable view cannot be frozen', () => {
    const initial: Record<string, unknown> = {};
    initial.self = initial;
    const s = new EditorSession(initial);
    s.execute(command('plain', 'Plain', () => ({ value: 1 })));
    const before = s.revision;
    expect(() => s.undoView()).toThrow();
    expect(s.revision).toEqual(before);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(s.content).toEqual({ value: 1 });
    const restored = s.undo();
    expect(restored.self).toBe(restored);
  });
  it('does not commit a falsely declared pure command that mutates its input', () => {
    const s = new EditorSession({ rows: [{ value: 1 }] });
    const revision = s.revision;
    expect(() =>
      s.executeView(
        immutableCommand('bad', 'Bad', (d) => {
          d.rows[0].value = 2;
          return d;
        }),
      ),
    ).toThrow();
    expect(s.revision).toEqual(revision);
    expect(s.canUndo).toBe(false);
    expect(s.content.rows[0].value).toBe(1);
  });
  const add = (n: number) => command<number>('add', `Add ${n}`, (v) => v + n);
  it('isolates retained history from caller snapshots and mutable command inputs/results', () => {
    const initial = { items: ['one'] },
      session = new EditorSession(initial);
    initial.items.push('outside');
    const snapshot = session.content;
    snapshot.items.push('outside');
    const result = session.execute(
      command('append', 'Append', (current) => {
        current.items.push('two');
        return current;
      }),
    );
    result.items.push('outside');
    expect(session.content.items).toEqual(['one', 'two']);
    const undone = session.undo();
    undone.items.push('outside');
    expect(session.content.items).toEqual(['one']);
    expect(session.redo().items).toEqual(['one', 'two']);
  });
  it('identifies unsaved draft changes and ABA without conflating saved versions', () => {
    const s = new EditorSession(0),
      before = s.revision;
    s.execute(add(1));
    s.undo();
    expect(s.content).toBe(0);
    expect(s.revision.sequence).toBe(before.sequence + 2);
    expect(s.revision.sessionId).toBe(before.sessionId);
    expect(new EditorSession(0).revision.sessionId).not.toBe(before.sessionId);
    const failed = s.revision;
    expect(() =>
      s.execute(
        command('fail', 'Fail', () => {
          throw new Error('no');
        }),
      ),
    ).toThrow();
    expect(s.revision).toEqual(failed);
  });
  it('groups consecutive local typing while isolating other transactions and undo', () => {
    const s = new EditorSession('');
    const type = (text: string) =>
      command<string>('type', 'Type', (value) => value + text, {
        origin: 'local',
        transactionId: text,
        mergeKey: 'paragraph:1',
      });
    s.execute(type('a'));
    s.execute(type('b'));
    s.breakHistoryGroup();
    s.execute(type('c'));
    expect(s.undo()).toBe('ab');
    expect(s.undo()).toBe('');
    expect(s.redo()).toBe('ab');
    expect(s.revision.sequence).toBe(6);
  });
  it('applies, undoes and redoes commands and invalidates old redo', () => {
    const s = new EditorSession(1);
    s.execute(add(2));
    expect(s.content).toBe(3);
    expect(s.undo()).toBe(1);
    expect(s.redo()).toBe(3);
    s.undo();
    s.execute(add(10));
    expect(s.canRedo).toBe(false);
    expect(s.content).toBe(11);
  });
  it('batches a transaction into one undo step', () => {
    const s = new EditorSession(0);
    s.execute(transaction('two operations', [add(1), add(2)]));
    expect(s.content).toBe(3);
    expect(s.undo()).toBe(0);
    expect(s.canUndo).toBe(false);
  });
  it('does not partially apply a failed transaction or mutate original content', () => {
    const s = new EditorSession({ list: [1] });
    expect(() =>
      s.execute(
        transaction('failed', [
          command('push', 'Push', (v) => {
            v.list.push(2);
            return v;
          }),
          command('fail', 'Fail', () => {
            throw new Error('no');
          }),
        ]),
      ),
    ).toThrow('no');
    expect(s.content.list).toEqual([1]);
    expect(s.canUndo).toBe(false);
  });
});
describe('selection and extension contracts', () => {
  it('anchors a thread to a copied typed range and retains author/time', () => {
    const selection: Selection = {
      addresses: [{ artifactId: 'a', elementId: 'b', region: { type: 'text', start: 1, end: 4 } }],
    };
    const a = addAnnotation(selection, ' Note ', 'writer');
    selection.addresses[0].elementId = 'other';
    expect(a.anchor.addresses[0].elementId).toBe('b');
    expect(a.anchor.addresses[0].region).toEqual({ type: 'text', start: 1, end: 4 });
    expect(a.comments[0].body).toBe('Note');
    expect(a.comments[0].author).toBe('writer');
    expect(a.resolved).toBe(false);
    expect(a.createdAt).toMatch(/^20/);
  });
  it('requires both an anchor and meaningful comment', () => {
    expect(() => addAnnotation({ addresses: [] }, 'text', 'a')).toThrow();
    expect(() =>
      addAnnotation({ addresses: [{ artifactId: 'a', elementId: 'b' }] }, ' ', 'a'),
    ).toThrow();
  });
  it('delivers typed host events and removes subscriptions', () => {
    const bus = new EditorEventBus();
    const events: string[] = [];
    const off = bus.on('command', (event) => events.push(event.label));
    bus.emit('command', { artifactId: 'a', type: 'insert', label: 'First' });
    off();
    bus.emit('command', { artifactId: 'a', type: 'insert', label: 'Second' });
    expect(events).toEqual(['First']);
    let received: Selection | undefined;
    bus.on('selection', (s) => {
      received = s;
    });
    bus.emit('selection', { addresses: [{ artifactId: 'a', elementId: 'el' }] });
    expect(received?.addresses[0].elementId).toBe('el');
  });
});

it('previews external commands without changing draft or undo history', async () => {
  const { previewProposedCommands } = await import('./index');
  const session = new EditorSession({ text: 'before' });
  const proposal = {
    id: 'external',
    source: 'host runtime',
    summary: 'Replace text',
    commands: [command<{ text: string }>('replace', 'Replace', (d) => ({ ...d, text: 'after' }))],
  };
  const preview = previewProposedCommands(session.content, proposal);
  expect(preview.content.text).toBe('after');
  expect(session.content.text).toBe('before');
  expect(session.canUndo).toBe(false);
  session.execute(transaction(proposal.summary, proposal.commands));
  expect(session.content.text).toBe('after');
  expect(session.undo().text).toBe('before');
});
