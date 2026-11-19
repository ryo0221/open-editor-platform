import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  FactoryValidationError,
  f170SmallLine,
  newFactory,
  type FactoryDocument,
} from '@editor-platform/factory-core';
import { FactoryController, type FactoryExperimentRunner, type FactoryRunner } from './controller';
import { factoryAutoLayout } from './layout';

function setup(doc: FactoryDocument, canEdit = () => true, runner?: FactoryRunner) {
  const session = new EditorSession<FactoryDocument>(doc);
  const saved: FactoryDocument[] = [];
  const controller = new FactoryController({
    session,
    canEdit,
    onApplied: (c) => saved.push(c),
    runner,
  });
  return { session, controller, saved };
}

// TS-2653: the factory Surface's controller and plan layout (no DOM).
describe('factory Surface controller (TS-2653)', () => {
  it('lays objects out by their links and keeps placed ones where they stand', () => {
    const doc = f170SmallLine();
    const l = factoryAutoLayout(doc);
    // Columns by the longest path from an entry; both sources start the line, in separate rows.
    expect(l.get('in-housing')!.x).toBe(0);
    expect(l.get('machining')!.x).toBe(4000);
    expect(l.get('out')!.x).toBeGreaterThan(l.get('test')!.x);
    expect(l.get('in-gearset')!.x).toBe(0);
    expect(l.get('in-gearset')!.y).not.toBe(l.get('in-housing')!.y);
    const moved = {
      ...doc,
      objects: doc.objects.map((o) => (o.id === 'test' ? { ...o, at: { x: 123, y: -456 } } : o)),
    };
    expect(factoryAutoLayout(moved).get('test')).toEqual({ x: 123, y: -456 });
  });

  it('builds a line by adding and linking objects, one command per edit', () => {
    const { session, controller, saved } = setup(newFactory('Line'));
    expect(controller.addObject('source')).toBeUndefined();
    const src = controller.state.selection!;
    expect(controller.addObject('station')).toBeUndefined();
    const st = controller.state.selection!;
    expect(controller.addObject('drain')).toBeUndefined();
    const out = controller.state.selection!;
    // Link mode: select the start, toggle, then click the target.
    controller.select(src);
    controller.toggleConnect();
    expect(controller.state.connectFrom).toBe(src);
    controller.select(st);
    expect(controller.state.connectFrom).toBeUndefined();
    expect(controller.state.content.links.map((l) => [l.from, l.to])).toEqual([[src, st]]);
    expect(controller.connect(st, out)).toBeUndefined();
    expect(controller.connect(st, out)).toBe('duplicate-link');
    expect(controller.state.notice?.code).toBe('duplicate-link');
    expect(saved).toHaveLength(5);
    // New objects stand right of the others.
    const xs = controller.state.content.objects.map((o) => o.at!.x);
    expect(xs).toEqual([0, 4000, 8000]);
    // Undo takes back one edit; sync follows the session.
    session.undo();
    controller.sync();
    expect(controller.state.content.links).toHaveLength(1);
  });

  it('adds a component product with the first assembly', () => {
    const { controller } = setup(newFactory('A'));
    expect(controller.addObject('assembly')).toBeUndefined();
    const doc = controller.state.content;
    expect(doc.products.map((p) => p.id)).toEqual(['part', 'component']);
    const a = doc.objects[0]!;
    expect(a.kind === 'assembly' && a.components).toEqual([{ productId: 'component', count: 1 }]);
  });

  it('moves an object to the nearest 100 mm and pins the others where they were drawn', () => {
    const doc = f170SmallLine();
    const before = factoryAutoLayout(doc);
    const { controller } = setup(doc);
    expect(controller.moveObject('test', 1234.4, -2251)).toBeUndefined();
    const objects = controller.state.content.objects;
    expect(objects.find((o) => o.id === 'test')!.at).toEqual({ x: 1200, y: -2300 });
    for (const o of objects) if (o.id !== 'test') expect(o.at).toEqual(before.get(o.id));
  });

  it('deletes the selected object with its links, and refuses edits when read only', () => {
    let editable = true;
    const { controller } = setup(f170SmallLine(), () => editable);
    controller.select('test');
    expect(controller.deleteSelection()).toBeUndefined();
    const doc = controller.state.content;
    expect(doc.objects.some((o) => o.id === 'test')).toBe(false);
    expect(doc.links.some((l) => l.from === 'test' || l.to === 'test')).toBe(false);
    expect(controller.state.selection).toBeUndefined();
    editable = false;
    controller.accessChanged();
    expect(controller.state.readOnly).toBe(true);
    expect(controller.addObject('buffer')).toBe('permission-denied');
  });

  it('imports a times CSV as one command and reports the line of a bad row', () => {
    const { controller, saved } = setup(f170SmallLine());
    const csv =
      'object,type,value,min,mode,max,mean,sd\ntest,normal,,,,,58,4\nin-housing,const,50\n';
    expect(controller.importTimes(csv)).toBeUndefined();
    expect(saved).toHaveLength(1);
    const test = controller.state.content.objects.find((o) => o.id === 'test')!;
    expect(test.kind === 'station' && test.processTime).toEqual({
      type: 'normal',
      mean: 58000,
      sd: 4000,
    });
    expect(controller.importTimes('object,type,value\nnope,const,1\n')).toBe('csv');
    expect(controller.state.notice).toMatchObject({ path: 'line 2', message: 'no object nope' });
  });

  it('runs the model, marks the result stale after an edit, and can be stopped', async () => {
    const { controller } = setup(f170SmallLine());
    expect(await controller.run()).toBeUndefined();
    const r = controller.state.result!;
    expect(r.value.produced).toBe(477);
    expect(r.value.timeline).toBeDefined();
    expect(controller.fresh).toBe(true);
    controller.updateObject({ ...controller.state.content.objects[0]!, name: 'Housings' });
    expect(controller.fresh).toBe(false);
    // A runner that never answers until aborted.
    const slow: FactoryRunner = (_d, signal) =>
      new Promise((_r, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const s = setup(f170SmallLine(), () => true, slow);
    const p = s.controller.run();
    expect(s.controller.state.running).toBe(true);
    expect(await s.controller.run()).toBe('running');
    s.controller.stop();
    expect(await p).toBe('stopped');
    expect(s.controller.state.running).toBe(false);
    expect(s.controller.state.notice?.code).toBe('stopped');
  });
});

// TS-2676: FT5 experiments in the factory Surface's controller (no DOM).
describe('factory experiment controller (TS-2676)', () => {
  it('edits the experiment as one command, runs it and keeps the runs of a stopped one', async () => {
    const { session, controller } = setup(f170SmallLine());
    const experiment = {
      replications: 2,
      factors: [{ kind: 'time-scale' as const, targetId: 'test', values: [50, 100] }],
    };
    expect(controller.apply({ type: 'setExperiment', experiment })).toBeUndefined();
    expect(session.content.experiment).toEqual(experiment);
    expect(
      controller.apply({
        type: 'setExperiment',
        experiment: { ...experiment, replications: 101 },
      }),
    ).toBe('replications');
    expect(await controller.runExperiment()).toBeUndefined();
    const done = controller.state.experiment!;
    expect(done).toMatchObject({ total: 4, done: true, key: controller.state.key });
    expect(done.runs.map((r) => [r.combination, r.replication])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(controller.state.experimenting).toBe(false);

    // A runner that hands over one run and then waits until stopped.
    const half: FactoryExperimentRunner = (_d, onRuns, signal) =>
      new Promise((_r, reject) => {
        onRuns([done.runs[0]!]);
        signal.addEventListener('abort', () => reject(new Error('stopped')));
      });
    const session2 = new EditorSession<FactoryDocument>(session.content);
    const c2 = new FactoryController({
      session: session2,
      canEdit: () => true,
      experimentRunner: half,
    });
    const p = c2.runExperiment();
    expect(c2.state.experimenting).toBe(true);
    expect(await c2.runExperiment()).toBe('running');
    expect(c2.state.experiment!.runs).toHaveLength(1);
    c2.stopExperiment();
    expect(await p).toBe('stopped');
    expect(c2.state).toMatchObject({ experimenting: false, notice: { code: 'stopped' } });
    expect(c2.state.experiment).toMatchObject({ done: false, total: 4 });
    expect(c2.state.experiment!.runs).toHaveLength(1);

    // An experiment refused by the runner shows its code.
    const refusing: FactoryExperimentRunner = async () => {
      throw new FactoryValidationError('event-limit', 'too many');
    };
    const c3 = new FactoryController({
      session: session2,
      canEdit: () => true,
      experimentRunner: refusing,
    });
    expect(await c3.runExperiment()).toBe('event-limit');
    expect(c3.state.experimenting).toBe(false);
  });
});
