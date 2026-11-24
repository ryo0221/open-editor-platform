/**
 * AR2：Playground の架空の ItemReferenceHost。同じ Library の保存した Fishbone から候補を出し、選んだ版を保存の証跡で基準にし、
 * 引用先の保存版が変わると stale を返す。証跡の無い・消費済み・期限切れの選択は基準にならない。
 */
import { describe, expect, it } from 'vitest';
import { clone } from '@editor-platform/artifact-core';
import { ItemSelectionLedger } from '@editor-platform/artifact-references/items';
import { setRowRefs } from '@editor-platform/structured-data/model';
import type { GraphDocument } from '@editor-platform/structured-graph/model';
import { createFishboneGraph } from './analysis-graph-templates';
import { createFmeaData } from './fmea-templates';
import { playgroundItemHost, refOccurrences } from './item-reference-host';
import type { StoredArtifact } from '../model';

const signal = new AbortController().signal;
const fishbone = (name = '接点の溶着'): GraphDocument => {
  const g = createFishboneGraph();
  const causes = g.nodes.filter((n) => n.type === 'cause');
  causes[0]!.attributes = { ...causes[0]!.attributes, itemId: 'CC-01', name };
  causes[1]!.attributes = { ...causes[1]!.attributes, itemId: 'CC-02' };
  return g;
};
const record = (id: string, name: string, content: unknown, n = 1): StoredArtifact =>
  ({
    id,
    name,
    kind: 'graph',
    versions: Array.from({ length: n }, (_, i) => ({
      versionId: `${id}-v${i + 1}`,
      contentHash: `h${i + 1}`,
      content,
    })),
  }) as unknown as StoredArtifact;
const fmea = () => {
  const d = createFmeaData('dfmea');
  d.rows[0]!.values = { ...d.rows[0]!.values, fcId: 'FC-01', fmId: 'FM-01' };
  return d;
};

function setup() {
  let clock = 0;
  const saved = {
    current: new Map<string, StoredArtifact>([['fish', record('fish', '特性要因図', fishbone())]]),
  };
  const opened: [string, string, string][] = [];
  const host = playgroundItemHost({
    saved,
    notifications: { current: new Set() },
    navigation: {
      current: (a: string, e: string, back: { elementId: string }) => (
        opened.push([a, e, back.elementId]),
        true
      ),
    },
    now: () => clock,
  });
  const from = { artifactId: 'fmea', elementId: fmea().rows[0]!.id, field: 'refs.causeCandidates' };
  return { host, saved, from, opened, tick: (ms: number) => (clock += ms) };
}

