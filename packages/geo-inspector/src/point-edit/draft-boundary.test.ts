import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { capturePointDraft, POINT_INPUT_LIMITS } from './draft-boundary';
import { editHarness } from '../../test-host/edit-fixture';
import { draftFor } from './model';
const target = { layerId: 'synthetic-sites', featureId: 'point-1', fieldId: 'metric' };
it('rejects changing target accessor before invocation or native/history mutation', () => {
  const h = editHarness(),
    before = h.binding.session.content;
  const draft = draftFor(h.handle.context.basic.read(), target);
  draft.longitude = '12.5';
  draft.scalar = '99';
  let calls = 0;
  Object.defineProperty(draft.target, 'featureId', {
    enumerable: true,
    get() {
      return ++calls === 1 ? 'point-1' : 'point-2';
    },
  });
  const result = h.port.execute(draft);
  const features = h.binding.session.content.layers[0].features;
  expect({
    calls,
    state: result.state,
    point1: features[0].values.metric,
    point2: features[1].values.metric,
    canUndo: h.binding.session.canUndo,
  }).toEqual({ calls: 0, state: 'refused', point1: 10, point2: 10, canUndo: false });
  expect(h.binding.session.content).toEqual(before);
});

function unchangedDescriptors(input: unknown) {
  const objects: object[] = [];
  if (input && typeof input === 'object') {
    objects.push(input);
    for (const key of ['target', 'baseRevision']) {
      const d = Object.getOwnPropertyDescriptor(input, key);
      if (d && 'value' in d && d.value && typeof d.value === 'object') objects.push(d.value);
    }
  }
  const before = objects.map((object) => ({
    object,
    descriptors: Object.getOwnPropertyDescriptors(object),
    frozen: Object.isFrozen(object),
  }));
  return () => {
    for (const { object, descriptors, frozen } of before) {
      expect(Object.isFrozen(object)).toBe(frozen);
      expect(Reflect.ownKeys(object)).toEqual(Reflect.ownKeys(descriptors));
      for (const key of Reflect.ownKeys(descriptors)) {
        const old = Object.getOwnPropertyDescriptor(descriptors, key)!.value as PropertyDescriptor;
        const next = Object.getOwnPropertyDescriptor(object, key)!;
        for (const field of [
          'value',
          'get',
          'set',
          'enumerable',
          'writable',
          'configurable',
        ] as const)
          expect(Object.is(old[field], next[field])).toBe(true);
      }
    }
  };
}

