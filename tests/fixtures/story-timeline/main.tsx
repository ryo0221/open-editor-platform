/**
 * Story Timeline T1b E2E fixture: the public StoryTimelineHost over an in-memory F0 with a
 * read that can be held (TL32 delayed load) and fail when released, an optional unreadable
 * set (§6.4), and `?variant=review`: a changed parent draft, a filtering saved view on the
 * parent ledger and a child world on another clock (`CL-2 = CL-1 + 100`). `?variant=transfer`
 * writes time derivations and a world transfer into F0 the way F2 does (EV-102 from EV-101,
 * EV-202 from A's EV-103, CH-002 carried from A's EV-103 to B's EV-202), saved as fixture-v2
 * and inherited by world B (EV-102) and a world C under B (EV-202) (`&noworlds=1` then drops
 * the world lines, keeping the transfer), and `?shared=1`
 * asks for a shared reading, which the Host refuses (TL29b). `?variant=design` moves SC-001's
 * first region to a saved panel of a Design manuscript, for the Design trip (TL20).
 * `?variant=later` adds a tl2 column to ledger B and a ranged clock conversion to the world
 * (TL23, TL29c); `?variant=limit` gives ledgers A and B 600 events each, within each table's
 * limit but over the projection's (TL30a). `?edit=1` opens the editing workbench over the same
 * store (T2-2); `&readonly=<id>` makes that owner read-only, and `__timeline.setEditable`
 * changes it while the screen is open (TL18e, TL20).
 */
