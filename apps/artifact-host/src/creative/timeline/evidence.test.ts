import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MemoryStorage, canonicalJson, type Artifact } from '@editor-platform/artifact-core';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import { TimelineWorkbench } from './workbench';
import { insertRows, setTime, setCells, timelineCommand, type TimelineTimeInput } from './commands';
import { readTimelineTable } from './table';
import { rowTimeValue } from './time';
import { setClockOffset } from './clock-command';
import { TimelineAnalysisContext, captureTimelineCandidate } from './analysis-context';
import { TimelineAnalysisHost } from './analysis-host';
import { setTransfer, setExperience, storyGroup } from './story-commands';
import { TimelineSemanticResolver } from './analysis-semantics';
import {
  TimelineExceptionRecorder,
  diagnosticExceptionInput,
  readTimelineException,
  matchTimelineException,
  type TimelineExceptionInput,
} from './analysis-exceptions';

async function fixture(file = 'f0') {
  const data = JSON.parse(
    readFileSync(
      new URL('../../../../../docs/story-timeline/fixtures/' + file + '.json', import.meta.url),
      'utf8',
    ),
  ) as { artifacts: Artifact<StructuredData>[]; links: CreativeWorkspaceLinksV2 };
  const storage = new MemoryStorage<Artifact<unknown>>();
  for (const artifact of data.artifacts) await storage.put(artifact);
  const hidden = new Set<string>();
  const open = () =>
    TimelineWorkbench.open(storage, data.links, {
      mayRead: (id) => !hidden.has(id),
      mayEdit: () => true,
    });
  return { storage, hidden, open, w: await open() };
}
async function presenceFixture() {
  const f = await fixture();
  expect(
    f.w.run('world-S', () =>
      insertRows('world', [
        ...['CL-P', 'CL-Q'].map((id) => ({ id, values: { 'tl1.row': 'clock', 'tl1.label': id } })),
        {
          id: 'places-exclusive',
          values: { 'tl1.row': 'location-exclusive', 'tl1.loc': 'LO-1', 'tl1.loc2': 'LO-2' },
        },
      ]),
    ),
  ).toEqual({ ok: true });
  await f.w.save('world-S');
  for (const [item, clock] of [
    ['EV-001', 'CL-P'],
    ['EV-002', 'CL-Q'],
  ] as const) {
    const table = readTimelineTable('ledger', f.w.owner('story-ledger-A')!.editor.content);
    if (table.state !== 'valid') throw Error('fixture ledger');
    const expected = rowTimeValue(
      table.rows.find((r) => r.id === item)!.cells,
    ) as TimelineTimeInput;
    const command = await f.w.prepareTimeEdit(
      'story-ledger-A',
      item,
      () => setTime(item, { kind: 'point', start: 2, clock }, expected),
      new AbortController().signal,
    );
    expect(f.w.run('story-ledger-A', () => command)).toEqual({ ok: true });
  }
  expect(
    f.w.run('story-ledger-A', () =>
      insertRows(
        'ledger',
        ['EV-001', 'EV-002'].map((id, i) => ({
          id: 'presence-' + i,
          values: {
            'tl1.row': 'presence',
            'tl1.subject': id,
            'tl1.ind.ch': 'CH-001',
            'tl1.ind.origin': 'WL-A',
            'tl1.loc': i ? 'LO-2' : 'LO-1',
            'tl1.certainty': 'confirmed',
            'tl1.time.kind': 'interval',
            'tl1.time.start': 2,
            'tl1.time.end': 4,
          },
        })),
      ),
    ),
  ).toEqual({ ok: true });
  await f.w.save('story-ledger-A');
  return f;
}
const presence = async (w: TimelineWorkbench) =>
  (
    await new TimelineSemanticResolver(await TimelineAnalysisContext.create(w)).evaluate()
  ).diagnostics.find((d) => d.kind === 'presence')!;
