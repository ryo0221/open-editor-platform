import { describe, expect, it } from 'vitest';
import { command, EditorSession } from '@editor-platform/editor-core';
import { ItemSelectionLedger, type ItemRefOccurrence, type ItemSelectionResult } from './items';

const from = { artifactId: 'fmea', elementId: 'r1', field: 'refs.causeCandidates' };
const accepted = (selectionId: string): ItemSelectionResult => ({
  accepted: true,
  selectionId,
  target: { artifactId: 'fishbone', versionId: 'v1', revision: 1, contentHash: 'h' },
  state: { status: 'ok', title: '接点の溶着' },
});
const at = (...ids: string[]): ItemRefOccurrence[] => ids.map((id) => ({ from, id }));

/** A session whose content is the cited IDs of one field, marked by the ledger. */
function fixture() {
  const ledger = new ItemSelectionLedger();
  const session = new EditorSession<{ ids: string[] }>(
    { ids: [] },
    { marks: (before, after) => ledger.marks(at(...before.ids), at(...after.ids)) },
  );
  const edit = (...ids: string[]) =>
    session.execute(command<{ ids: string[] }>('refs', 'refs', () => ({ ids })));
  /** A choice through the reference field: held, then the edit, then dropped if unused. */
  const choose = (sid: string, ...ids: string[]) => {
    ledger.choose(from, ids.at(-1)!, accepted(sid));
    edit(...ids);
    ledger.cancel(from, ids.at(-1)!);
  };
  const evidence = (saved: string[] = []) =>
    ledger.evidenceFor(session.marks, at(...saved), at(...session.content.ids));
  return { ledger, session, edit, choose, evidence };
}

describe('ItemSelectionLedger: selection evidence follows the session history', () => {
  it('a newly saved citation carries its choice; a citation already saved or typed carries none', () => {
    const f = fixture();
    f.choose('s1', 'CC-01');
    f.edit('CC-01', 'CC-02'); // CC-02 typed
    expect(f.evidence()).toEqual([{ selectionId: 's1', from, id: 'CC-01' }]);
    expect(f.evidence(['CC-01'])).toEqual([]);
    // a refused select holds nothing
    f.ledger.choose(from, 'CC-03', { accepted: false, state: { status: 'duplicate', reason: '' } });
    f.edit('CC-01', 'CC-02', 'CC-03');
    expect(f.evidence().map((e) => e.id)).toEqual(['CC-01']);
    expect(f.ledger.held).toBe(0);
  });

  it('Undo of a removal brings the choice back; Undo of the choice removes it', () => {
    const f = fixture();
    f.choose('s1', 'CC-01');
    f.edit();
    expect(f.evidence()).toEqual([]);
    f.session.undo();
    expect(f.evidence()).toEqual([{ selectionId: 's1', from, id: 'CC-01' }]);
    f.session.undo();
    expect(f.evidence()).toEqual([]);
    f.session.redo();
    expect(f.evidence().map((e) => e.selectionId)).toEqual(['s1']);
  });

  it('Undo of a later choice brings back the earlier one, not the latest', () => {
    const f = fixture();
    f.choose('s1', 'CC-01'); // target version v1
    f.edit();
    f.choose('s2', 'CC-01'); // chosen again after the target changed
    expect(f.evidence().map((e) => e.selectionId)).toEqual(['s2']);
    f.session.undo();
    f.session.undo();
    expect(f.evidence().map((e) => e.selectionId)).toEqual(['s1']);
  });

  it('a citation removed by any edit and typed back carries no choice', () => {
    const f = fixture();
    f.choose('s1', 'CC-01');
    f.edit('CC-02'); // replaced by hand (or a flush, paste or import)
    f.edit('CC-01'); // typed back
    expect(f.evidence()).toEqual([]);
  });

  it('a choice no edit used is dropped', () => {
    const f = fixture();
    f.ledger.choose(from, 'CC-01', accepted('s1'));
    f.ledger.cancel(from, 'CC-01');
    f.edit('CC-01');
    expect(f.evidence()).toEqual([]);
  });
});
