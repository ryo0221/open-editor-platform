/**
 * tl1 table schema (docs/story-timeline/t0-contract.md §2.2). Column IDs, types, options,
 * per-role column order and row kinds mirror docs/story-timeline/fixtures/tl1-schema.json;
 * timeline/table.test.ts checks that the two stay equal. Column names are display text and
 * are not part of the binding.
 */
export const TL1_COLUMNS = [
  {
    id: 'tl1.row',
    type: 'select',
  },
  {
    id: 'tl1.label',
    type: 'text',
  },
  {
    id: 'tl1.subject',
    type: 'relation',
  },
  {
    id: 'tl1.ref.artifact',
    type: 'text',
  },
  {
    id: 'tl1.ref.version',
    type: 'text',
  },
  {
    id: 'tl1.ref.hash',
    type: 'text',
  },
  {
    id: 'tl1.ref.item',
    type: 'text',
  },
  {
    id: 'tl1.ref.facet',
    type: 'select',
    options: ['whole', 'existence', 'participants', 'time', 'content', 'info', 'evaluation'],
  },
  {
    id: 'tl1.ref2.artifact',
    type: 'text',
  },
  {
    id: 'tl1.ref2.version',
    type: 'text',
  },
  {
    id: 'tl1.ref2.hash',
    type: 'text',
  },
  {
    id: 'tl1.ref2.item',
    type: 'text',
  },
  {
    id: 'tl1.time.kind',
    type: 'select',
    options: ['unset', 'point', 'day', 'interval', 'range', 'derived'],
  },
  {
    id: 'tl1.time.start',
    type: 'number',
  },
  {
    id: 'tl1.time.end',
    type: 'number',
  },
  {
    id: 'tl1.clock',
    type: 'text',
  },
  {
    id: 'tl1.clock2',
    type: 'text',
  },
  {
    id: 'tl1.offset.min',
    type: 'number',
  },
  {
    id: 'tl1.offset.max',
    type: 'number',
  },
  {
    id: 'tl1.anchor',
    type: 'select',
    options: ['start', 'end'],
  },
  {
    id: 'tl1.ind.ch',
    type: 'text',
  },
  {
    id: 'tl1.ind.origin',
    type: 'text',
  },
  {
    id: 'tl1.info',
    type: 'text',
  },
  {
    id: 'tl1.mode',
    type: 'select',
    options: ['observe', 'told', 'believe', 'doubt', 'deny', 'forget', 'assert', 'true', 'false'],
  },
  {
    id: 'tl1.complete',
    type: 'boolean',
  },
  {
    id: 'tl1.loc',
    type: 'text',
  },
  {
    id: 'tl1.loc2',
    type: 'text',
  },
  {
    id: 'tl1.certainty',
    type: 'select',
    options: ['confirmed', 'uncertain'],
  },
  {
    id: 'tl1.world.parent',
    type: 'text',
  },
  {
    id: 'tl1.order',
    type: 'number',
  },
  {
    id: 'tl1.part',
    type: 'text',
  },
  {
    id: 'tl1.diag',
    type: 'select',
    options: [
      'single-event',
      'disclosure',
      'presence',
      'multi-event',
      'transfer',
      'external-event',
    ],
  },
  {
    id: 'tl1.rule',
    type: 'text',
  },
  {
    id: 'tl1.reason',
    type: 'text',
  },
  {
    id: 'tl1.scope',
    type: 'text',
  },
  {
    id: 'tl1.hypothesis',
    type: 'text',
  },
] as const;