async function persistException(w: TimelineWorkbench, input: TimelineExceptionInput) {
  const recorder = new TimelineExceptionRecorder(w);
  const saved = recorder.commit(await recorder.prepare(input, new AbortController().signal));
  await w.save(saved.owner);
  return saved;
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>, w: TimelineWorkbench) {
  return canonicalJson({
    stored: await f.storage.list(),
    undo: w.undoState,
    owners: (['ledger', 'world', 'composition', 'scene-cards'] as const)
      .flatMap((role) => w.ownersOf(role))
      .map((o) => ({
        id: o.id,
        revision: o.editor.revision,
        content: o.editor.content,
        artifact: o.editor.artifact,
      })),
  });
}

it('EG02: explicit presence clocks survive exception save/reopen and recheck a new zero-offset mapping', async () => {
  const f = await presenceFixture();
  const first = await presence(f.w);
  expect(first.state).toBe('insufficient');
  const saved = await persistException(
    f.w,
    diagnosticExceptionInput('story-S', first, 'intentional overlap'),
  );
  const w = await f.open(),
    record = readTimelineException(w, saved.owner, saved.id)!;
  const audit = canonicalJson(record);
  const before = await snapshot(f, w);
  expect(
    await matchTimelineException(
      w,
      record,
      diagnosticExceptionInput('story-S', await presence(w), ''),
    ),
  ).toBe('applies');
  expect(await snapshot(f, w)).toBe(before);
  expect(w.run('world-S', () => setClockOffset('presence-mapping', 'CL-P', 'CL-Q', 0))).toEqual({
    ok: true,
  });
  await w.save('world-S');
  const immutable = await snapshot(f, w),
    next = await presence(w);
  expect(next.state).toBe('contradiction');
  expect(
    await matchTimelineException(w, record, diagnosticExceptionInput('story-S', next, '')),
  ).toBe('recheck');
  expect(await snapshot(f, w)).toBe(immutable);
  expect(canonicalJson(readTimelineException(w, saved.owner, saved.id))).toBe(audit);
  const ids = next.basis.map((b) => b.exact.item);
  for (const id of ['EV-001', 'EV-002', 'CL-1', 'CL-P', 'CL-Q', 'presence-mapping'])
    expect(ids).toContain(id);
  expect(new Set(next.basis.map((b) => canonicalJson(b.exact))).size).toBe(next.basis.length);
});

it('EG02/EG03: pre-E1 presence evidence rechecks without rewriting, reconfirmed evidence survives save/reopen', async () => {
  const f = await presenceFixture(),
    first = await presence(f.w);
  const legacy = diagnosticExceptionInput('story-S', first, 'legacy exception');
  legacy.basis = legacy.basis.filter(
    (ref) => !['EV-001', 'EV-002', 'CL-P', 'CL-Q'].includes(ref.item),
  );
  const saved = await persistException(f.w, legacy),
    w = await f.open();
  const original = readTimelineException(w, saved.owner, saved.id)!;
  const before = await snapshot(f, w),
    current = await presence(w);
  expect(
    await matchTimelineException(w, original, diagnosticExceptionInput('story-S', current, '')),
  ).toBe('recheck');
  expect(await snapshot(f, w)).toBe(before);
  const confirmed = await persistException(
    w,
    diagnosticExceptionInput('story-S', current, 'author reconfirmed new evidence'),
  );
  const reopened = await f.open(),
    record = readTimelineException(reopened, confirmed.owner, confirmed.id)!;
  expect(readTimelineException(reopened, saved.owner, saved.id)).toEqual(original);
  const clean = await snapshot(f, reopened);
  expect(
    await matchTimelineException(
      reopened,
      record,
      diagnosticExceptionInput('story-S', await presence(reopened), ''),
    ),
  ).toBe('applies');
  expect(await snapshot(f, reopened)).toBe(clean);
  expect(reopened.run('world-S', () => setClockOffset('new-mapping', 'CL-P', 'CL-Q', 0))).toEqual({
    ok: true,
  });
  await reopened.save('world-S');
  expect(
    await matchTimelineException(
      reopened,
      record,
      diagnosticExceptionInput('story-S', await presence(reopened), ''),
    ),
  ).toBe('recheck');
  expect(readTimelineException(reopened, saved.owner, saved.id)).toEqual(original);
});

