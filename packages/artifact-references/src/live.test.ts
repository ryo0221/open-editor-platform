import { describe, expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  changeLiveReference,
  compareLiveReference,
  createLiveReference,
  deferLiveReference,
  formatLiveValue,
  updateLiveReference,
  validLiveReference,
  verifyRetainedLiveReference,
  ReferenceError,
  type LiveReferenceProvider,
  type LiveSource,
  type ReferenceSnapshot,
} from './index';

const source: LiveSource = {
  artifactId: 'budget',
  domain: 'finance',
  target: { kind: 'value', targetId: 'base', metricId: 'npv' },
};
const format = { style: 'decimal' as const, digits: 2, unit: '円' };
const figureSource: LiveSource = { ...source, target: { kind: 'figure', figureId: 'map' } };
async function snapshot(revision: number): Promise<ReferenceSnapshot> {
  const content = { value: revision };
  return {
    artifactId: 'budget',
    domain: 'finance',
    versionId: `v${revision}`,
    revision,
    content,
    contentHash: await contentHash(content),
    dependencies: [],
  };
}
const provider: LiveReferenceProvider = {
  checkAccess() {},
  checkSnapshot() {},
  list: () => [
    { ...source.target, label: 'NPV' },
    { kind: 'figure', figureId: 'map', label: '地図' },
  ],
  resolve: (s, t) =>
    t.kind === 'value'
      ? { kind: 'value', value: (s.content as { value: number }).value }
      : { kind: 'figure', label: '地図', src: 'data:image/png;base64,YQ==' },
};
describe('live references', () => {
  it.each([
    ['scenario', { ...source, target: { kind: 'value', targetId: 'missing', metricId: 'npv' } }],
    ['metric', { ...source, target: { kind: 'value', targetId: 'base', metricId: 'missing' } }],
    ['figure', { ...source, target: { kind: 'figure', figureId: 'missing' } }],
  ] as const)('rejects an unlisted %s before resolving it', async (_label, requested) => {
    const saved = await snapshot(1);
    await expect(
      createLiveReference(
        requested,
        saved,
        {
          ...provider,
          resolve: () => {
            throw Error('Unlisted target must not reach the adapter');
          },
        },
        format,
      ),
    ).rejects.toMatchObject({ status: 'missing-target', message: '保存版に対象がありません。' });
  });

  it('rejects a missing figure, unavailable saved version and conflicting version during update', async () => {
    const first = await createLiveReference(figureSource, await snapshot(1), provider);
    const previous = structuredClone(first);
    const latest = await snapshot(2);
    await expect(
      updateLiveReference(first, latest, {
        ...provider,
        list: (saved) => (saved.revision === 1 ? provider.list(saved) : []),
      }),
    ).rejects.toMatchObject({ status: 'missing-target', message: '保存版に対象がありません。' });
    await expect(
      updateLiveReference(first, latest, {
        ...provider,
        checkSnapshot: (_source, saved) => {
          if (saved.versionId === latest.versionId)
            throw new ReferenceError('offline', '保存版を取得できません。');
        },
      }),
    ).rejects.toMatchObject({ status: 'offline', message: '保存版を取得できません。' });
    await expect(
      updateLiveReference(first, { ...latest, versionId: first.snapshot.versionId }, provider),
    ).rejects.toThrow('同じ版の内容が矛盾しています。');
    expect(first).toEqual(previous);
  });

  it('creates and validates fixed value and figure references', async () => {
    const first = await snapshot(1);
    const value = await createLiveReference(source, first, provider, format);
    expect(validLiveReference(value)).toBe(true);
    expect(
      formatLiveValue(value.presentation as Extract<typeof value.presentation, { kind: 'value' }>),
    ).toBe('1.00円');
    const figure = await createLiveReference(
      { ...source, target: { kind: 'figure', figureId: 'map' } },
      first,
      provider,
    );
    expect(figure.presentation).toEqual({ kind: 'figure', label: '地図' });
    const updatedFigure = await updateLiveReference(figure, await snapshot(2), provider);
    expect(updatedFigure.snapshot.revision).toBe(2);
    await expect(
      updateLiveReference(figure, await snapshot(2), { ...provider, list: () => [] }),
    ).rejects.toThrow();
    expect(validLiveReference({ ...value, mode: 'follow' })).toBe(false);
  });
  it('compares without mutation and updates only the selected item', async () => {
    const first = await createLiveReference(source, await snapshot(1), provider, format);
    const second = await snapshot(2);
    const items = [
      { id: 'a', reference: first },
      { id: 'b', reference: first },
    ];
    expect(await compareLiveReference(first, first.snapshot, provider)).toBe('same');
    expect(await compareLiveReference(first, second, provider)).toBe('newer');
    deferLiveReference(items, 'a', first);
    const updated = await updateLiveReference(first, second, provider);
    const changed = changeLiveReference(items, 'a', first, updated);
    expect(changed[1]).toEqual(items[1]);
    expect(items[0].reference.snapshot.revision).toBe(1);
    expect(changeLiveReference(changed, 'a', updated)).toEqual([items[1]]);
    expect(() => changeLiveReference(changed, 'a', first)).toThrow();
  });
  it('rejects contradictory versions, missing targets and denied access', async () => {
    const first = await createLiveReference(source, await snapshot(1), provider, format);
    await expect(
      compareLiveReference(first, { ...first.snapshot, versionId: 'other' }, provider),
    ).rejects.toThrow();
    await expect(
      createLiveReference(source, first.snapshot, { ...provider, list: () => [] }, format),
    ).rejects.toThrow();
    await expect(
      createLiveReference(
        source,
        first.snapshot,
        {
          ...provider,
          checkAccess: () => {
            throw new Error('権限なし');
          },
        },
        format,
      ),
    ).rejects.toThrow('権限なし');
    await expect(
      createLiveReference(source, { ...first.snapshot, content: {} }, provider, format),
    ).rejects.toThrow();
  });
  it('refuses drafts, self references, recursive references and invalid JSON', async () => {
    const saved = await snapshot(1);
    await expect(
      createLiveReference(source, { ...saved, revision: 0 }, provider, format),
    ).rejects.toThrow();
    await expect(createLiveReference(source, saved, provider, format, 'budget')).rejects.toThrow();
    await expect(
      createLiveReference(
        source,
        saved,
        {
          ...provider,
          checkSnapshot: () => {
            throw new Error('draft');
          },
        },
        format,
      ),
    ).rejects.toThrow('draft');
    const recursive = {
      ...saved,
      content: { reference: { schemaVersion: 2, source, snapshot: saved } },
    };
    await expect(createLiveReference(source, recursive, provider, format)).rejects.toThrow();
    await expect(
      createLiveReference(source, { ...saved, content: { value: NaN } }, provider, format),
    ).rejects.toThrow();
  });

  it('rejects a saved version whose content or dependencies already carry a citation', async () => {
    const inner = await createLiveReference(source, await snapshot(1), provider, format);
    // An inner citation whose own snapshot hash is wrong: only the outer hash would be checked.
    const tampered = { ...inner, snapshot: { ...inner.snapshot, contentHash: '0'.repeat(64) } };
    const nestedContent = { value: 2, quote: tampered };
    const nested = {
      ...(await snapshot(2)),
      content: nestedContent,
      contentHash: await contentHash(nestedContent),
    };
    await expect(createLiveReference(source, nested, provider, format)).rejects.toThrow(
      '参照元または保存版が不正です。',
    );
    const dependencyContent = { reference: tampered };
    const inDependency = {
      ...(await snapshot(2)),
      dependencies: [
        {
          id: 'quoted',
          content: dependencyContent,
          contentHash: await contentHash(dependencyContent),
        },
      ],
    };
    await expect(createLiveReference(source, inDependency, provider, format)).rejects.toThrow(
      '参照元または保存版が不正です。',
    );
    const retained = {
      ...(await createLiveReference(source, await snapshot(2), provider, format)),
    };
    expect(validLiveReference({ ...retained, snapshot: nested })).toBe(false);
    await expect(
      verifyRetainedLiveReference({ ...retained, snapshot: nested }, 'deck'),
    ).rejects.toThrow('参照元または保存版が不正です。');
  });

  it('rejects mismatched source identifiers and invalid dependency integrity', async () => {
    const content = { value: 10 };
    const dependency = { id: 'rates', content, contentHash: await contentHash(content) };
    const saved = { ...(await snapshot(1)), dependencies: [dependency] };
    const reference = await createLiveReference(source, saved, provider, format);
    expect(reference.snapshot.dependencies).toEqual([dependency]);
    for (const differentSource of [{ artifactId: 'other' }, { domain: 'other' }]) {
      await expect(
        createLiveReference({ ...source, ...differentSource }, saved, provider, format),
      ).rejects.toThrow('参照元または保存版が不正です。');
    }
    await expect(
      createLiveReference(
        source,
        { ...saved, dependencies: [dependency, dependency] },
        provider,
        format,
      ),
    ).rejects.toThrow('参照元または保存版が不正です。');
    await expect(
      createLiveReference(
        source,
        { ...saved, dependencies: [{ ...dependency, contentHash: '0'.repeat(64) }] },
        provider,
        format,
      ),
    ).rejects.toThrow('参照依存の内容が一致しません。');
  });

  it('rejects reused version IDs and backward revisions during comparison', async () => {
    const saved = await snapshot(2);
    const reference = await createLiveReference(source, saved, provider, format);
    const different = await snapshot(3);
    for (const contradictory of [
      { ...saved, revision: 3 },
      { ...different, revision: saved.revision, versionId: saved.versionId },
    ]) {
      await expect(compareLiveReference(reference, contradictory, provider)).rejects.toThrow(
        '同じ版の内容が矛盾しています。',
      );
    }
    await expect(compareLiveReference(reference, await snapshot(1), provider)).rejects.toThrow(
      '保存版が逆行または矛盾しています。',
    );
  });

  it('formats values with digit grouping and a power-of-ten scale (finding 81)', async () => {
    const at = (value: number, f: Record<string, unknown>) =>
      formatLiveValue({
        kind: 'value',
        value,
        format: { style: 'decimal', digits: 0, unit: '', ...f } as never,
      });
    expect(at(-1281385168, { grouping: true, unit: ' 円' })).toBe('-1,281,385,168 円');
    expect(at(-1281385168, { scale: 8, digits: 1, unit: '億円' })).toBe('-12.8億円');
    expect(at(1234567.891, { grouping: true, digits: 2 })).toBe('1,234,567.89');
    expect(at(12345678, { scale: 4, grouping: true, unit: '万円' })).toBe('1,235万円');
    expect(at(999, { grouping: true })).toBe('999');
    expect(at(-0.081484, { style: 'percent', digits: 1 })).toBe('-8.1%');
    const first = await snapshot(1);
    const scaled = await createLiveReference(source, first, provider, {
      ...format,
      scale: 3,
      grouping: true,
    });
    expect(validLiveReference(scaled)).toBe(true);
    expect(() => at(1, { scale: 5 })).toThrow('表示形式が不正です。');
    expect(() => at(1, { grouping: 'yes' })).toThrow('表示形式が不正です。');
    await expect(
      createLiveReference(source, first, provider, { ...format, scale: 7 as never }),
    ).rejects.toThrow();
  });
});
