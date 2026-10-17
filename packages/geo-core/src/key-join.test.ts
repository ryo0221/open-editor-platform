import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  captureKeyJoinSnapshot,
  runReadonlyKeyJoin,
  type GeoDocument,
  type KeyJoinLimits,
  type KeyJoinSnapshot,
  type Pin,
  type ReadonlyKeyJoin,
  type Scalar,
} from './index';
const limits: KeyJoinLimits = {
  native: {
    bytes: 2_000_000,
    depth: 24,
    layers: 10,
    features: 2000,
    vertices: 10000,
    actions: 1000,
  },
  inputRows: 1000,
  outputRows: 500,
  diagnostics: 2000,
  outputBytes: 2_000_000,
};
const pin = (name: string, versionId = 'v1'): Pin => ({
  artifactId: name,
  versionId,
  contentHash: `sha256:${'a'.repeat(64)}`,
});
function document(
  side: string,
  keys: Scalar[],
  type: 'string' | 'number' | 'boolean' = 'string',
): GeoDocument {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: `source-${side}`,
        pin: pin(`raw-${side}`),
        resourceId: `resource-${side}`,
        bytesHash: `sha256:${'b'.repeat(64)}`,
        format: 'csv',
        adapterVersion: 'synthetic-join',
        declaredCrs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        attribution: 'Synthetic regions',
      },
    ],
    layers: [
      {
        id: side,
        name: 'Regions',
        crs: 'OGC:CRS84',
        axis: 'longitude-latitude',
        fields: [
          { id: 'code', name: 'Region', type },
          { id: 'value', name: 'Metric', type: 'number' },
        ],
        features: keys.map((code, i) => ({
          id: `${side}:f:${i}`,
          rowId: `${side}:r:${i}`,
          geometry: null,
          values: { code, value: i },
          sourceRef: { sourceId: `source-${side}`, externalId: String(i) },
        })),
      },
    ],
  };
}
const capture = (d: GeoDocument, p = pin(d.layers[0].id)) =>
  captureKeyJoinSnapshot(d, d.layers[0].id, p, limits);
