import { describe, expect, it } from 'vitest';
import { f37Office } from '@editor-platform/bim-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  applyConstructionOperation,
  checkConstructionSource,
  constructionContentHash,
  constructionEditorCommand,
  f85OfficeSchedule,
  freshConstructionId,
  newConstruction,
  readConstructionCsv,
  validateConstruction,
  writeConstructionCsv,
  type ConstructionDocument,
  type ConstructionTask,
} from './index';

const source = { artifactId: 'bim', versionId: 'v1', contentHash: 'b'.repeat(64) };
const task = (id: string, over: Partial<ConstructionTask> = {}): ConstructionTask => ({
  id,
  name: id,
  durationDays: 1,
  predecessors: [],
  action: 'construct',
  elementIds: [],
  ...over,
});
const docWith = (...tasks: ConstructionTask[]): ConstructionDocument => ({
  ...newConstruction('S', source, '2027-04-05'),
  tasks,
});
const codes = (v: unknown) => validateConstruction(v).map((d) => d.code);

describe('CS1a construction document (ST-540, TS-2070)', () => {
  it('accepts F85 and an empty schedule (ST-540#1)', () => {
    expect(validateConstruction(f85OfficeSchedule())).toEqual([]);
    expect(validateConstruction(docWith())).toEqual([]);
    expect(checkConstructionSource(f85OfficeSchedule(), f37Office())).toEqual([]);
  });

  it('refuses malformed documents with a code and a path (ST-540#2)', () => {
    expect(codes({ ...docWith(), schemaVersion: 2 })).toEqual(['unsupported-schema']);
    expect(codes({ ...docWith(), extra: 1 })).toEqual(['unknown-key']);
    expect(codes({ ...docWith(), startDate: '2027-02-30' })).toEqual(['date']);
    expect(codes({ ...docWith(), startDate: '2300-01-01' })).toEqual(['date']);
    expect(codes({ ...docWith(), calendar: { workWeekdays: [], holidays: [] } })).toEqual([
      'calendar',
    ]);
    expect(codes({ ...docWith(), calendar: { workWeekdays: [2, 1], holidays: [] } })).toEqual([
      'calendar',
    ]);
    expect(
      codes({
        ...docWith(),
        calendar: { workWeekdays: [1], holidays: ['2027-05-03', '2027-05-03'] },
      }),
    ).toEqual(['calendar']);
    expect(codes(docWith(task('a', { durationDays: -1 })))).toEqual(['duration']);
    expect(codes(docWith(task('a', { durationDays: 1.5 })))).toEqual(['duration']);
    expect(codes(docWith(task('a'), task('a')))).toEqual(['duplicate-id']);
    expect(codes(docWith(task('a', { predecessors: [{ taskId: 'a', lagDays: 0 }] })))).toEqual([
      'self-link',
    ]);
    expect(codes(docWith(task('a', { predecessors: [{ taskId: 'x', lagDays: 0 }] })))).toEqual([
      'task-missing',
    ]);
    expect(
      codes(
        docWith(
          task('a'),
          task('b', {
            predecessors: [
              { taskId: 'a', lagDays: 0 },
              { taskId: 'a', lagDays: 1 },
            ],
          }),
        ),
      ),
    ).toEqual(['duplicate-link']);
    expect(codes(docWith(task('a', { action: 'build' as never })))).toEqual(['action']);
    expect(codes(docWith(task('a', { elementIds: ['e', 'e'] })))).toEqual(['duplicate-element']);
    expect(
      codes(docWith(task('a', { actual: { start: '2027-05-02', finish: '2027-05-01' } }))),
    ).toEqual(['actual-order']);
    expect(codes(docWith(task('a', { actual: { finish: '2027-05-01' } })))).toEqual([
      'actual-order',
    ]);
    expect(codes(docWith(task('a', { actual: { percent: 101 } })))).toEqual(['percent']);
    expect(codes({ ...docWith(task('a')), retiredIds: ['a'] })).toEqual(['retired-id-in-use']);
    const getter = docWith();
    Object.defineProperty(getter, 'name', { get: () => 'x', enumerable: true });
    expect(codes(getter)).toEqual(['json-value']);
  });

  it('refuses an element built twice, or temporary works also built (ST-540#2)', () => {
    expect(
      codes(docWith(task('a', { elementIds: ['e'] }), task('b', { elementIds: ['e'] }))),
    ).toEqual(['element-twice']);
    expect(
      codes(
        docWith(
          task('a', { elementIds: ['e'] }),
          task('b', { elementIds: ['e'], action: 'temporary' }),
        ),
      ),
    ).toEqual(['element-twice']);
    // Built then removed is one element's normal life.
    expect(
      codes(
        docWith(
          task('a', { elementIds: ['e'] }),
          task('b', {
            elementIds: ['e'],
            action: 'remove',
            predecessors: [{ taskId: 'a', lagDays: 0 }],
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('refuses a loop in the predecessors and names it (ST-540#2)', () => {
    const d = validateConstruction(
      docWith(
        task('a', { predecessors: [{ taskId: 'c', lagDays: 0 }] }),
        task('b', { predecessors: [{ taskId: 'a', lagDays: 0 }] }),
        task('c', { predecessors: [{ taskId: 'b', lagDays: 0 }] }),
      ),
    );
    expect(d.map((x) => x.code)).toEqual(['cycle']);
    expect(d[0]!.message).toContain('a → c → b → a');
  });

  it('lists elements the BIM version does not have (ST-540#3)', () => {
    const doc = f85OfficeSchedule();
    const bim = f37Office();
    bim.elements = bim.elements.filter((e) => e.id !== 'r-roof' && e.id !== 's-1f');
    const d = checkConstructionSource(doc, bim);
    expect(d.map((x) => [x.code, x.message])).toEqual([
      ['element-missing', 'Ground slab: no element s-1f in the BIM version'],
      ['element-missing', 'Roof: no element r-roof in the BIM version'],
    ]);
  });

  it('applies operations whole or not at all, and retires removed IDs (ST-540#4)', () => {
    let doc = docWith(task('a'));
    doc = applyConstructionOperation(doc, {
      type: 'addTask',
      task: task('b', { predecessors: [{ taskId: 'a', lagDays: 2 }] }),
    });
    expect(() => applyConstructionOperation(doc, { type: 'removeTask', id: 'a' })).toThrow(
      /follows this task/,
    );
    expect(() =>
      applyConstructionOperation(doc, {
        type: 'updateTask',
        task: task('a', { predecessors: [{ taskId: 'b', lagDays: 0 }] }),
      }),
    ).toThrow(/loop/);
    doc = applyConstructionOperation(doc, { type: 'removeTask', id: 'b' });
    expect(doc.retiredIds).toEqual(['b']);
    expect(freshConstructionId(doc, 'b')).toBe('b-2');
    expect(() => applyConstructionOperation(doc, { type: 'addTask', task: task('b') })).toThrow(
      /was removed/,
    );
    doc = applyConstructionOperation(doc, {
      type: 'replaceTasks',
      tasks: [task('x'), task('y', { predecessors: [{ taskId: 'x', lagDays: 0 }] })],
    });
    expect(doc.tasks.map((t) => t.id)).toEqual(['x', 'y']);
    expect(doc.retiredIds).toEqual(['b', 'a']);
    expect(() =>
      applyConstructionOperation(doc, { type: 'setStartDate', startDate: '2027-13-01' }),
    ).toThrow();
  });

  it('runs as an editor command that checks the base and the authority (ST-540#4)', () => {
    const doc = docWith(task('a'));
    const session = new EditorSession(doc);
    const cmd = (op: Parameters<typeof constructionEditorCommand>[0], canEdit = () => true) =>
      constructionEditorCommand(op, {
        expectedHash: constructionContentHash(session.content),
        canEdit,
      });
    session.execute(
      cmd([
        { type: 'addTask', task: task('b', { predecessors: [{ taskId: 'a', lagDays: 0 }] }) },
        { type: 'renameDocument', name: 'Renamed' },
      ]),
    );
    expect(session.content.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(session.content.name).toBe('Renamed');
    session.undo();
    expect(session.content).toEqual(doc);
    const stale = constructionEditorCommand(
      { type: 'renameDocument', name: 'x' },
      { expectedHash: 'f'.repeat(64), canEdit: () => true },
    );
    expect(() => session.execute(stale)).toThrow('construction-base-mismatch');
    expect(() => session.execute(cmd({ type: 'renameDocument', name: 'x' }, () => false))).toThrow(
      'permission-denied',
    );
    // A refused operation refuses the whole step.
    expect(() =>
      session.execute(
        cmd([
          { type: 'renameDocument', name: 'x' },
          { type: 'removeTask', id: 'nope' },
        ]),
      ),
    ).toThrow();
    expect(session.content).toEqual(doc);
  });

  it('reads and writes tasks as CSV (ST-540#5)', () => {
    const text =
      '﻿ID,Name,Duration,Predecessors,Action,Elements\r\n' +
      'a,"Columns, 1F",3,,construct,c-1;c-2\r\n' +
      'b,Scaffold,10,a(2),temporary,\r\n' +
      'c,"Say ""done""",0,a;b(-1),,\r\n';
    const r = readConstructionCsv(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.tasks).toEqual([
      task('a', { name: 'Columns, 1F', durationDays: 3, elementIds: ['c-1', 'c-2'] }),
      task('b', {
        name: 'Scaffold',
        durationDays: 10,
        action: 'temporary',
        predecessors: [{ taskId: 'a', lagDays: 2 }],
      }),
      task('c', {
        name: 'Say "done"',
        durationDays: 0,
        predecessors: [
          { taskId: 'a', lagDays: 0 },
          { taskId: 'b', lagDays: -1 },
        ],
      }),
    ]);
    expect(readConstructionCsv(writeConstructionCsv(r.tasks)).tasks).toEqual(r.tasks);
    const f85 = f85OfficeSchedule().tasks;
    expect(readConstructionCsv(writeConstructionCsv(f85)).tasks).toEqual(f85);
    // Progress typed in on site goes through the CSV too.
    const done = [
      task('a', { actual: { start: '2027-04-06', finish: '2027-04-09', percent: 100 } }),
      task('b', { actual: { start: '2027-04-12', percent: 37.5 } }),
    ];
    expect(readConstructionCsv(writeConstructionCsv(done)).tasks).toEqual(done);
    // Element IDs with hyphens are not read as lags.
    expect(
      readConstructionCsv('id,name,duration,predecessors\nx-1,X,1,\ny,Y,1,x-1\n').tasks[1]!
        .predecessors,
    ).toEqual([{ taskId: 'x-1', lagDays: 0 }]);
  });

  it('refuses bad CSV by line, as a whole (ST-540#5)', () => {
    const msgs = (t: string) =>
      readConstructionCsv(t).diagnostics.map((d) => `${d.path} ${d.message}`);
    expect(msgs('id,name\na,A\n')).toEqual(['line 1 no "duration" column']);
    expect(msgs('id,name,duration,colour\n')).toEqual(['line 1 unknown column "colour"']);
    expect(msgs('id,name,duration\na,A,two\nb,B,1,extra\n')).toEqual([
      'line 2 duration "two" is not whole days',
      'line 3 more fields than columns',
    ]);
    expect(msgs('id,name,duration,action\na,A,1,build\n')).toEqual([
      'line 2 unknown action "build"',
    ]);
    expect(msgs('id,name,duration,actual_start,percent\na,A,1,6/4/2027,half\n')).toEqual([
      'line 2 actual_start "6/4/2027" is not YYYY-MM-DD',
      'line 2 percent "half" is not a number',
    ]);
    expect(msgs('id,name,duration\n"a,A,1\n')).toEqual(['line 2 a quoted field is not closed']);
    expect(() => writeConstructionCsv([task('a;b')])).toThrow('csv-id');
    expect(msgs('id,name,duration\na,A,"1"0\n')).toEqual([
      'line 2 characters after a quoted field',
    ]);
    expect(msgs('id,name,duration\na,"A" ,1\n')).toEqual([
      'line 2 characters after a quoted field',
    ]);
  });
});