it.each(['add', 'remove', 'replace'] as const)(
  'EG04 D1: %s used transfer evidence rechecks even with the same verdict',
  async (change) => {
    const f = await fixture('f2');
    const original = storyGroup(f.w.owner('world-S')!.editor.content, 'TR-001');
    const remove = async (w: TimelineWorkbench) => {
      const group = storyGroup(w.owner('world-S')!.editor.content, 'TR-001');
      const command = await w.prepareStoryEdit(
        'world-S',
        'remove-transfer',
        () => setTransfer('TR-001', undefined, group),
        new AbortController().signal,
      );
      expect(w.run('world-S', () => command)).toEqual({ ok: true });
      await w.save('world-S');
    };
    if (change === 'add') await remove(f.w);
    const run = async (w: TimelineWorkbench) =>
      (
        await new TimelineSemanticResolver(await TimelineAnalysisContext.create(w)).evaluate()
      ).diagnostics.find((d) => d.site === 'story-ledger-B#EV-205.use.S2')!;
    const first = await run(f.w),
      saved = await persistException(
        f.w,
        diagnosticExceptionInput('story-S', first, 'intentional use'),
      );
    const w = await f.open(),
      record = readTimelineException(w, saved.owner, saved.id)!;
    expect(
      await matchTimelineException(
        w,
        record,
        diagnosticExceptionInput('story-S', await run(w), ''),
      ),
    ).toBe('applies');
    if (change !== 'add') await remove(w);
    if (change !== 'remove') {
      const id = 'TR-new';
      const rows = await w.verify(
        original.map((r) => ({
          id: r.id.replace('TR-001', id),
          values: { ...r.values, ...(r.id === 'TR-001' ? {} : { 'tl1.subject': id }) },
        })),
      );
      const command = await w.prepareStoryEdit(
        'world-S',
        'new-transfer',
        () => setTransfer(id, rows, []),
        new AbortController().signal,
      );
      expect(w.run('world-S', () => command)).toEqual({ ok: true });
      await w.save('world-S');
    }
    const before = await snapshot(f, w),
      changed = await run(w);
    expect(changed.state).toBe(first.state);
    expect(
      await matchTimelineException(w, record, diagnosticExceptionInput('story-S', changed, '')),
    ).toBe('recheck');
    expect(await snapshot(f, w)).toBe(before);
  },
);

it('EG04 D4: a conversion used inside a derivation is exception evidence', async () => {
  const f = await fixture('f2');
  expect(
    f.w.run('world-S', () =>
      insertRows('world', [
        { id: 'CL-source', values: { 'tl1.row': 'clock', 'tl1.label': 'source' } },
      ]),
    ),
  ).toEqual({ ok: true });
  expect(
    f.w.run('world-S', () => setClockOffset('derived-mapping', 'CL-source', 'CL-1', 0)),
  ).toEqual({ ok: true });
  await f.w.save('world-S');
  for (const [item, start, clock] of [
    ['EV-101', 2, 'CL-source'],
    ['EV-104', 6, 'CL-1'],
  ] as const) {
    const table = readTimelineTable('ledger', f.w.owner('story-ledger-A')!.editor.content);
    if (table.state !== 'valid') throw Error('fixture ledger');
    const old = rowTimeValue(table.rows.find((r) => r.id === item)!.cells) as TimelineTimeInput;
    const command = await f.w.prepareTimeEdit(
      'story-ledger-A',
      item,
      () => setTime(item, { kind: 'point', start, clock }, old),
      new AbortController().signal,
    );
    expect(f.w.run('story-ledger-A', () => command)).toEqual({ ok: true });
  }
  expect(
    f.w.run('story-ledger-A', () =>
      insertRows('ledger', [
        {
          id: 'after-derived',
          values: { 'tl1.row': 'after', 'tl1.subject': 'EV-104', 'tl1.ref.item': 'EV-103' },
        },
      ]),
    ),
  ).toEqual({ ok: true });
  await f.w.save('story-ledger-A');
  const run = async (w: TimelineWorkbench) =>
    (
      await new TimelineSemanticResolver(await TimelineAnalysisContext.create(w)).evaluate()
    ).diagnostics.find((d) => d.site === 'story-ledger-A#after-derived')!;
  const first = await run(f.w);
  expect(first.state).toBe('satisfied');
  const saved = await persistException(
    f.w,
    diagnosticExceptionInput('story-S', first, 'intentional timing'),
  );
  const w = await f.open(),
    record = readTimelineException(w, saved.owner, saved.id)!;
  expect(
    await matchTimelineException(w, record, diagnosticExceptionInput('story-S', await run(w), '')),
  ).toBe('applies');
  const previous = w.rows('world-S').find((r) => r.id === 'derived-mapping')!;
  expect(
    w.run('world-S', () => setClockOffset(previous.id, 'CL-source', 'CL-1', 3, previous)),
  ).toEqual({ ok: true });
  await w.save('world-S');
  const before = await snapshot(f, w),
    next = await run(w);
  expect(next.state).toBe('contradiction');
  expect(
    await matchTimelineException(w, record, diagnosticExceptionInput('story-S', next, '')),
  ).toBe('recheck');
  expect(await snapshot(f, w)).toBe(before);
});