describe('AR2 Playground の架空の ItemReferenceHost', () => {
  it('候補は Library のほかの保存した成果物の項目で、resolve は何も記録しない', async () => {
    const { host, from } = setup();
    expect((await host.candidates(from, signal)).map((c) => [c.id, c.artifactTitle])).toEqual([
      ['CC-01', '特性要因図'],
      ['CC-02', '特性要因図'],
    ]);
    const s = await host.resolve(from, ['CC-01', 'CC-09'], signal);
    expect(s.get('CC-01')).toEqual({ status: 'ok', title: '接点の溶着' });
    expect(s.get('CC-09')?.status).toBe('unresolved');
  });

  it('選んで保存した版が基準になり、引用先の保存版が変わると古い。証跡の無い引用は古くならない', async () => {
    const { host, saved, from } = setup();
    const ledger = new ItemSelectionLedger();
    const r = await host.select(from, 'CC-01', signal);
    expect(r.accepted).toBe(true);
    ledger.choose(from, 'CC-01', r);
    const before = fmea();
    const after = setRowRefs(before.rows[0]!.id, 'causeCandidates', ['CC-01', 'CC-02']).apply(
      before,
    );
    const occ = refOccurrences('fmea', after);
    const marks = ledger.marks(refOccurrences('fmea', before), occ);
    host.committed('fmea', ledger.evidenceFor(marks, refOccurrences('fmea', before), occ), occ);
    // 引用先の Fishbone を保存し直して CC-01 と CC-02 を変える
    const changed = fishbone('接点の溶着（改）');
    changed.nodes.filter((n) => n.type === 'cause')[1]!.attributes.name = '別の名前';
    saved.current.set('fish', record('fish', '特性要因図', changed, 2));
    const s = await host.resolve(from, ['CC-01', 'CC-02'], signal);
    expect(s.get('CC-01')?.status).toBe('stale');
    expect(s.get('CC-02')).toEqual({ status: 'ok', title: '別の名前' });
  });

  it('消費済み・期限切れ・食い違う証跡は使わず、外して保存すると基準も終わる', async () => {
    const { host, saved, from, tick } = setup();
    const occ = [{ from, id: 'CC-01' }];
    const r = await host.select(from, 'CC-01', signal);
    if (!r.accepted) throw new Error('not accepted');
    const evidence = [{ selectionId: r.selectionId, from, id: 'CC-01' }];
    // 食い違う（別の行）
    host.committed('fmea', [{ ...evidence[0]!, from: { ...from, elementId: 'other' } }], occ);
    host.committed('fmea', evidence, occ);
    saved.current.set('fish', record('fish', '特性要因図', fishbone('変えた'), 2));
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('stale');
    // 外して保存すると基準が終わり、同じ証跡の再送は消費済みで使われない
    host.committed('fmea', [], []);
    host.committed('fmea', evidence, occ);
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('ok');
    // 期限切れ
    const late = await host.select(from, 'CC-01', signal);
    if (!late.accepted) throw new Error('not accepted');
    tick(25 * 3_600_000);
    host.committed('fmea', [{ selectionId: late.selectionId, from, id: 'CC-01' }], occ);
    saved.current.set('fish', record('fish', '特性要因図', fishbone('また変えた'), 3));
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('ok');
  });

  it('重なった ID は選べず重複と出し、開くと引用先の要素へ移る', async () => {
    const { host, saved, from, opened } = setup();
    expect(await host.open('CC-01', from)).toEqual({ opened: true });
    const node = fishbone().nodes.find((n) => n.attributes.itemId === 'CC-01')!.id;
    expect(opened).toEqual([['fish', node, from.elementId]]);
    const dup = clone(fishbone());
    dup.nodes.filter((n) => n.type === 'cause')[1]!.attributes.itemId = 'CC-01';
    saved.current.set('fish', record('fish', '特性要因図', dup, 2));
    expect((await host.select(from, 'CC-01', signal)).accepted).toBe(false);
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('duplicate');
    expect((await host.candidates(from, signal)).map((c) => c.id)).not.toContain('CC-01');
  });

  it('引用した原因の候補の問題（図の problemRef）が変わっても古い', async () => {
    const { host, saved, from } = setup();
    const ledger = new ItemSelectionLedger();
    const withProblem = (problem: string) => {
      const g = fishbone();
      g.attributes = { ...g.attributes, problemRef: problem };
      return g;
    };
    saved.current.set('fish', record('fish', '特性要因図', withProblem('PS-01')));
    const r = await host.select(from, 'CC-01', signal);
    ledger.choose(from, 'CC-01', r);
    const before = fmea();
    const after = setRowRefs(before.rows[0]!.id, 'causeCandidates', ['CC-01']).apply(before);
    const occ = refOccurrences('fmea', after);
    const marks = ledger.marks(refOccurrences('fmea', before), occ);
    host.committed('fmea', ledger.evidenceFor(marks, refOccurrences('fmea', before), occ), occ);
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('ok');
    saved.current.set('fish', record('fish', '特性要因図', withProblem('PS-02'), 2));
    expect((await host.resolve(from, ['CC-01'], signal)).get('CC-01')?.status).toBe('stale');
  });
});