import { Fragment, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { contentHash, type Artifact } from '@editor-platform/artifact-core';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';
import {
  buildF0Sample,
  StoryTimelineHost,
  TimelineWorkbench,
  moveOccurrence,
} from '@editor-platform/reference-artifact-host/creative/workspace';

declare global {
  interface Window {
    __timeline: {
      holdNext(id: string, fail?: boolean): void;
      inspect(id: string): string;
      save(id: string): Promise<{ ok: boolean }>;
      history(direction: 'undo' | 'redo'): { ok: boolean };
      flush(): { ok: boolean };
      holdSave(fail?: boolean): void;
      pendingSaves(): number;
      move(order: number, part: string): void;
      holdValidation(): void;
      pendingValidation(): number;
      drafts(): string;
      release(): void;
      reads: string[];
      /** Revokes read permission; `mayRead` stays the same function, the epoch is bumped. */
      revoke(id: string): void;
      grant(id: string): void;
      /** Changes a saved version's content after the reading, leaving its stored hash. */
      corrupt(id: string): void;
      /** Every stored artifact, canonical, to prove nothing was written. */
      snapshot(): string;
      /** `?edit=1`: whether an owner may be changed from now on. */
      setEditable(id: string, editable: boolean): void;
    };
  }
}
void (async () => {
  const params = new URLSearchParams(location.search);
  const { artifacts, links } = await buildF0Sample();
  const store = new Map(artifacts.map((a) => [a.id, a] as [string, Artifact<unknown>]));
  const shared = params.get('shared') === '1';
  const unreadable = new Set(params.getAll('unreadable'));
  if (params.get('variant') === 'review') {
    const ledger = store.get('story-ledger-A')!.draft.content as StructuredData;
    ledger.rows.find((r) => r.id === 'EV-002')!.values['tl1.label'] = '暗号文S1が作られる（改稿）';
    // The ledger's first saved view hides EV-002: the source trip must still show the row.
    const view = defaultView(ledger);
    view.filters = [{ id: 'f1', columnId: 'tl1.label', operator: 'equals', value: '王の即位' }];
    ledger.views = [view];
    const world = store.get('world-S')!.draft.content as StructuredData;
    const clock = world.rows.find((r) => r.id === 'CL-1')!;
    world.rows.find((r) => r.id === 'WL-B')!.values['tl1.clock'] = 'CL-2';
    world.rows.push(
      { ...structuredClone(clock), id: 'CL-2' },
      {
        id: 'OFF-1',
        values: {
          'tl1.row': 'clock-offset',
          'tl1.clock': 'CL-1',
          'tl1.clock2': 'CL-2',
          'tl1.offset.min': 100,
          'tl1.offset.max': 100,
        },
      },
    );
  }
  const variant = params.get('variant');
  if (variant === 'clock-exception') {
    const ledger = store.get('story-ledger-A')!.draft.content as StructuredData;
    Object.assign(ledger.rows.find((r) => r.id === 'EV-101')!.values, {
      'tl1.time.kind': 'point',
      'tl1.time.start': 1,
      'tl1.clock': 'CL-1',
    });
    Object.assign(ledger.rows.find((r) => r.id === 'EV-102')!.values, {
      'tl1.time.kind': 'point',
      'tl1.time.start': 2,
      'tl1.clock': 'CL-other',
    });
    ledger.rows.push({
      id: 'clock-constraint',
      values: { 'tl1.row': 'after', 'tl1.subject': 'EV-101', 'tl1.ref.item': 'EV-102' },
    });
    (store.get('world-S')!.draft.content as StructuredData).rows.push({
      id: 'CL-other',
      values: { 'tl1.row': 'clock', 'tl1.label': 'other' },
    });
  }
  if (variant === 'time-constraints') {
    const data = store.get('story-ledger-A')!.draft.content as StructuredData;
    data.rows.push(
      {
        id: 'after-sample',
        values: { 'tl1.row': 'after', 'tl1.subject': 'EV-104', 'tl1.ref.item': 'EV-101' },
      },
      {
        id: 'travel-sample',
        values: {
          'tl1.row': 'travel-min',
          'tl1.subject': 'EV-104',
          'tl1.ref.item': 'EV-102',
          'tl1.offset.min': 2,
          'tl1.ind.ch': 'CH-002',
          'tl1.ind.origin': 'WL-A',
        },
      },
    );
  }

  if (variant === 'transfer') {
    const content = (id: string) => store.get(id)!.draft.content as StructuredData;
    const hash = (id: string) => store.get(id)!.versions[0].contentHash;
    const row = (id: string, rowId: string, values: Record<string, unknown>) => {
      const c = content(id);
      c.rows.push({
        id: rowId,
        values: { ...Object.fromEntries(c.columns.map((k) => [k.id, null])), ...values },
      } as never);
    };
    const derive = (id: string, ev: string) =>
      Object.assign(content(id).rows.find((r) => r.id === ev)!.values, {
        'tl1.time.kind': 'derived',
        'tl1.time.start': null,
      });
    const refA = {
      'tl1.ref.artifact': 'story-ledger-A',
      'tl1.ref.version': 'fixture-v1',
      'tl1.ref.hash': hash('story-ledger-A'),
      'tl1.ref.item': 'EV-103',
    };
    derive('story-ledger-A', 'EV-102');
    row('story-ledger-A', 'EV-102.derive', {
      'tl1.row': 'derive-time',
      'tl1.subject': 'EV-102',
      'tl1.ref.item': 'EV-101',
      'tl1.anchor': 'start',
      'tl1.offset.min': 1,
      'tl1.offset.max': 1,
    });
    derive('story-ledger-B', 'EV-202');
    row('story-ledger-B', 'EV-202.derive', {
      'tl1.row': 'derive-time',
      'tl1.subject': 'EV-202',
      ...refA,
      'tl1.ref.facet': 'time',
      'tl1.anchor': 'start',
      'tl1.offset.min': 1,
      'tl1.offset.max': 1,
    });
    row('world-S', 'TR-001', {
      'tl1.row': 'transfer',
      'tl1.label': '密使がS1をBへ運ぶ',
      'tl1.ind.ch': 'CH-002',
      'tl1.ind.origin': 'WL-A',
      ...refA,
      'tl1.ref2.artifact': 'story-ledger-B',
      'tl1.ref2.version': 'fixture-v1',
      'tl1.ref2.hash': hash('story-ledger-B'),
      'tl1.ref2.item': 'EV-202',
    });
    row('world-S', 'TR-001.carries.S1', {
      'tl1.row': 'transfer-info',
      'tl1.subject': 'TR-001',
      'tl1.info': 'S1',
    });
    // Both ledgers save the derivations as fixture-v2. World B inherits A's derived EV-102 and
    // a world C branched from B inherits B's derived EV-202 at that version (Ryo #651 P2).
    const v2: Record<string, string> = {};
    for (const id of ['story-ledger-A', 'story-ledger-B']) {
      const a = store.get(id)!;
      const saved = structuredClone(a.draft.content);
      v2[id] = await contentHash(saved);
      a.versions.push({
        ...structuredClone(a.versions[0]),
        versionId: 'fixture-v2',
        parentVersionId: 'fixture-v1',
        content: saved,
        contentHash: v2[id],
      });
      a.draft.baseVersionId = 'fixture-v2';
    }
    const wlB = content('world-S').rows.find((r) => r.id === 'WL-B')!;
    content('world-S').rows.splice(content('world-S').rows.indexOf(wlB) + 1, 0, {
      id: 'WL-C',
      values: {
        ...structuredClone(wlB.values),
        'tl1.label': '世界C',
        'tl1.world.parent': 'WL-B',
        'tl1.time.start': 5,
      },
    });
    for (const [world, owner, item] of [
      ['WL-B', 'story-ledger-A', 'EV-102'],
      ['WL-C', 'story-ledger-B', 'EV-202'],
    ])
      row('world-S', `${world}.inherit.${item}`, {
        'tl1.row': 'inherits',
        'tl1.subject': world,
        'tl1.ref.artifact': owner,
        'tl1.ref.version': 'fixture-v2',
        'tl1.ref.hash': v2[owner],
        'tl1.ref.item': item,
      });
  }
  if (variant === 'later') {
    const ledger = store.get('story-ledger-B')!.draft.content as StructuredData;
    ledger.columns.push({ id: 'tl2.minute', name: '分', type: 'number' } as never);
    const world = store.get('world-S')!.draft.content as StructuredData;
    const clock = world.rows.find((r) => r.id === 'CL-1')!;
    world.rows.push(
      { ...structuredClone(clock), id: 'CL-2' },
      {
        id: 'OFF-1',
        values: {
          'tl1.row': 'clock-offset',
          'tl1.clock': 'CL-1',
          'tl1.clock2': 'CL-2',
          'tl1.offset.min': 100,
          'tl1.offset.max': 120,
        },
      },
    );
  }
  if (variant === 'limit')
    for (const [id, ev] of [
      ['story-ledger-A', 'EV-101'],
      ['story-ledger-B', 'EV-201'],
    ]) {
      const ledger = store.get(id)!.draft.content as StructuredData;
      const base = ledger.rows.find((r) => r.id === ev)!;
      const add = 600 - ledger.rows.filter((r) => r.values['tl1.row'] === 'event').length;
      for (let i = 0; i < add; i++)
        ledger.rows.push({ ...structuredClone(base), id: `${ev}-x${i}` });
    }
  if (variant === 'design') {
    const content = {
      ...createDesign(),
      elements: [
        {
          ...makeDesignElement('frame'),
          id: 'panel-sc001',
          name: 'コマ1',
          bounds: { x: 0, y: 0, width: 320, height: 200 },
        },
      ],
    };
    const at = '2026-11-01T00:00:00.000Z';
    store.set('comic-ch01', {
      schemaVersion: 1,
      id: 'comic-ch01',
      name: '第1話の絵',
      kind: 'design',
      draft: { content: structuredClone(content), baseVersionId: 'fixture-v1', updatedAt: at },
      versions: [
        {
          artifactId: 'comic-ch01',
          versionId: 'fixture-v1',
          parentVersionId: null,
          schemaVersion: 1,
          content,
          contentHash: await contentHash(content),
          createdAt: at,
          createdBy: null,
          reason: 'Story Timeline E2E',
        },
      ],
      provenance: { source: 'created' },
    } as unknown as Artifact<unknown>);
    const origin = { artifactId: 'comic-ch01', versionId: 'fixture-v1', elementId: 'panel-sc001' };
    const scene = links.scenes.find((s) => s.id === 'region-ch01-sc001')!;
    Object.assign(scene, { kind: 'design', origin });
    for (const l of links.occurrenceLinks)
      for (const g of l.regions) if (g.sceneId === scene.id) g.address = { ...origin };
  }
  // `&noworlds=1`: the world settings keep their transfer but have no world line (Ryo #651 P3).
  if (params.get('noworlds') === '1') {
    const world = store.get('world-S')!.draft.content as StructuredData;
    world.rows = world.rows.filter(
      (r) => !['worldline', 'inherits'].includes(r.values['tl1.row'] as string),
    );
  }
  if (params.has('facet')) {
    const c = store.get('scene-cards-A')!.draft.content as StructuredData;
    const row = c.rows.find((r) => r.id === 'SC-005.cite.ev')!;
    row.values['tl1.ref.facet'] = params.get('facet')!;
    row.values['tl1.info'] = 'S1';
  }
  let holdPut = false,
    failPut = false,
    pendingSaves = 0;
  let hold: string | undefined;
  let holdFails = false;
  let held: (() => void)[] = [];
  let holdValidation = false;
  let pendingValidation = 0;
  const control = {
    inspect(id: string) {
      const o = workbench?.owner(id);
      return JSON.stringify(
        o && {
          content: o.editor.content,
          revision: o.editor.revision,
          undo: o.editor.canUndo,
          redo: o.editor.canRedo,
        },
      );
    },
    save(id: string) {
      return workbench!.save(id);
    },
    history(direction: 'undo' | 'redo') {
      return workbench!.history(direction);
    },
    flush() {
      return workbench!.flushInputs();
    },
    holdSave(fail = false) {
      holdPut = true;
      failPut = fail;
    },
    pendingSaves() {
      return pendingSaves;
    },
    move(order: number, part: string) {
      const v = workbench!.rows('composition-S').find((r) => r.id === 'OC-005')!.values;
      const result = workbench!.run('composition-S', () =>
        moveOccurrence(
          'OC-005',
          { order, part },
          { order: Number(v['tl1.order']), part: String(v['tl1.part']) },
        ),
      );
      if (!result.ok) throw Error(result.message);
    },
    pendingValidation() {
      return pendingValidation;
    },
    holdValidation() {
      holdValidation = true;
    },
    drafts() {
      return JSON.stringify(workbench?.ownersOf('composition').map((o) => o.editor.content));
    },
    reads: [] as string[],
    holdNext(id: string, fail = false) {
      hold = id;
      holdFails = fail;
    },
    release() {
      const h = held;
      held = [];
      h.forEach((r) => r());
    },
    revoke(id: string) {
      unreadable.add(id);
      workbench?.invalidate();
      epoch++;
      render();
    },
    grant(id: string) {
      unreadable.delete(id);
      workbench?.invalidate();
      epoch++;
      render();
    },
    snapshot() {
      return JSON.stringify([...store].sort(([a], [b]) => a.localeCompare(b)));
    },
    corrupt(id: string) {
      const v = store.get(id)!.versions[0];
      v.content = { ...(v.content as object), title: '書き換えた原稿' };
    },
    setEditable(id: string, editable: boolean) {
      if (editable) readonly.delete(id);
      else readonly.add(id);
      epoch++;
      workbench?.invalidate();
      render();
    },
  };
  const readonly = new Set(params.getAll('readonly'));
  window.__timeline = control;
  const source = {
    async get(id: string) {
      control.reads.push(id);
      if (hold === id) {
        hold = undefined;
        const fail = holdFails;
        await new Promise<void>((r) => held.push(r));
        if (fail) throw Error('保存先の読込に失敗しました（試験）。');
      }
      return structuredClone(store.get(id));
    },
  };
  const root = createRoot(document.getElementById('root')!);
  const mayRead = (id: string) => !unreadable.has(id);
  let epoch = 0;
  const workbench =
    params.get('edit') === '1'
      ? await TimelineWorkbench.open(
          {
            get: source.get,
            async put(a: Artifact<unknown>) {
              pendingSaves++;
              try {
                if (holdPut) {
                  holdPut = false;
                  await new Promise<void>((r) => held.push(r));
                  if (failPut) throw Error('private save error');
                }
                store.set(a.id, structuredClone(a));
              } finally {
                pendingSaves--;
              }
            },
          },
          links,
          { mayRead, mayEdit: (id) => !readonly.has(id) },
        )
      : undefined;
  if (workbench) {
    const prepareTime = workbench.prepareTimeEdit.bind(workbench);
    workbench.prepareTimeEdit = (owner, event, build, signal) =>
      prepareTime(
        owner,
        event,
        async () => {
          if (holdValidation) {
            holdValidation = false;
            pendingValidation++;
            try {
              await new Promise<void>((resolve) => held.push(resolve));
            } finally {
              pendingValidation--;
            }
          }
          return build();
        },
        signal,
      );
    const verify = workbench.verify.bind(workbench);
    workbench.verify = async (rows) => {
      pendingValidation++;
      try {
        if (holdValidation) {
          holdValidation = false;
          await new Promise<void>((r) => held.push(r));
        }
        return await verify(rows);
      } finally {
        pendingValidation--;
      }
    };
  }
  const Boundary = params.get('strict') === '1' ? StrictMode : Fragment;
  const render = () =>
    root.render(
      <Boundary>
        <StoryTimelineHost
          source={source}
          links={links}
          mayRead={mayRead}
          permissionEpoch={epoch}
          shared={shared}
          analysisCapabilities={{
            t3a: true,
            t3b: params.get('t3b') !== '0',
            readingPremise: false,
            shared: false,
          }}
          workbench={workbench}
        />
      </Boundary>,
    );
  render();
})();