const malformed: {
  name: string;
  mutate: (draft: ReturnType<typeof draftFor>, hit: () => unknown) => unknown;
}[] = [
  ...['baseRevision', 'target', 'longitude', 'latitude', 'scalar', 'scalarNull'].map((key) => ({
    name: `root accessor ${key}`,
    mutate: (draft: ReturnType<typeof draftFor>, hit: () => unknown) =>
      Object.defineProperty(draft, key, { enumerable: true, get: hit }),
  })),
  ...['layerId', 'featureId', 'fieldId'].map((key) => ({
    name: `target accessor ${key}`,
    mutate: (draft: ReturnType<typeof draftFor>, hit: () => unknown) => {
      Object.defineProperty(draft.target, key, { enumerable: true, get: hit });
      return draft;
    },
  })),
  ...['kind', 'sessionId', 'sequence'].map((key) => ({
    name: `revision accessor ${key}`,
    mutate: (draft: ReturnType<typeof draftFor>, hit: () => unknown) => {
      Object.defineProperty(draft.baseRevision, key, { enumerable: true, get: hit });
      return draft;
    },
  })),
  ...['root', 'target', 'revision'].flatMap((level) =>
    [
      'hidden',
      'unknown',
      'symbol',
      'toJSON',
      '__proto__',
      'constructor',
      'prototype',
      'inherited-hook',
      'null-prototype',
      'sparse',
    ].map((kind) => ({
      name: `${level} ${kind}`,
      mutate: (draft: ReturnType<typeof draftFor>, hit: () => unknown) => {
        const value =
          level === 'root' ? draft : level === 'target' ? draft.target : draft.baseRevision;
        if (kind === 'hidden')
          Object.defineProperty(value, Object.keys(value)[0], { enumerable: false });
        else if (kind === 'inherited-hook')
          Object.setPrototypeOf(value, {
            get toJSON() {
              return hit();
            },
          });
        else if (kind === 'null-prototype') Object.setPrototypeOf(value, null);
        else if (kind === 'sparse') {
          const sparse = new Array(100);
          if (level === 'root') return sparse;
          Object.defineProperty(draft, level === 'target' ? 'target' : 'baseRevision', {
            enumerable: true,
            value: sparse,
          });
        } else
          Object.defineProperty(value, kind === 'symbol' ? Symbol('hidden') : kind, {
            enumerable: true,
            get: hit,
          });
        return draft;
      },
    })),
  ),
  { name: 'root null', mutate: () => null },
  {
    name: 'missing target field',
    mutate: (d) => {
      Reflect.deleteProperty(d.target, 'fieldId');
      return d;
    },
  },
  {
    name: 'number object with valueOf',
    mutate: (d, hit) => {
      Object.defineProperty(d, 'longitude', { value: { valueOf: hit }, enumerable: true });
      return d;
    },
  },
  {
    name: 'scalar toString hook',
    mutate: (d, hit) => {
      Object.defineProperty(d, 'scalar', { value: { toString: hit }, enumerable: true });
      return d;
    },
  },
  {
    name: 'wrong scalarNull type',
    mutate: (d) => Object.defineProperty(d, 'scalarNull', { value: 'false', enumerable: true }),
  },
  {
    name: 'target wrong ID type',
    mutate: (d) => {
      Object.defineProperty(d.target, 'featureId', { value: 1, enumerable: true });
      return d;
    },
  },
  ...[NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'].map((value) => ({
    name: `invalid sequence ${value}`,
    mutate: (d: ReturnType<typeof draftFor>) => {
      Object.defineProperty(d.baseRevision, 'sequence', { value, enumerable: true });
      return d;
    },
  })),
  {
    name: 'wrong revision kind',
    mutate: (d) => {
      Object.defineProperty(d.baseRevision, 'kind', { value: 'committed', enumerable: true });
      return d;
    },
  },
];
for (const { name, mutate } of malformed)
  it(`malformed non-UI ${name}: no getter, no canonical/history change`, async () => {
    const h = editHarness();
    const initial = draftFor(h.handle.context.basic.read(), target);
    expect(h.port.execute({ ...initial, scalar: '20' }).state).toBe('applied');
    expect(h.port.undo().state).toBe('applied');
    const before = h.binding.session.content,
      revision = h.binding.session.revision;
    const undo = h.binding.session.canUndo,
      redo = h.binding.session.canRedo;
    const draft = draftFor(h.handle.context.basic.read(), target);
    let calls = 0;
    const input = mutate(draft, () => {
      calls++;
      return 'point-2';
    });
    const checkInput = unchangedDescriptors(input);
    const hash = await contentHash(before);
    expect(() => h.port.prepare(h.handle.context.basic.read(), input)).toThrow(/^GeoDraft/);
    expect(h.port.execute(input)).toMatchObject({ state: 'refused', code: 'GeoEditRefused' });
    expect(calls).toBe(0);
    expect(h.binding.session.content).toEqual(before);
    expect(h.binding.session.revision).toEqual(revision);
    expect(h.binding.session.canUndo).toBe(undo);
    expect(h.binding.session.canRedo).toBe(redo);
    expect(await contentHash(h.binding.session.content)).toBe(hash);
    checkInput();
    expect(calls).toBe(0);
  });

it('valid captured data is deeply frozen and later caller mutation cannot retarget a prepared command', async () => {
  const { capturePointDraft } = await import('./draft-boundary');
  const h = editHarness(),
    snapshot = h.handle.context.basic.read(),
    input = draftFor(snapshot, target);
  input.longitude = '12.5';
  input.scalar = '99';
  const captured = capturePointDraft(input);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.target)).toBe(true);
  expect(Object.isFrozen(captured.baseRevision)).toBe(true);
  const prepared = h.port.prepare(snapshot, input);
  input.target.featureId = 'point-2';
  input.longitude = '13.5';
  input.scalar = '0';
  Object.defineProperty(input.baseRevision, 'sequence', { value: 999 });
  expect(captured.target.featureId).toBe('point-1');
  expect(captured.longitude).toBe('12.5');
  expect(h.editor.execute(prepared).state).toBe('applied');
  const features = h.binding.session.content.layers[0].features;
  expect(features[0]).toMatchObject({
    geometry: { type: 'Point', coordinates: [12.5, 34] },
    values: { metric: 99 },
  });
  expect(features[1].values.metric).toBe(10);
});