it('EG09: matching discards a result after a relevant owner revision changes during exact reads', async () => {
  const f = await presenceFixture(),
    first = await presence(f.w);
  const saved = await persistException(
    f.w,
    diagnosticExceptionInput('story-S', first, 'intentional presence'),
  );
  const w = await f.open(),
    record = readTimelineException(w, saved.owner, saved.id)!,
    current = diagnosticExceptionInput('story-S', await presence(w), '');
  const get = w.source.get;
  let changed = false;
  w.source.get = async (id) => {
    const value = await get(id);
    if (!changed) {
      changed = true;
      const old = w.rows('story-ledger-A').find((r) => r.id === 'EV-001')!.values;
      expect(
        w.run('story-ledger-A', () =>
          setCells(
            'ledger',
            'EV-001',
            { 'tl1.label': 'changed during validation' },
            { 'tl1.label': old['tl1.label'] },
          ),
        ),
      ).toEqual({ ok: true });
    }
    return value;
  };
  try {
    expect(await matchTimelineException(w, record, current)).toBe('recheck');
  } finally {
    w.source.get = get;
  }
  expect(changed).toBe(true);
  expect(readTimelineException(w, saved.owner, saved.id)).toEqual(record);
});

it.each([false, true])(
  'EG08: conditional fixed point is independent of relation order reversed=%s',
  async (reverse) => {
    const f = await fixture('f2');
    const group = storyGroup(f.w.owner('world-S')!.editor.content, 'TR-001');
    const remove = await f.w.prepareStoryEdit(
      'world-S',
      'remove-carrier',
      () => setTransfer('TR-001', undefined, group),
      new AbortController().signal,
    );
    expect(f.w.run('world-S', () => remove)).toEqual({ ok: true });
    await f.w.save('world-S');
    if (reverse) {
      expect(
        f.w.run('story-ledger-B', () =>
          timelineCommand('ledger', 'timeline.fixture', 'reorder relations', (d) => {
            d.rows = [
              ...d.rows.filter((r) => r.id !== 'EV-204.derive'),
              ...d.rows.filter((r) => r.id === 'EV-204.derive'),
            ];
          }),
        ),
      ).toEqual({ ok: true });
      await f.w.save('story-ledger-B');
    }
    const oldDerivation = f.w.rows('story-ledger-B').find((r) => r.id === 'EV-204.derive')!;
    const explicit = await f.w.prepareTimeEdit(
      'story-ledger-B',
      'EV-204',
      () => setTime('EV-204', { kind: 'day', start: 6 }, { kind: 'derived' }, oldDerivation),
      new AbortController().signal,
    );
    expect(f.w.run('story-ledger-B', () => explicit)).toEqual({ ok: true });
    expect(
      f.w.run('story-ledger-A', () =>
        setTime('EV-101', { kind: 'day', start: 4 }, { kind: 'day', start: 2 }),
      ),
    ).toEqual({ ok: true });
    const a = await captureTimelineCandidate(f.w, 'story-ledger-A', 'A'),
      b = await captureTimelineCandidate(f.w, 'story-ledger-B', 'B');
    const before = await snapshot(f, f.w);
    const result = await new TimelineAnalysisHost(f.w).analyze({
      candidates: [a, b],
      roots: { 'story-ledger-A': 'A', 'story-ledger-B': 'B' },
    });
    for (const site of ['story-ledger-B#EV-205.use.S2', 'scene-cards-B#SC-006.cite.ev'])
      expect(result.recheck.sites.find((s) => s.site === site)).toMatchObject({
        classification: 'conditional',
        state: 'unevaluated',
      });
    expect(
      result.recheck.sites.find((s) => s.site === 'scene-cards-B#SC-006.cite.ev')!.destinations,
    ).toEqual([{ occurrence: 'composition-S#OC-007', links: ['OL-004'] }]);
    expect(await snapshot(f, f.w)).toBe(before);
  },
);

