import { describe, expect, it } from 'vitest';
import { ItemSelectionLedger, type ItemRefOccurrence, type ItemSelectionResult } from './items';

const from = { artifactId: 'fmea', elementId: 'r1', field: 'refs.causeCandidates' };
const accepted = (selectionId: string): ItemSelectionResult => ({
  accepted: true,
  selectionId,
  target: { artifactId: 'fishbone', versionId: 'v1', revision: 1, contentHash: 'h' },
  state: { status: 'ok', title: '接点の溶着' },
});
const at = (...ids: string[]): ItemRefOccurrence[] => ids.map((id) => ({ from, id }));

describe('ItemSelectionLedger: selection evidence of one editing session', () => {
  it('a newly saved citation carries its choice; a citation already saved or typed carries none', () => {
    const l = new ItemSelectionLedger();
    l.choose(from, 'CC-01', accepted('s1'));
    expect(l.evidenceFor(at(), at('CC-01', 'CC-02'))).toEqual([
      { selectionId: 's1', from, id: 'CC-01' },
    ]);
    // already in the previous save: no evidence
    expect(l.evidenceFor(at('CC-01'), at('CC-01'))).toEqual([]);
    // a refused select keeps nothing
    l.choose(from, 'CC-03', { accepted: false, state: { status: 'duplicate', reason: '重複' } });
    expect(l.evidenceFor(at(), at('CC-03'))).toEqual([]);
  });

  it('Undo and Redo before saving keep the choice; a failed save keeps it for the retry', () => {
    const l = new ItemSelectionLedger();
    l.choose(from, 'CC-01', accepted('s1'));
    // Undo: the citation is gone from the content, nothing to send
    expect(l.evidenceFor(at(), at())).toEqual([]);
    // Redo: the same choice goes again
    expect(l.evidenceFor(at(), at('CC-01'))).toEqual([{ selectionId: 's1', from, id: 'CC-01' }]);
    // evidenceFor changes nothing; only a successful save ends the choices
    expect(l.size).toBe(1);
  });

  it('every choice ends at a save: removing, saving and adding again needs a new select', () => {
    const l = new ItemSelectionLedger();
    l.choose(from, 'CC-01', accepted('s1'));
    l.saved();
    expect(l.size).toBe(0);
    expect(l.evidenceFor(at(), at('CC-01'))).toEqual([]);
  });

  it('a hand edit of the field forgets its choices; other fields keep theirs', () => {
    const l = new ItemSelectionLedger();
    const other = { ...from, elementId: 'r2' };
    l.choose(from, 'CC-01', accepted('s1'));
    l.choose(other, 'CC-01', accepted('s2'));
    l.forget(from);
    expect(l.evidenceFor([], [...at('CC-01'), { from: other, id: 'CC-01' }])).toEqual([
      { selectionId: 's2', from: other, id: 'CC-01' },
    ]);
  });

  it('a save ends only the choices it captured: a choice made while it was in flight stays', () => {
    const l = new ItemSelectionLedger();
    l.choose(from, 'CC-01', accepted('s1'));
    const snapshot = l.snapshot();
    l.choose(from, 'CC-02', accepted('s2'));
    // CC-01 chosen again in flight: a new selection, so it stays too
    l.choose(from, 'CC-01', accepted('s3'));
    l.saved(snapshot);
    expect(l.evidenceFor([], at('CC-01', 'CC-02'))).toEqual([
      { selectionId: 's3', from, id: 'CC-01' },
      { selectionId: 's2', from, id: 'CC-02' },
    ]);
  });
});
