import { expect, it } from 'vitest';
import {
  condition,
  conditions,
  initial,
  type DomainCodec,
} from '@editor-platform/collaboration-core';
import { createDeck, insertObject } from '@editor-platform/slide/model';
import { createData, addRow } from '@editor-platform/structured-data/model';
import { slideEditorCodec, dataEditorCodec } from './editor-transactions';

function check<T>(codec: DomainCodec<T>, content: T, keys: string[]) {
  const state = initial('batch', codec, content);
  // Whole-parent, descendant, sibling, ABA and structural history must retain
  // exactly the scalar precondition meaning, including missing resources.
  for (const structure of [0, 21]) {
    state.stamps = {
      structure,
      'entity:rows:a': 4,
      'entity:rows:a/x': 7,
      'entity:rows:a/xy/z': 19,
      'entity:rows:ab/x': 23,
      'thread:t:reply:r': 11,
      'thread:t:resolved': 13,
      'order:items': 5,
      'entity:objects@p:o/fill': 17,
    };
    const wanted = [
      ...keys,
      '*',
      'entity:rows:a',
      'entity:rows:a/x',
      'entity:rows:a/x/y',
      'entity:rows:a/xy',
      'entity:rows:ab',
      'entity:rows:missing',
      'thread:t',
      'thread:t:reply',
      'thread:t:reply:r',
      'thread:t:resolved',
      'order:items',
    ];
    expect(conditions(codec, state, wanted)).toEqual(
      wanted.map((key) => condition(codec, state, key)),
    );
    expect(codec.resources?.(content, keys)).toEqual(
      keys.map((key) => codec.resource(content, key)),
    );
  }
}
it('preserves scalar resource and ancestor revision semantics in batched lookups', () => {
  let deck = createDeck();
  deck = insertObject(deck.slides[0].id, 'shape').apply(deck);
  const page = deck.slides[0],
    object = page.objects[0];
  const keys = [
    'order:pages',
    `order:objects@${page.id}`,
    `entity:pages:${page.id}`,
    `entity:objects@${page.id}:${object.id}`,
    `entity:objects@${page.id}:${object.id}/fill`,
    `children:${object.id}`,
    'entity:rows:missing/no',
  ];
  check(slideEditorCodec, deck, keys);
  // A later invocation over a mutable caller-owned snapshot cannot reuse an old index.
  page.objects[0].fill = '#123456';
  check(slideEditorCodec, deck, keys);
  let data = createData();
  data = addRow().apply(data);
  check(dataEditorCodec, data, [
    'order:rows',
    `entity:rows:${data.rows[0].id}`,
    `entity:rows:${data.rows[0].id}/values`,
    `entity:columns:${data.columns[0].id}`,
    'children:missing',
  ]);
});
