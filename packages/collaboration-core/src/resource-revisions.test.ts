import { expect, it } from 'vitest';
import { resourceRevision, resourceRevisions } from './state';
import type { Snapshot } from './contracts';

it('batched ownership stamps equal individual reads, including ancestor, sibling, thread and structure changes', () => {
  const state: Snapshot<null> = {
    protocol: 1,
    artifactId: 'stamps',
    domain: 'document',
    revision: 12,
    content: null,
    threads: [],
    engineVersion: 0,
    stamps: {
      'entity:objects:part': 3,
      'entity:objects:part/typography/color': 8,
      'entity:objects:part/typography/size': 6,
      'entity:objects:other/bounds': 11,
      'thread:one:reply:two': 5,
      'attribute/paragraph/style': 9,
      '*': 12,
    },
  };
  const keys = [
    '*',
    'missing',
    'entity:objects',
    'entity:objects:part',
    'entity:objects:part/typography',
    'entity:objects:part/typography/size',
    'entity:objects:part/typography/align',
    'entity:objects:other',
    'thread:one',
    'thread:one:reply:two',
    'attribute/paragraph',
    'attribute/paragraph/style',
  ];
  for (const structure of [0, 4, 12]) {
    state.stamps.structure = structure;
    for (const batch of [keys, [], [keys[4], keys[4]], keys.slice(2, 7)])
      expect(resourceRevisions(state, batch)).toEqual(
        batch.map((key) => resourceRevision(state, key)),
      );
  }
});