const spec = (
  left: KeyJoinSnapshot,
  right: KeyJoinSnapshot,
  cardinality: ReadonlyKeyJoin['cardinality'] = 'one-to-one',
  keyType: ReadonlyKeyJoin['keyType'] = 'string',
): ReadonlyKeyJoin => ({
  left: left.pin,
  right: right.pin,
  leftFieldId: 'code',
  rightFieldId: 'code',
  keyType,
  cardinality,
  normalization: 'none',
  nullPolicy: 'unmatched',
  duplicatePolicy: 'reject',
  resultAccess: 'readonly',
});
describe('M0 readonly key join projection', () => {
  it('UC2 FR03/05 AC05: 47 regions join by stable typed code, independent of right order', () => {
    const keys = Array.from({ length: 47 }, (_, i) => String(i).padStart(2, '0'));
    const leftDoc = document('left', keys),
      rightDoc = document('right', [...keys].reverse());
    const originalLeft = structuredClone(leftDoc),
      originalRight = structuredClone(rightDoc);
    const left = capture(leftDoc),
      right = capture(rightDoc),
      contract = spec(left, right);
    const result = runReadonlyKeyJoin(contract, left, right, limits);
    expect(result.status).toBe('ready');
    expect(result.counts.matchedLeftRows).toBe(47);
    expect(result.rows).toHaveLength(47);
    expect(result.rows[0]).toMatchObject({
      featureId: 'left:f:0',
      rowId: 'left:r:0',
      key: '00',
      status: 'matched',
      leftValues: { code: '00', value: 0 },
      right: { featureId: 'right:f:46', rowId: 'right:r:46', values: { code: '00', value: 46 } },
    });
    expect(result.inputs.left.pin).toEqual(left.pin);
    expect(result.inputs.right.sources[0].bytesHash).toBe(rightDoc.sources[0].bytesHash);
    expect(result.fields.left[1].id).toBe('value');
    expect(result.fields.right[1].id).toBe('value');
    expect(leftDoc).toEqual(originalLeft);
    expect(rightDoc).toEqual(originalRight);
    expect(runReadonlyKeyJoin(contract, left, right, limits)).toEqual(result);
    expect(JSON.stringify(runReadonlyKeyJoin(contract, left, right, limits))).toBe(
      JSON.stringify(result),
    );
  });
  it('UC2 FR05 AC05: no normalization of zeros/whitespace/case/empty strings, null never matches', () => {
    const left = capture(document('left', ['01', '1', '', ' 1', null, 'A']));
    const right = capture(document('right', ['1', '', '01', 'a', null]));
    const result = runReadonlyKeyJoin(spec(left, right), left, right, limits);
    expect(result.status).toBe('ready');
    expect(result.rows.map((r) => r.status)).toEqual([
      'matched',
      'matched',
      'matched',
      'unmatched',
      'null-key',
      'unmatched',
    ]);
    expect(result.rows[2].right?.values.code).toBe('');
    expect(result.rows[4].right).toBeNull();
    expect(result.counts).toMatchObject({
      matchedLeftRows: 3,
      unmatchedLeftRows: 2,
      unusedRightRows: 1,
      nullKeys: { left: 1, right: 1 },
    });
    expect(
      result.diagnostics.filter((d) => d.code === 'unmatched-key').map((d) => d.rowId),
    ).toEqual(['left:r:3', 'left:r:5']);
  });
  it.each(['one-to-one', 'many-to-one'] as const)(
    'UC2 FR05 AC05: right duplicates block %s without first-match or partial result',
    (cardinality) => {
      const left = capture(document('left', ['01', '02'])),
        right = capture(document('right', ['01', '01', '02']));
      const result = runReadonlyKeyJoin(spec(left, right, cardinality), left, right, limits);
      expect(result.status).toBe('blocked');
      expect(result.rows).toEqual([]);
      expect(result.counts.matchedLeftRows).toBe(0);
      expect(result.counts.duplicateKeyRows.right).toBe(2);
      expect(
        result.diagnostics
          .filter((d) => d.code === 'duplicate-key')
          .map((d) => [d.side, d.rowId, d.severity]),
      ).toEqual([
        ['right', 'right:r:0', 'error'],
        ['right', 'right:r:1', 'error'],
      ]);
    },
  );
  it('UC2 FR05 AC05: left repeats are rejected for one-to-one and explicit for many-to-one', () => {
    const left = capture(document('left', ['01', '01'])),
      right = capture(document('right', ['01']));
    expect(runReadonlyKeyJoin(spec(left, right), left, right, limits).status).toBe('blocked');
    const result = runReadonlyKeyJoin(spec(left, right, 'many-to-one'), left, right, limits);
    expect(result.status).toBe('ready');
    expect(result.rows.map((r) => r.right?.rowId)).toEqual(['right:r:0', 'right:r:0']);
    expect(result.counts.matchedLeftRows).toBe(2);
    expect(result.counts.duplicateKeyRows.left).toBe(2);
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['repeated-left-key', 'warning'],
      ['repeated-left-key', 'warning'],
    ]);
  });
  it('UC2 FR05 AC05: missing field, missing cell, null and schema type mismatch are distinct', () => {
    const left = capture(document('left', ['1'])),
      right = capture(document('right', [1], 'number'));
    const typed = runReadonlyKeyJoin(spec(left, right), left, right, limits);
    expect(typed.status).toBe('blocked');
    expect(typed.counts.typeMismatchRows.right).toBe(1);
    expect(typed.counts.unmatchedLeftRows).toBe(0);
    expect(typed.diagnostics.some((d) => d.code === 'key-type-mismatch')).toBe(true);
    const missing = runReadonlyKeyJoin(
      { ...spec(left, right), leftFieldId: 'absent' },
      left,
      right,
      limits,
    );
    expect(missing.counts.missingKeyRows.left).toBe(1);
    expect(missing.diagnostics.some((d) => d.code === 'missing-key-field')).toBe(true);
    const malformed = document('broken', ['1']);
    delete malformed.layers[0].features[0].values.code;
    expect(() => capture(malformed)).toThrow('scalar-schema');
    const nullLeft = capture(document('null-left', [null, null])),
      nullRight = capture(document('null-right', [null, null]));
    const nulls = runReadonlyKeyJoin(spec(nullLeft, nullRight), nullLeft, nullRight, limits);
    expect(nulls.status).toBe('ready');
    expect(nulls.counts.duplicateKeyRows).toEqual({ left: 0, right: 0 });
    expect(nulls.rows.every((r) => r.status === 'null-key' && r.right === null)).toBe(true);
  });
  it('UC2 FR05 AC05: explicit finite numeric keys match zero and leave null separate', () => {
    const left = capture(document('left', [0, 1, null], 'number')),
      right = capture(document('right', [1, 0, null], 'number'));
    const result = runReadonlyKeyJoin(
      spec(left, right, 'one-to-one', 'number'),
      left,
      right,
      limits,
    );
    expect(result.rows[0].right?.values.code).toBe(0);
    expect(result.rows[1].right?.values.code).toBe(1);
    expect(result.rows[2].right).toBeNull();
    const bad = document('bad', [Infinity], 'number');
    expect(() => capture(bad)).toThrow('unsafe-json-or-depth');
  });
  it('FR03/08 AC05/08: captured sources and results remain frozen when live originals change', () => {
    const rawLeft = document('left', ['01']),
      rawRight = document('right', ['01']);
    const declared = pin('right');
    const left = capture(rawLeft),
      right = capture(rawRight, declared),
      contract = spec(left, right);
    const result = runReadonlyKeyJoin(contract, left, right, limits),
      encoded = JSON.stringify(result);
    rawRight.layers[0].features[0].values.value = 99;
    rawRight.sources[0].bytesHash = `sha256:${'c'.repeat(64)}`;
    declared.versionId = 'v2';
    expect(JSON.stringify(result)).toBe(encoded);
    expect(right.layer.features[0].values.value).toBe(0);
    expect(right.pin.versionId).toBe('v1');
    expect(Object.isFrozen(result.rows[0].right!.values)).toBe(true);
    expect(Object.isFrozen(right.sources[0].pin)).toBe(true);
    expect(() => {
      (result.rows[0].right!.values as Record<string, Scalar>).value = 8;
    }).toThrow();
    const refreshed = capture(rawRight, pin('right', 'v2'));
    expect(() => runReadonlyKeyJoin(contract, left, refreshed, limits)).toThrow(
      'join-pin-mismatch',
    );
    const changed = runReadonlyKeyJoin(spec(left, refreshed), left, refreshed, limits);
    expect(changed.rows[0].right?.values.value).toBe(99);
    expect(JSON.stringify(result)).toBe(encoded);
  });
  it('FR07 AC03: pure projection does not change EditorSession content/revision/history', () => {
    const session = new EditorSession(document('left', ['01'])),
      before = session.content,
      revision = session.revision;
    const left = capture(session.content),
      right = capture(document('right', ['01']));
    runReadonlyKeyJoin(spec(left, right), left, right, limits);
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
    expect(session.canRedo).toBe(false);
  });
  it('FR01/10 AC02/11: native/contract sparse, getter and hidden hooks reject before clone/calls', () => {
    let calls = 0;
    const raw = document('left', ['01']);
    Object.defineProperty(raw.layers[0].features[0].values, 'code', {
      enumerable: true,
      get() {
        calls++;
        return '01';
      },
    });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(() => capture(raw)).toThrow('unsafe-json-or-depth');
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    const sparse = document('sparse', ['01']);
    sparse.layers[0].features = new Array(1);
    expect(() => capture(sparse)).toThrow('unsafe-json-or-depth');
    const left = capture(document('left', ['01'])),
      right = capture(document('right', ['01']));
    const contract = spec(left, right);
    Object.defineProperty(contract, 'toJSON', {
      value() {
        calls++;
        return {};
      },
    });
    expect(() => runReadonlyKeyJoin(contract, left, right, limits)).toThrow('unsafe-json-or-depth');
    const getter = spec(left, right);
    Object.defineProperty(getter, 'keyType', {
      enumerable: true,
      get() {
        calls++;
        return 'string';
      },
    });
    expect(() => runReadonlyKeyJoin(getter, left, right, limits)).toThrow('unsafe-json-or-depth');
    expect(calls).toBe(0);
    expect(() =>
      runReadonlyKeyJoin(spec(left, right), structuredClone(left), right, limits),
    ).toThrow('join-unissued-snapshot');
  });
  it('FR01 AC02: capture and execution row limits reject before clone or later input visit', () => {
    let visits = 0;
    const late = new Proxy(
      {},
      {
        getPrototypeOf() {
          visits++;
          throw new Error('visited');
        },
      },
    );
    const raw = document('left', ['01', '02']);
    raw.layers[0].features[1] = late as (typeof raw.layers)[0]['features'][number];
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(() =>
        captureKeyJoinSnapshot(raw, 'left', pin('left'), { ...limits, inputRows: 1 }),
      ).toThrow('feature-limit');
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expect(visits).toBe(0);
    const left = capture(document('left', ['01', '02'])),
      right = capture(document('right', ['01', '02']));
    const check = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(() =>
        runReadonlyKeyJoin(spec(left, right), left, right, { ...limits, inputRows: 3 }),
      ).toThrow('join-input-row-limit');
      expect(() =>
        runReadonlyKeyJoin(spec(left, right), left, right, { ...limits, outputRows: 1 }),
      ).toThrow('join-output-row-limit');
      expect(check).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
    }
  });
  it('FR01 AC02: diagnostic count and exact UTF-8 result budget bound output growth', () => {
    const nulls = capture(document('nulls', [null, null, null])),
      right = capture(document('right', ['01']));
    expect(() =>
      runReadonlyKeyJoin(spec(nulls, right), nulls, right, { ...limits, diagnostics: 2 }),
    ).toThrow('join-diagnostic-limit');
    const raw = document('left', ['東京']);
    raw.layers[0].name = '日本';
    const left = capture(raw),
      matching = capture(document('matching', ['東京']));
    const contract = spec(left, matching);
    const baseline = runReadonlyKeyJoin(contract, left, matching, limits),
      size = new TextEncoder().encode(JSON.stringify(baseline)).length;
    expect(runReadonlyKeyJoin(contract, left, matching, { ...limits, outputBytes: size })).toEqual(
      baseline,
    );
    expect(() =>
      runReadonlyKeyJoin(contract, left, matching, { ...limits, outputBytes: size - 1 }),
    ).toThrow(/byte-limit/);
  });
  it('FR05/08 AC05/08: policy coercion, conflicting same-version pins and changed snapshot data reject', () => {
    const left = capture(document('left', ['01'])),
      right = capture(document('right', ['01']));
    for (const change of [
      { keyType: ['string'] },
      { normalization: 'trim' },
      { duplicatePolicy: 'first' },
      { cardinality: 'many-to-many' },
      { resultAccess: 'write' },
    ])
      expect(() =>
        runReadonlyKeyJoin(
          { ...spec(left, right), ...change } as ReadonlyKeyJoin,
          left,
          right,
          limits,
        ),
      ).toThrow('join-contract');
    const raw = document('same', ['01']),
      first = capture(raw, pin('same'));
    raw.layers[0].features[0].values.value = 1;
    const changed = capture(raw, pin('same'));
    expect(() => runReadonlyKeyJoin(spec(first, changed), first, changed, limits)).toThrow(
      'join-snapshot-conflict',
    );
    const conflicting = capture(raw, { ...pin('same'), contentHash: `sha256:${'b'.repeat(64)}` });
    expect(() => runReadonlyKeyJoin(spec(first, conflicting), first, conflicting, limits)).toThrow(
      'join-pin-conflict',
    );
  });
  it('FR05 AC05: diagnostics and blocked output are deterministic for repeated failed execution', () => {
    const left = capture(document('left', ['02', null, '01', '01'])),
      right = capture(document('right', ['01', '01', '99', null]));
    const contract = spec(left, right);
    const first = runReadonlyKeyJoin(contract, left, right, limits),
      second = runReadonlyKeyJoin(contract, left, right, limits);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.status).toBe('blocked');
    expect(first.rows).toEqual([]);
    expect(first.diagnostics.map((d) => [d.code, d.side, d.rowId])).toEqual([
      ['null-key', 'left', 'left:r:1'],
      ['duplicate-key', 'left', 'left:r:2'],
      ['duplicate-key', 'left', 'left:r:3'],
      ['null-key', 'right', 'right:r:3'],
      ['duplicate-key', 'right', 'right:r:0'],
      ['duplicate-key', 'right', 'right:r:1'],
      ['unmatched-key', 'left', 'left:r:0'],
      ['unused-right-key', 'right', 'right:r:2'],
    ]);
  });
  it('FR01/05 AC02/05: many-to-one value expansion is capped without changing snapshots', () => {
    const left = capture(document('left', ['01', '01', '01', '01']));
    const raw = document('right', ['01']);
    raw.layers[0].fields[1].type = 'string';
    raw.layers[0].features[0].values.value = 'x'.repeat(3000);
    const right = capture(raw),
      contract = spec(left, right, 'many-to-one'),
      before = JSON.stringify([left, right]);
    expect(() =>
      runReadonlyKeyJoin(contract, left, right, { ...limits, outputBytes: 10000 }),
    ).toThrow(/byte-limit/);
    expect(JSON.stringify([left, right])).toBe(before);
    const result = runReadonlyKeyJoin(contract, left, right, limits);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((r) => r.right?.values.value === 'x'.repeat(3000))).toBe(true);
  });
});
