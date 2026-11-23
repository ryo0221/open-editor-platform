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
