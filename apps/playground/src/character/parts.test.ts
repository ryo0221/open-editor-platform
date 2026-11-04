import { describe, expect, it, vi } from 'vitest';
import { commitVersion, createArtifact } from '@editor-platform/artifact-core';
import { f02Plate, r2bJoints, type CadDocument } from '@editor-platform/cad-core';
import {
  applyCharacterOperation,
  blockyFigure,
  type CharacterDocument,
} from '@editor-platform/character-core';
import type { StoredArtifact } from '../model';
import { portableCadRecord } from '../cad/resources';
import { carryProps } from './carry-props';
import {
  characterPartClosure,
  characterPropChoices,
  retainCharacterProp,
  validateCharacterParts,
} from './parts';

/** Props of characters (C2b-3): the CAD versions kept with the character, and re-import. */
const stored = async (kind: 'cad' | 'character', name: string, content: object, versions = 1) => {
  let a = createArtifact(kind, name, content as CadDocument);
  for (let i = 0; i < versions; i++) a = await commitVersion(a, null, `v${i + 1}`);
  return { ...a, annotations: [] } as unknown as StoredArtifact;
};
const withProp = (
  doc: CharacterDocument,
  contentHash: string,
  artifactId: string,
  versionId: string,
) =>
  applyCharacterOperation(doc, {
    type: 'addProp',
    prop: {
      id: 'prop-rig',
      name: 'Rig',
      source: { kind: 'cad', artifactId, versionId, contentHash },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
      visible: true,
    },
  });

describe('character props in the Playground', () => {
  it('keeps a chosen assembly version and the versions it places, and carries exactly those', async () => {
    const { assembly, closure } = r2bJoints();
    const rig = {
      ...(await stored('cad', 'Rig', assembly)),
      cadParts: [...closure].map(([contentHash, content]) => ({ contentHash, content })),
    };
    const character = await stored('character', 'Hero', blockyFigure().doc, 0);
    const [choice] = characterPropChoices([rig, character]);
    expect(choice).toMatchObject({ artifactId: rig.id, label: 'Rig — v1 (v1)' });
    let saved: StoredArtifact | undefined;
    await retainCharacterProp({
      choice: choice!,
      records: [rig, character],
      record: character,
      draft: withProp(blockyFigure().doc, choice!.contentHash, rig.id, choice!.versionId),
      persist: async (r) => ((saved = r), true),
    });
    const hashes = saved!.cadParts!.map((p) => p.contentHash).sort();
    expect(hashes).toEqual([choice!.contentHash, ...closure.keys()].sort());
    // Not placed yet: the native file carries none of them.
    expect(portableCadRecord(saved!).cadParts).toEqual([]);
    const placed = {
      ...saved!,
      draft: {
        ...saved!.draft,
        content: withProp(blockyFigure().doc, choice!.contentHash, rig.id, choice!.versionId),
      },
    } as unknown as StoredArtifact;
    expect(characterPartClosure(placed).missing.size).toBe(0);
    expect(portableCadRecord(placed).cadParts).toHaveLength(hashes.length);
    expect(() => validateCharacterParts(portableCadRecord(placed))).not.toThrow();
    // A file without a version its prop places, or with one it does not, is refused.
    expect(() =>
      validateCharacterParts({ ...placed, cadParts: placed.cadParts!.slice(1) }),
    ).toThrow(/missing/);
    expect(() =>
      validateCharacterParts({
        ...portableCadRecord(placed),
        cadParts: [
          ...portableCadRecord(placed).cadParts!,
          { contentHash: 'x', content: f02Plate() },
        ],
      }),
    ).toThrow(/hash mismatch/);
  });
  it('refuses a version whose shapes need asset bytes, and one no longer saved', async () => {
    const plate = { ...f02Plate(), assets: [{ ...({} as object) }] } as unknown as CadDocument;
    const part = await stored('cad', 'Imported', plate);
    const character = await stored('character', 'Hero', blockyFigure().doc, 0);
    const [choice] = characterPropChoices([part]);
    const persist = async () => true;
    const draft = blockyFigure().doc;
    await expect(
      retainCharacterProp({ choice: choice!, records: [part], record: character, draft, persist }),
    ).rejects.toThrow('prop-assets-unsupported');
    await expect(
      retainCharacterProp({
        choice: { ...choice!, versionId: 'gone' },
        records: [part],
        record: character,
        draft,
        persist,
      }),
    ).rejects.toThrow('prop-source-missing');
  });
  it('measures the native file with the prop added, not only its versions', async () => {
    const part = await stored('cad', 'Plate', f02Plate());
    const character = await stored('character', 'Hero', blockyFigure().doc, 0);
    const [choice] = characterPropChoices([part]);
    const persist = vi.fn(async () => true);
    const placed = withProp(blockyFigure().doc, choice!.contentHash, part.id, choice!.versionId);
    // The versions alone fit; the prop's own fields push the file past the limit.
    placed.props[0]!.name = 'x'.repeat(16_000_000);
    await expect(
      retainCharacterProp({
        choice: choice!,
        records: [part],
        record: character,
        draft: placed,
        persist,
      }),
    ).rejects.toThrow('prop-file-too-large');
    expect(persist).not.toHaveBeenCalled();
    // Versions kept only for Undo leave the native file but count in the stored record.
    const keptForUndo = {
      ...character,
      cadParts: [{ contentHash: 'undo', content: { ...f02Plate(), name: 'y'.repeat(16_000_000) } }],
    } as unknown as StoredArtifact;
    const small = withProp(blockyFigure().doc, choice!.contentHash, part.id, choice!.versionId);
    await expect(
      retainCharacterProp({
        choice: choice!,
        records: [part],
        record: keptForUndo,
        draft: small,
        persist,
      }),
    ).rejects.toThrow('prop-file-too-large');
    expect(persist).not.toHaveBeenCalled();
  });
  it('a re-import keeps the props and the joint keys of the actions the file has', () => {
    const hash = 'a'.repeat(64);
    let current = withProp(blockyFigure().doc, hash, 'art', 'v');
    current = applyCharacterOperation(current, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'prop-joint', id: 'prop-rig', joint: 'j-turn', property: 'angle' },
      tick: 0,
      value: 1,
      trackId: 'wave/rig/j-turn/angle',
      keyId: 'wave/rig/j-turn/angle#0',
    });
    // The same model again: its own wave action, without the joint track.
    const imported = blockyFigure().doc;
    const { doc, dropped } = carryProps(current, imported);
    expect(doc.props.map((p) => p.id)).toEqual(['prop-rig']);
    const wave = doc.actions.find((a) => a.id === 'wave')!;
    expect(wave.tracks.filter((t) => t.target.kind === 'prop-joint')).toHaveLength(1);
    expect(dropped).toEqual([]);
    // A file without that action: the keys are reported, the prop stays.
    const other = structuredClone(imported);
    for (const a of other.actions) a.id = `${a.id}-other`;
    const r = carryProps(current, other);
    expect(r.doc.props).toHaveLength(1);
    expect(r.dropped).toEqual(['Prop joint keys of action Wave (not in the file)']);
  });
});
