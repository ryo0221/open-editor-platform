import { describe, expect, it } from 'vitest';
import { EditorSession, command, keepHighest, keepHighestProblems } from './index';

type Doc = { items: string[]; lastIssued: Record<string, number>; count?: number };
const add = (prefix: string) =>
  command<Doc>('add', 'add', (d) => {
    const n = (d.lastIssued[prefix] ?? 0) + 1;
    return {
      ...d,
      items: [...d.items, `${prefix}-${String(n).padStart(2, '0')}`],
      lastIssued: { ...d.lastIssued, [prefix]: n },
    };
  });

describe('keepHighest (#64: Undo never lowers an issued ID number)', () => {
  it('Undo restores the earlier content but keeps the highest issued number, so the ID is not reused', () => {
    const s = new EditorSession<Doc>(
      { items: [], lastIssued: { FA: 6 } },
      { keepHighest: ['/lastIssued'] },
    );
    s.execute(add('FA'));
    expect(s.content).toEqual({ items: ['FA-07'], lastIssued: { FA: 7 } });
    s.undo();
    expect(s.content).toEqual({ items: [], lastIssued: { FA: 7 } });
    s.execute(add('FA'));
    expect(s.content.items).toEqual(['FA-08']);
  });

  it('a prefix first issued after the restored version is kept; Redo keeps the larger value too', () => {
    const s = new EditorSession<Doc>(
      { items: [], lastIssued: {} },
      { keepHighest: ['/lastIssued'] },
    );
    s.execute(add('AS'));
    s.undo();
    expect(s.content.lastIssued).toEqual({ AS: 1 });
    s.redo();
    expect(s.content).toEqual({ items: ['AS-01'], lastIssued: { AS: 1 } });
  });

  it('without the option, Undo restores the earlier content exactly (unchanged behavior)', () => {
    const s = new EditorSession<Doc>({ items: [], lastIssued: { FA: 6 } });
    s.execute(add('FA'));
    s.undo();
    expect(s.content).toEqual({ items: [], lastIssued: { FA: 6 } });
  });

  it('the validator sees the content that will be restored, and a refusal leaves history untouched', () => {
    const s = new EditorSession<Doc>(
      { items: [], lastIssued: { FA: 6 } },
      { keepHighest: ['/lastIssued'] },
    );
    s.execute(add('FA'));
    expect(() =>
      s.undo((c) => {
        expect(c.lastIssued.FA).toBe(7);
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(s.content).toEqual({ items: ['FA-07'], lastIssued: { FA: 7 } });
    expect(s.canUndo).toBe(true);
  });

  it('numbers keep the larger value; other shapes and missing places are restored as they were', () => {
    expect(keepHighest({ count: 1 }, { count: 4 }, ['/count'])).toEqual({ count: 4 });
    expect(keepHighest({ count: 5 }, { count: 4 }, ['/count'])).toEqual({ count: 5 });
    expect(keepHighest({ count: 'a' }, { count: 4 }, ['/count'])).toEqual({ count: 'a' });
    expect(keepHighest({ a: 1 }, { b: 2 }, ['/b'])).toEqual({ a: 1 });
    expect(keepHighest({ m: { x: 1 } }, { m: { x: 2, y: 'text' } }, ['/m'])).toEqual({
      m: { x: 2 },
    });
    expect(keepHighest({ m: { 'a/b': 1 } }, { m: { 'a/b': 3 } }, ['/m/a~1b'])).toEqual({
      m: { 'a/b': 3 },
    });
    const same = { count: 9 };
    expect(keepHighest(same, { count: 2 }, ['/count'])).toBe(same);
  });

  it('refuses invalid place lists', () => {
    expect(keepHighestProblems(['/a'])).toEqual([]);
    expect(keepHighestProblems([])).not.toEqual([]);
    expect(keepHighestProblems(['a'])).not.toEqual([]);
    expect(keepHighestProblems(['/a', '/a'])).not.toEqual([]);
    expect(keepHighestProblems(['/a~2'])).not.toEqual([]);
    expect(keepHighestProblems(Array.from({ length: 17 }, (_, i) => `/a${i}`))).not.toEqual([]);
    expect(() => new EditorSession({}, { keepHighest: ['bad'] })).toThrow();
  });
});

describe('keepHighest review fixes (#73)', () => {
  it('walks array indexes and keeps arrays as arrays', () => {
    const out = keepHighest(
      { groups: [{ lastIssued: 1 }, { lastIssued: 9 }] },
      { groups: [{ lastIssued: 4 }, { lastIssued: 2 }] },
      ['/groups/0/lastIssued', '/groups/1/lastIssued'],
    );
    expect(out).toEqual({ groups: [{ lastIssued: 4 }, { lastIssued: 9 }] });
    expect(Array.isArray(out.groups)).toBe(true);
    // Non-index steps, out-of-range indexes and "-" leave the restored value as it is.
    for (const p of [
      '/groups/x/lastIssued',
      '/groups/5/lastIssued',
      '/groups/-/lastIssued',
      '/groups/01/lastIssued',
    ]) {
      const r = { groups: [{ lastIssued: 1 }] };
      expect(keepHighest(r, { groups: [{ lastIssued: 4 }] }, [p])).toBe(r);
    }
  });

  it('keeps a numeric key named __proto__ as an ordinary own key', () => {
    const current = JSON.parse('{"lastIssued":{"__proto__":7,"FA":3,"x":{"__proto__":{"n":2}}}}');
    const out = keepHighest({ lastIssued: {} as Record<string, unknown> }, current, [
      '/lastIssued',
    ]);
    expect(Object.hasOwn(out.lastIssued, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(out.lastIssued, '__proto__')?.value).toBe(7);
    expect(out.lastIssued.FA).toBe(3);
    expect(Object.getPrototypeOf(out.lastIssued)).toBe(Object.prototype);
    const x = out.lastIssued.x as Record<string, unknown>;
    expect(Object.getPrototypeOf(x)).toBe(Object.prototype);
    expect(Object.hasOwn(x, '__proto__')).toBe(true);
  });

  it('peekHistory returns what Undo/Redo will commit, with stable identity', () => {
    const s = new EditorSession<{ count: number; n: number }>(
      { count: 1, n: 0 },
      { keepHighest: ['/count'] },
    );
    s.execute(command('set', 'set', (d) => ({ ...d, count: 4, n: 1 })));
    const peeked = s.peekHistory('undo')!;
    expect(peeked).toEqual({ count: 4, n: 0 });
    expect(s.peekHistory('undo')).toBe(peeked);
    let seen: unknown;
    const view = s.undoView((candidate) => {
      seen = candidate;
    });
    expect(seen).toEqual(peeked);
    expect(view).toBe(peeked);
    expect(s.content).toEqual({ count: 4, n: 0 });
    const redo = s.peekHistory('redo')!;
    expect(redo).toEqual({ count: 4, n: 1 });
    expect(s.peekHistory('redo')).toBe(redo);
  });
});