it('draftFor target boundary also refuses accessors without invoking them; frozen normal data is accepted', () => {
  const h = editHarness(),
    snapshot = h.handle.context.basic.read();
  let calls = 0;
  const input = { ...target };
  Object.defineProperty(input, 'featureId', {
    enumerable: true,
    get() {
      calls++;
      return 'point-1';
    },
  });
  expect(() => draftFor(snapshot, input)).toThrow('GeoDraftData');
  expect(calls).toBe(0);
  const valid = draftFor(snapshot, Object.freeze({ ...target }));
  Object.freeze(valid.target);
  Object.freeze(valid.baseRevision);
  Object.freeze(valid);
  expect(h.port.execute(valid).state).toBe('unchanged');
  expect(h.binding.session.canUndo).toBe(false);
});

it('bounds numeric text before Number can collapse a huge finite zero-padded value', async () => {
  const h = editHarness(),
    snapshot = h.handle.context.basic.read(),
    base = draftFor(snapshot, target);
  const exact = { ...base, longitude: '0'.repeat(126) + '12' };
  expect(exact.longitude.length).toBe(POINT_INPUT_LIMITS.numericCodeUnits);
  expect(h.port.execute(exact).state).toBe('unchanged');
  const before = h.binding.session.content,
    hash = await contentHash(before),
    revision = h.binding.session.revision;
  for (const patch of [
    { longitude: '0'.repeat(127) + '12' },
    { latitude: '0'.repeat(1000000) + '34' },
    { scalar: '0'.repeat(1000000) + '10' },
  ]) {
    const input = { ...base, ...patch },
      check = unchangedDescriptors(input);
    expect(h.port.execute(input)).toMatchObject({ state: 'refused', message: 'GeoDraftTextLimit' });
    expect(h.binding.session.content).toEqual(before);
    expect(await contentHash(h.binding.session.content)).toBe(hash);
    expect(h.binding.session.revision).toEqual(revision);
    expect(h.binding.session.canUndo).toBe(false);
    expect(h.binding.session.canRedo).toBe(false);
    check();
  }
});
it('scalar character bound and exact whole-draft UTF8 bound are independent, with no truncation', async () => {
  const h = editHarness(),
    base = draftFor(h.handle.context.basic.read(), { ...target, fieldId: 'code' });
  expect(capturePointDraft({ ...base, scalar: 'x'.repeat(4096) }).scalar.length).toBe(4096);
  expect(() => capturePointDraft({ ...base, scalar: 'x'.repeat(4097) })).toThrow(
    'GeoDraftTextLimit',
  );
  const overhead = new TextEncoder().encode(JSON.stringify({ ...base, scalar: '' })).length;
  const remaining = 8192 - overhead;
  const exact = {
    ...base,
    scalar: '界'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3),
  };
  expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(8192);
  expect(capturePointDraft(exact).scalar).toBe(exact.scalar);
  const rejected = { ...exact, scalar: exact.scalar + 'x' },
    check = unchangedDescriptors(rejected),
    before = h.binding.session.content,
    hash = await contentHash(before),
    revision = h.binding.session.revision;
  expect(h.port.execute(rejected)).toMatchObject({
    state: 'refused',
    message: 'GeoDraftByteLimit',
  });
  expect(h.binding.session.content).toEqual(before);
  expect(await contentHash(h.binding.session.content)).toBe(hash);
  expect(h.binding.session.revision).toEqual(revision);
  expect(h.binding.session.canUndo).toBe(false);
  check();
  expect(h.port.execute(exact).state).toBe('applied');
  expect(h.binding.session.content.layers[0].features[0].values.code).toBe(exact.scalar);
});
