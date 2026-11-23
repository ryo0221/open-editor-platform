import { expect, it } from 'vitest';
import {
  listLiveOptions,
  validLiveReference,
  validLiveReferenceItems,
  validReferenceSnapshot,
  type LiveOption,
  type LiveReference,
  type LiveReferenceProvider,
} from './index';

const snapshot = {
  artifactId: 'source',
  domain: 'budget',
  versionId: 'v1',
  revision: 1,
  contentHash: 'a'.repeat(64),
  content: null,
  dependencies: [],
};
const value: LiveReference = {
  schemaVersion: 2,
  mode: 'fixed',
  source: {
    artifactId: snapshot.artifactId,
    domain: snapshot.domain,
    target: { kind: 'value', targetId: 'base', metricId: 'npv' },
  },
  snapshot,
  presentation: { kind: 'value', value: 1, format: { style: 'decimal', digits: 2, unit: '' } },
};
const figure: LiveReference = {
  ...value,
  source: { ...value.source, target: { kind: 'figure', figureId: 'map' } },
  presentation: { kind: 'figure', label: '地図' },
};
it('accepts 512 characters and rejects an empty, oversized or forbidden identifier in all six fields', () => {
  for (const field of ['artifactId', 'domain', 'versionId', 'targetId', 'metricId', 'figureId']) {
    const base = field === 'figureId' ? figure : value;
    const test = (part: string) =>
      validLiveReference({
        ...base,
        snapshot: { ...snapshot, ...(field in snapshot ? { [field]: part } : {}) },
        source: {
          ...base.source,
          ...(field === 'artifactId' || field === 'domain' ? { [field]: part } : {}),
          target: {
            ...base.source.target,
            ...(field in base.source.target ? { [field]: part } : {}),
          },
        },
      });
    expect(test('a'.repeat(512)), field).toBe(true);
    for (const part of ['', 'a'.repeat(513), '__proto__', 'prototype', 'constructor']) {
      expect(test(part), field).toBe(false);
    }
  }
});
it('accepts the per-content byte, dependency-count, depth and entry boundaries and rejects the next value', () => {
  const withContent = (content: unknown) => validReferenceSnapshot({ ...snapshot, content });
  expect(withContent('a'.repeat(2_097_150))).toBe(true);
  expect(withContent('a'.repeat(2_097_151))).toBe(false);
  for (const count of [8, 9]) {
    const dependencies = Array.from({ length: count }, (_, i) => ({
      id: String(i),
      contentHash: snapshot.contentHash,
      content: null,
    }));
    expect(validReferenceSnapshot({ ...snapshot, dependencies })).toBe(count === 8);
  }
  const nested = (n: number): unknown => (n === 0 ? null : [nested(n - 1)]);
  expect(withContent(nested(23))).toBe(true);
  expect(withContent(nested(24))).toBe(false);
  expect(withContent(Array.from({ length: 149_992 }, () => null))).toBe(true);
  expect(withContent(Array.from({ length: 149_993 }, () => null))).toBe(false);
});
it('accepts a 4 MiB serialized snapshot closure and 64 quotes, rejecting the next byte or quote', () => {
  const closure = {
    ...snapshot,
    content: 'a'.repeat(2_097_150),
    dependencies: [{ id: 'dep', contentHash: snapshot.contentHash, content: '' }],
  };
  const maxDependency = 4_194_304 - Buffer.byteLength(JSON.stringify(closure));
  closure.dependencies[0].content = 'a'.repeat(maxDependency);
  expect(validReferenceSnapshot(closure)).toBe(true);
  closure.dependencies[0].content += 'a';
  expect(validReferenceSnapshot(closure)).toBe(false);
  expect(
    validLiveReferenceItems(
      Array.from({ length: 64 }, () => value),
      [],
    ),
  ).toBe(true);
  expect(
    validLiveReferenceItems(
      Array.from({ length: 65 }, () => value),
      [],
    ),
  ).toBe(false);
});
it('enforces inclusive formatting ranges and accepts 256 characters but rejects 257', async () => {
  const checkFormat = (digits: number, unit: string) =>
    validLiveReference({
      ...value,
      presentation: { kind: 'value', value: 1, format: { style: 'decimal', digits, unit } },
    });
  expect(checkFormat(0, '')).toBe(true);
  expect(checkFormat(6, '単'.repeat(256))).toBe(true);
  for (const digits of [-1, 0.5, 7]) expect(checkFormat(digits, '')).toBe(false);
  expect(checkFormat(6, '単'.repeat(257))).toBe(false);
  for (const length of [256, 257]) {
    const label = '図'.repeat(length);
    expect(validLiveReference({ ...figure, presentation: { kind: 'figure', label } })).toBe(
      length === 256,
    );
    const provider = providerFor([{ kind: 'figure', figureId: 'map', label }]);
    if (length === 256) await expect(listLiveOptions(snapshot, provider)).resolves.toHaveLength(1);
    else await expect(listLiveOptions(snapshot, provider)).rejects.toThrow();
  }
});
function providerFor(options: LiveOption[]): LiveReferenceProvider {
  return {
    checkAccess() {},
    checkSnapshot() {},
    list: () => options,
    resolve: () => ({ kind: 'value', value: 1 }),
  };
}
it('allows up to 1000 options independently per kind and rejects 1001', async () => {
  const options = (nValues: number, nFigures: number): LiveOption[] => [
    ...Array.from({ length: nValues }, (_, i) => ({
      kind: 'value' as const,
      targetId: 'base',
      metricId: `metric-${i}`,
      label: '値',
    })),
    ...Array.from({ length: nFigures }, (_, i) => ({
      kind: 'figure' as const,
      figureId: `figure-${i}`,
      label: '図',
    })),
  ];
  await expect(listLiveOptions(snapshot, providerFor(options(1000, 1000)))).resolves.toHaveLength(
    2000,
  );
  await expect(listLiveOptions(snapshot, providerFor(options(1001, 1000)))).rejects.toThrow();
  await expect(listLiveOptions(snapshot, providerFor(options(1000, 1001)))).rejects.toThrow();
});
