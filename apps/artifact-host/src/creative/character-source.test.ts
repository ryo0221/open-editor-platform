import { describe, expect, it } from 'vitest';
import { createArtifact, MemoryStorage } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { ArtifactEditor, loadHostArtifact } from '@editor-platform/editor-host';
import { isStructuredData, removeRow } from '@editor-platform/structured-data/model';
import { setCells } from '@editor-platform/structured-data/views';
import {
  characterSourceConfig,
  createCharacterCommand,
  createCharacterSeed,
  createCharacterSourceConfig,
  defaultCharacterColumns as columns,
  editCharacterCommand,
  guardCharacterSourceCommand,
  projectCharacterCards,
  type CharacterColumnMapping,
} from './character-source';

describe('Character Mode native character-sheet source', () => {
  it('projects only the existing Data rows and keeps card state out of native content', () => {
    const source = createCharacterSeed(),
      before = structuredClone(source);
    const cards = projectCharacterCards(source);
    expect(isStructuredData(source)).toBe(true);
    expect(Object.keys(source).sort()).toEqual(['columns', 'rows', 'schemaVersion']);
    expect(cards.map((c) => [c.id, c.elementId, c.name])).toEqual([
      ['CH-01', 'character-row-CH-01', '美緒'],
      ['CH-02', 'character-row-CH-02', '灯台守'],
    ]);
    expect(cards[0].fields.map((f) => f.label)).toEqual([
      'ID',
      '名前',
      '説明',
      '欲求',
      '傷',
      '口調',
      '関係',
      '初登場',
    ]);
    cards[0].name = 'A private projection';
    cards[0].fields[1].value = 'A private projection';
    expect(source).toEqual(before);
    source.rows[0].values[columns.name] = '新しい名前';
    expect(projectCharacterCards(source)[0].name).toBe('新しい名前');
    expect(projectCharacterCards(source)[0].elementId).toBe(cards[0].elementId);
  });

  it('reads an externally mapped table through stable column IDs, independent of labels', () => {
    const mapping = Object.fromEntries(
      Object.keys(columns).map((key, i) => [key, `external-field-${i}`]),
    ) as CharacterColumnMapping;
    const original = createCharacterSeed(),
      source = structuredClone(original);
    for (const column of source.columns) {
      const field = (Object.keys(columns) as (keyof CharacterColumnMapping)[]).find(
        (key) => columns[key] === column.id,
      )!;
      const oldId = column.id;
      column.id = mapping[field];
      column.name = `Host-owned field ${mapping[field]}`;
      for (const row of source.rows) {
        row.values[column.id] = row.values[oldId];
        delete row.values[oldId];
      }
    }
    const config = createCharacterSourceConfig(mapping);
    expect(config.adapter.validate(source)).toBe(true);
    expect(config.cards(source).map((c) => c.elementId)).toEqual(original.rows.map((r) => r.id));
    const card = config.cards(source)[0];
    const next = config.edit(source, card, mapping.voice, '方言で話す').apply(source);
    expect(next.rows[0].values[mapping.voice]).toBe('方言で話す');
    expect(next.rows[1]).toEqual(source.rows[1]);
    expect(config.cards(next)[0].fields.find((f) => f.id === mapping.voice)?.value).toBe(
      '方言で話す',
    );
    expect(source.rows[0].values[mapping.voice]).toBe('短く率直に話す');
  });

  it('rejects duplicate CH IDs, malformed IDs, missing fields and ambiguous mapping', () => {
    const source = createCharacterSeed();
    const duplicate = structuredClone(source);
    duplicate.rows[1].values[columns.id] = 'CH-01';
    expect(() => projectCharacterCards(duplicate)).toThrow(/重複/);
    expect(characterSourceConfig.adapter.validate(duplicate)).toBe(false);
    for (const id of ['person-01', 'CH-1', 'CH-001', 'CH-00']) {
      const malformed = structuredClone(source);
      malformed.rows[0].values[columns.id] = id;
      expect(() => projectCharacterCards(malformed)).toThrow(/CH-01/);
    }
    const missing = structuredClone(source);
    missing.columns = missing.columns.filter((c) => c.id !== columns.desire);
    expect(() => projectCharacterCards(missing)).toThrow(/列が見つかりません/);
    expect(() => projectCharacterCards(source, { ...columns, wound: columns.desire })).toThrow(
      /列対応が重複/,
    );
  });

  it('adds a native row with deterministic IDs and one existing Session Undo/Redo entry', () => {
    const source = createCharacterSeed(),
      command = createCharacterCommand(source, ' 新しい人物 ', '外見と役割');
    expect(command.type).toBe('data.cells');
    const expected = command.apply(source);
    expect(command.apply(source)).toEqual(expected);
    expect(projectCharacterCards(expected).at(-1)).toMatchObject({
      id: 'CH-03',
      elementId: expect.any(String),
      name: '新しい人物',
      summary: '外見と役割',
    });
    expect(expected.rows.slice(0, 2)).toEqual(source.rows);
    expect(expected.columns).toEqual(source.columns);
    const session = new EditorSession(source);
    session.execute(command);
    expect(session.content).toEqual(expected);
    session.undo();
    expect(session.content).toEqual(source);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.content).toEqual(expected);
  });

  it('edits only the original native cell and restores it with the ordinary source history', () => {
    const source = createCharacterSeed(),
      card = projectCharacterCards(source)[0];
    const command = editCharacterCommand(source, card, columns.desire, '自分の返事を届ける');
    const session = new EditorSession(source);
    session.execute(command);
    const next = session.content;
    expect(next.rows[0]).toEqual({
      ...source.rows[0],
      values: { ...source.rows[0].values, [columns.desire]: '自分の返事を届ける' },
    });
    expect(next.rows[1]).toEqual(source.rows[1]);
    expect(next.columns).toEqual(source.columns);
    expect(projectCharacterCards(next)[0].fields.find((f) => f.id === columns.desire)?.value).toBe(
      '自分の返事を届ける',
    );
    session.undo();
    expect(session.content).toEqual(source);
    session.redo();
    expect(session.content).toEqual(next);
  });

  it('rechecks trusted permission when prepared create/edit commands execute', () => {
    const source = createCharacterSeed(),
      card = projectCharacterCards(source)[0];
    let writable = true;
    const create = createCharacterCommand(source, '追加', '', columns, () => writable);
    const edit = editCharacterCommand(source, card, columns.name, '変更', columns, () => writable);
    writable = false;
    for (const command of [create, edit]) expect(() => command.apply(source)).toThrow(/read only/);
    const session = new ArtifactEditor(
      createArtifact('data', '人物表', source),
      characterSourceConfig.adapter,
      new MemoryStorage(),
      () => writable,
    );
    expect(() => session.execute(createCharacterCommand(source, '追加', ''))).toThrow(/read-only/);
    expect(session.content).toEqual(source);
    expect(session.canUndo).toBe(false);
  });

  it('refuses readonly, computed and identity fields instead of changing the Data schema', () => {
    const source = createCharacterSeed();
    source.columns.find((c) => c.id === columns.wound)!.readOnly = true;
    const card = projectCharacterCards(source)[0];
    expect(card.fields.find((f) => f.id === columns.wound)?.editable).toBe(false);
    expect(() => editCharacterCommand(source, card, columns.wound, 'changed')).toThrow(
      /読み取り専用/,
    );
    expect(() => editCharacterCommand(source, card, columns.id, 'CH-99')).toThrow(/読み取り専用/);
    const computed = structuredClone(source);
    computed.columns.find((c) => c.id === columns.desire)!.type = 'formula';
    computed.columns.find((c) => c.id === columns.desire)!.formula = '1 + 1';
    expect(
      projectCharacterCards(computed)[0].fields.find((f) => f.id === columns.desire),
    ).toMatchObject({ value: '2', editable: false });
    expect(() =>
      editCharacterCommand(computed, projectCharacterCards(computed)[0], columns.desire, 'changed'),
    ).toThrow(/読み取り専用/);
  });

  it('rejects stale row buffers, changed schema and old projected field values atomically', () => {
    const source = createCharacterSeed(),
      card = projectCharacterCards(source)[0];
    const prepared = editCharacterCommand(source, card, columns.name, '変更');
    const changedRow = structuredClone(source);
    changedRow.rows[0].values[columns.description] = 'Updated outside the card';
    expect(() => prepared.apply(changedRow)).toThrow(/changed while editing/);
    const changedSchema = structuredClone(source);
    changedSchema.columns[1].name = 'Renamed field';
    expect(() => prepared.apply(changedSchema)).toThrow(/changed while editing/);
    const changedValue = structuredClone(source);
    changedValue.rows[0].values[columns.name] = 'Another name';
    expect(() => editCharacterCommand(changedValue, card, columns.name, '変更')).toThrow(
      /値が変更/,
    );
    const session = new EditorSession(changedRow);
    expect(() => session.execute(prepared)).toThrow();
    expect(session.content).toEqual(changedRow);
    expect(session.canUndo).toBe(false);
  });

  it('allows edits to unrelated rows while refusing stale allocated IDs and schema', () => {
    const source = createCharacterSeed(),
      edit = editCharacterCommand(
        source,
        projectCharacterCards(source)[0],
        columns.voice,
        '新しい口調',
      );
    const changed = structuredClone(source);
    changed.rows[1].values[columns.description] = 'Other row changed';
    expect(edit.apply(changed).rows[1]).toEqual(changed.rows[1]);
    const create = createCharacterCommand(source, '追加', '');
    const withNew = createCharacterCommand(source, '別の追加', '').apply(source);
    expect(() => create.apply(withNew)).toThrow(/人物表が変更/);
    const changedSchema = structuredClone(source);
    changedSchema.columns[0].name = 'Changed';
    expect(() => create.apply(changedSchema)).toThrow(/人物表が変更/);
  });

  it('uses the same identity guard for native table commands and card commands', () => {
    const source = createCharacterSeed(),
      rowId = source.rows[0].id;
    const renameId = guardCharacterSourceCommand(
      setCells([{ rowId, columnId: columns.id, value: 'CH-99' }]),
    );
    expect(() => renameId.apply(source)).toThrow(/変更・削除/);
    expect(() => guardCharacterSourceCommand(removeRow(rowId)).apply(source)).toThrow(/変更・削除/);
    const edit = guardCharacterSourceCommand(
      setCells([{ rowId, columnId: columns.description, value: '表からの編集' }]),
    );
    expect(projectCharacterCards(edit.apply(source))[0].summary).toBe('表からの編集');
    expect(() => createCharacterCommand(source, ' ', '')).toThrow(/人物名/);
    expect(() =>
      editCharacterCommand(source, projectCharacterCards(source)[0], columns.name, ''),
    ).toThrow(/人物名/);
  });

  it('loads schemaVersion 1 as native Data and saves/reloads the same rows after a card edit', async () => {
    const legacy = createCharacterSeed();
    legacy.schemaVersion = 1;
    const artifact = createArtifact('data', '以前の人物表', legacy);
    const loaded = await loadHostArtifact(JSON.stringify(artifact), characterSourceConfig.adapter);
    expect(loaded.draft.content.schemaVersion).toBe(1);
    const session = new ArtifactEditor(loaded, characterSourceConfig.adapter, new MemoryStorage());
    const card = projectCharacterCards(session.content)[0];
    session.execute(
      editCharacterCommand(session.content, card, columns.description, '既存表を編集'),
    );
    const result = await session.save({ commitVersion: true });
    const reloaded = await loadHostArtifact(
      JSON.stringify(result.artifact),
      characterSourceConfig.adapter,
    );
    expect(reloaded.draft.content.rows.map((r) => r.id)).toEqual(legacy.rows.map((r) => r.id));
    expect(projectCharacterCards(reloaded.draft.content)[0].summary).toBe('既存表を編集');
    expect(reloaded.versions[0].content).toEqual(session.content);
    expect(Object.keys(reloaded.draft.content).sort()).toEqual([
      'columns',
      'rows',
      'schemaVersion',
    ]);
    expect(artifact.draft.content).toEqual(legacy);
  });
});

it('does not reuse native row identity when preparing a replacement after Undo', () => {
  const data = createCharacterSeed();
  const first = createCharacterCommand(data, '一人目', '');
  const second = createCharacterCommand(data, '別の人物', '');
  const firstCard = projectCharacterCards(first.apply(data)).at(-1)!;
  const secondCard = projectCharacterCards(second.apply(data)).at(-1)!;
  expect(firstCard.id).toBe(secondCard.id);
  expect(firstCard.elementId).not.toBe(secondCard.elementId);
  expect(projectCharacterCards(first.apply(data)).at(-1)!.elementId).toBe(firstCard.elementId);
});