export const TL1_ROLES = {
  ledger: {
    columns: [
      'tl1.row',
      'tl1.label',
      'tl1.subject',
      'tl1.ref.artifact',
      'tl1.ref.version',
      'tl1.ref.hash',
      'tl1.ref.item',
      'tl1.ref.facet',
      'tl1.time.kind',
      'tl1.time.start',
      'tl1.time.end',
      'tl1.clock',
      'tl1.offset.min',
      'tl1.offset.max',
      'tl1.anchor',
      'tl1.ind.ch',
      'tl1.ind.origin',
      'tl1.info',
      'tl1.mode',
      'tl1.complete',
      'tl1.loc',
      'tl1.certainty',
      'tl1.diag',
      'tl1.rule',
      'tl1.reason',
      'tl1.scope',
      'tl1.hypothesis',
    ],
    rows: {
      event: {
        required: ['tl1.label', 'tl1.time.kind'],
        optional: ['tl1.time.start', 'tl1.time.end', 'tl1.clock'],
      },
      'derive-time': {
        required: ['tl1.subject', 'tl1.ref.item', 'tl1.anchor', 'tl1.offset.min', 'tl1.offset.max'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
      after: {
        required: ['tl1.subject', 'tl1.ref.item'],
        optional: [
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.facet',
          'tl1.anchor',
          'tl1.offset.min',
          'tl1.offset.max',
        ],
      },
      'travel-min': {
        required: ['tl1.subject', 'tl1.ref.item', 'tl1.offset.min', 'tl1.ind.ch', 'tl1.ind.origin'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
      cause: {
        required: ['tl1.subject', 'tl1.ref.item'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
      participant: {
        required: ['tl1.subject', 'tl1.ind.ch', 'tl1.ind.origin'],
        optional: [],
      },
      knows: {
        required: ['tl1.subject', 'tl1.info', 'tl1.mode', 'tl1.ind.ch', 'tl1.ind.origin'],
        optional: [],
      },
      'info-use': {
        required: [
          'tl1.subject',
          'tl1.info',
          'tl1.ref.item',
          'tl1.complete',
          'tl1.ind.ch',
          'tl1.ind.origin',
        ],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
      claim: {
        required: ['tl1.subject', 'tl1.info', 'tl1.mode', 'tl1.ind.ch', 'tl1.ind.origin'],
        optional: [],
      },
      fact: {
        required: ['tl1.subject', 'tl1.info', 'tl1.mode'],
        optional: [],
      },
      presence: {
        required: [
          'tl1.subject',
          'tl1.loc',
          'tl1.certainty',
          'tl1.time.kind',
          'tl1.ind.ch',
          'tl1.ind.origin',
        ],
        optional: ['tl1.time.start', 'tl1.time.end'],
      },
      exception: {
        required: ['tl1.subject', 'tl1.diag', 'tl1.rule', 'tl1.reason', 'tl1.scope'],
        optional: ['tl1.hypothesis'],
      },
      'exception-basis': {
        required: ['tl1.subject', 'tl1.ref.item'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
    },
  },
  'scene-cards': {
    columns: [
      'tl1.row',
      'tl1.label',
      'tl1.subject',
      'tl1.ref.artifact',
      'tl1.ref.version',
      'tl1.ref.hash',
      'tl1.ref.item',
      'tl1.ref.facet',
      'tl1.info',
    ],
    rows: {
      scene: {
        required: ['tl1.label'],
        optional: [],
      },
      cite: {
        required: [
          'tl1.subject',
          'tl1.ref.facet',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
        ],
        optional: ['tl1.info'],
      },
    },
  },
  composition: {
    columns: [
      'tl1.row',
      'tl1.label',
      'tl1.subject',
      'tl1.ref.artifact',
      'tl1.ref.version',
      'tl1.ref.hash',
      'tl1.ref.item',
      'tl1.ref.facet',
      'tl1.ref2.artifact',
      'tl1.ref2.version',
      'tl1.ref2.hash',
      'tl1.ref2.item',
      'tl1.ind.ch',
      'tl1.ind.origin',
      'tl1.order',
      'tl1.part',
      'tl1.diag',
      'tl1.rule',
      'tl1.reason',
      'tl1.scope',
      'tl1.hypothesis',
    ],
    rows: {
      occurrence: {
        required: [
          'tl1.label',
          'tl1.order',
          'tl1.part',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
        ],
        optional: [],
      },
      experience: {
        required: [
          'tl1.ind.ch',
          'tl1.ind.origin',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
          'tl1.ref2.artifact',
          'tl1.ref2.version',
          'tl1.ref2.hash',
          'tl1.ref2.item',
        ],
        optional: ['tl1.label'],
      },
      exception: {
        required: ['tl1.diag', 'tl1.rule', 'tl1.reason', 'tl1.scope'],
        optional: ['tl1.label', 'tl1.hypothesis'],
      },
      'exception-target': {
        required: [
          'tl1.subject',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
        ],
        optional: ['tl1.ref.facet'],
      },
      'exception-basis': {
        required: ['tl1.subject', 'tl1.ref.item'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
    },
  },
  world: {
    columns: [
      'tl1.row',
      'tl1.label',
      'tl1.subject',
      'tl1.ref.artifact',
      'tl1.ref.version',
      'tl1.ref.hash',
      'tl1.ref.item',
      'tl1.ref.facet',
      'tl1.ref2.artifact',
      'tl1.ref2.version',
      'tl1.ref2.hash',
      'tl1.ref2.item',
      'tl1.time.kind',
      'tl1.time.start',
      'tl1.clock',
      'tl1.clock2',
      'tl1.offset.min',
      'tl1.offset.max',
      'tl1.ind.ch',
      'tl1.ind.origin',
      'tl1.info',
      'tl1.loc',
      'tl1.loc2',
      'tl1.world.parent',
      'tl1.diag',
      'tl1.rule',
      'tl1.reason',
      'tl1.scope',
      'tl1.hypothesis',
    ],
    rows: {
      clock: {
        required: ['tl1.label'],
        optional: [],
      },
      worldline: {
        required: ['tl1.label', 'tl1.clock'],
        optional: ['tl1.world.parent', 'tl1.time.kind', 'tl1.time.start'],
      },
      'clock-offset': {
        required: ['tl1.clock', 'tl1.clock2', 'tl1.offset.min', 'tl1.offset.max'],
        optional: [],
      },
      inherits: {
        required: [
          'tl1.subject',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
        ],
        optional: [],
      },
      transfer: {
        required: [
          'tl1.label',
          'tl1.ind.ch',
          'tl1.ind.origin',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
          'tl1.ref2.artifact',
          'tl1.ref2.version',
          'tl1.ref2.hash',
          'tl1.ref2.item',
        ],
        optional: [],
      },
      'transfer-info': {
        required: ['tl1.subject', 'tl1.info'],
        optional: [],
      },
      'location-exclusive': {
        required: ['tl1.loc', 'tl1.loc2'],
        optional: [],
      },
      'location-contains': {
        required: ['tl1.loc', 'tl1.loc2'],
        optional: [],
      },
      exception: {
        required: ['tl1.diag', 'tl1.rule', 'tl1.reason', 'tl1.scope'],
        optional: ['tl1.label', 'tl1.hypothesis'],
      },
      'exception-target': {
        required: [
          'tl1.subject',
          'tl1.ref.artifact',
          'tl1.ref.version',
          'tl1.ref.hash',
          'tl1.ref.item',
        ],
        optional: ['tl1.ref.facet'],
      },
      'exception-basis': {
        required: ['tl1.subject', 'tl1.ref.item'],
        optional: ['tl1.ref.artifact', 'tl1.ref.version', 'tl1.ref.hash', 'tl1.ref.facet'],
      },
    },
  },
} as const;

export const TL1_LIMITS = {
  safeDayAbs: 1000000000,
  events: 1000,
  scenes: 1000,
  occurrences: 2000,
  worlds: 8,
  relations: 4000,
  label: 256,
  clockOffsets: 32,
  branchDepth: 8,
  projectionBytes: 2097152,
  manuscriptRegions: 256,
  occurrenceLinks: 2000,
  regionsPerOccurrenceLink: 64,
} as const;