it('EG03 D2: independent experience exception survives world save/reopen, then rechecks an explicit repin', async () => {
  const f = await fixture('f2');
  const setArrival = async (w: TimelineWorkbench, start: number, old: TimelineTimeInput) => {
    const relation = w.rows('story-ledger-B').find((r) => r.id === 'EV-204.derive');
    const command = await w.prepareTimeEdit(
      'story-ledger-B',
      'EV-204',
      () => setTime('EV-204', { kind: 'point', start }, old, relation),
      new AbortController().signal,
    );
    expect(w.run('story-ledger-B', () => command)).toEqual({ ok: true });
    await w.save('story-ledger-B');
    const group = storyGroup(w.owner('composition-S')!.editor.content, 'XP-001');
    const second = Object.fromEntries(
      Object.entries(w.savedRef('story-ledger-B', 'EV-204')!).map(([k, v]) => [
        k.replace('tl1.ref.', 'tl1.ref2.'),
        v,
      ]),
    );
    const verified = await w.verify(
      group.map((r) => ({ id: r.id, values: { ...r.values, ...second } })),
    );
    const repin = await w.prepareStoryEdit(
      'composition-S',
      'xp-arrival',
      () => setExperience('XP-001', verified, group),
      new AbortController().signal,
    );
    expect(w.run('composition-S', () => repin)).toEqual({ ok: true });
    await w.save('composition-S');
  };
  await setArrival(f.w, 1, { kind: 'derived' });
  const run = async (w: TimelineWorkbench) =>
    (
      await new TimelineSemanticResolver(await TimelineAnalysisContext.create(w)).evaluate()
    ).diagnostics.find((d) => d.site === 'composition-S#XP-001')!;
  const first = await run(f.w);
  expect(first.state).toBe('unsupported');
  const saved = await persistException(
    f.w,
    diagnosticExceptionInput('story-S', first, 'intentional experience'),
  );
  expect(saved.owner).toBe('world-S');
  const w = await f.open(),
    record = readTimelineException(w, saved.owner, saved.id)!;
  const before = await snapshot(f, w);
  expect(
    await matchTimelineException(w, record, diagnosticExceptionInput('story-S', await run(w), '')),
  ).toBe('applies');
  expect(await snapshot(f, w)).toBe(before);
  await setArrival(w, 2, { kind: 'point', start: 1 });
  const changed = await run(w);
  expect(changed.state).toBe('unsupported');
  const stable = await snapshot(f, w);
  expect(
    await matchTimelineException(w, record, diagnosticExceptionInput('story-S', changed, '')),
  ).toBe('recheck');
  expect(await snapshot(f, w)).toBe(stable);
  expect(readTimelineException(w, saved.owner, saved.id)).toEqual(record);
});
