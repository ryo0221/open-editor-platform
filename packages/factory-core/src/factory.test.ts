import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  FactoryRandom,
  applyFactoryOperation,
  distributionMean,
  f170SmallLine,
  factoryContentHash,
  factoryEditorCommand,
  factoryWarnings,
  freshFactoryId,
  sampleDistribution,
  validateFactory,
  type FactoryDistribution,
  type FactoryDocument,
} from './index';

const codes = (v: unknown) => validateFactory(v).map((d) => `${d.code}@${d.path}`);
const withObject = (patch: (doc: FactoryDocument) => void) => {
  const doc = f170SmallLine();
  patch(doc);
  return doc;
};

describe('FT1a factory model (TS-2651)', () => {
  it('refuses wrong shapes, values and references with code and path', () => {
    expect(codes({ ...f170SmallLine(), schemaVersion: 2 })).toEqual(['schema@$.schemaVersion']);
    expect(codes({ ...f170SmallLine(), extra: 1 })).toEqual(['unknown-key@$.extra']);
    expect(codes(JSON.parse('{"__proto__":{}}'))).toEqual(['json-key@$']);
    expect(
      codes(
        withObject((d) => {
          d.objects[1] = { ...d.objects[1]!, id: 'machining', count: 0 } as never;
        }),
      ),
    ).toEqual(['count@$.objects.1.count']);
    expect(
      codes(
        withObject((d) => {
          d.objects.push({ ...d.objects[0]!, id: 'machining' });
        }),
      ),
    ).toEqual(['duplicate-id@$.objects.9.id']);
    expect(
      codes(
        withObject((d) => {
          d.retiredIds = ['test'];
        }),
      ),
    ).toEqual([
      'retired-id@$.objects.7.id',
      // The refused object is not there for its links either.
      'object-missing@$.links.6.to',
      'object-missing@$.links.7.from',
    ]);
    expect(
      codes(
        withObject((d) => {
          (d.objects[7] as { processTime: FactoryDistribution }).processTime = {
            type: 'triangular',
            min: 5,
            mode: 1,
            max: 9,
          };
          (d.objects[6] as { processTime: FactoryDistribution }).processTime = {
            type: 'normal',
            mean: -1,
            sd: 1,
          };
          (d.objects[0] as { interval: FactoryDistribution }).interval = {
            type: 'empirical',
            values: [{ value: 1, weight: 0 }],
          };
          (d.objects[2] as { capacity: number }).capacity = 1.5;
        }),
      ),
    ).toEqual([
      'weight@$.objects.0.interval.values',
      'capacity@$.objects.2.capacity',
      'time@$.objects.6.processTime.mean',
      'range@$.objects.7.processTime',
    ]);
    expect(
      codes(
        withObject((d) => {
          d.links.push({ id: 'x1', from: 'out', to: 'test' });
          d.links.push({ id: 'x2', from: 'test', to: 'in-housing' });
          d.links.push({ id: 'x3', from: 'test', to: 'test' });
          d.links.push({ id: 'x4', from: 'test', to: 'nowhere', productIds: ['ghost'] });
          d.links.push({ id: 'x5', from: 'assembly', to: 'test' });
        }),
      ),
    ).toEqual([
      'link-from-drain@$.links.8.from',
      'link-to-source@$.links.9.to',
      'self-link@$.links.10',
      'object-missing@$.links.11.to',
      'product-missing@$.links.11.productIds.0',
      'duplicate-link@$.links.12',
    ]);
    expect(
      codes(
        withObject((d) => {
          const asm = d.objects[6] as { components: { productId: string; count: number }[] };
          asm.components = [
            { productId: 'housing', count: 1 },
            { productId: 'gearset', count: 0 },
          ];
        }),
      ),
    ).toEqual([
      'duplicate@$.objects.6.components.0.productId',
      'count@$.objects.6.components.1.count',
    ]);
    expect(
      codes(
        withObject((d) => {
          d.objects.push({ id: 'q1', name: 'q1', kind: 'buffer', capacity: 1 });
          d.objects.push({ id: 'q2', name: 'q2', kind: 'buffer', capacity: 1 });
          d.links.push({ id: 'y1', from: 'q1', to: 'q2' }, { id: 'y2', from: 'q2', to: 'q1' });
        }),
      ),
    ).toEqual(['buffer-loop@$.links']);
    expect(codes(withObject((d) => (d.run = { durationMs: 0, seed: -1 })))).toEqual([
      'time@$.run.durationMs',
      'seed@$.run.seed',
    ]);
  });

  it('checks a CAD look reference (FT4c, TS-2668)', () => {
    const ok = withObject((d) => {
      d.objects[0]!.look = { artifactId: 'cad-1', versionId: 'v-1', contentHash: 'abc' };
    });
    expect(codes(ok)).toEqual([]);
    const bad = withObject((d) => {
      d.objects[0]!.look = { artifactId: '', versionId: 'v', contentHash: 'h', extra: 1 } as never;
      d.objects[1]!.look = 'x' as never;
      d.objects[2]!.look = { artifactId: 'a', versionId: 'v' } as never;
    });
    expect(codes(bad)).toEqual([
      'unknown-key@$.objects.0.look.extra',
      'look@$.objects.0.look.artifactId',
      'look@$.objects.1.look',
      'missing@$.objects.2.look.contentHash',
    ]);
  });

  it('warns about objects without links and assembly parts no source can bring', () => {
    const doc = withObject((d) => {
      d.links = d.links.filter((l) => l.from !== 'buffer-gear' && l.to !== 'out');
    });
    expect(factoryWarnings(doc).map((w) => `${w.code}@${w.path}`)).toEqual([
      'no-exit@$.objects.5',
      'part-unreachable@$.objects.6.components.0',
      'no-exit@$.objects.7',
      'no-entry@$.objects.8',
    ]);
    const filtered = withObject((d) => {
      d.links.find((l) => l.to === 'machining')!.productIds = ['gearset'];
    });
    expect(factoryWarnings(filtered).map((w) => `${w.code}@${w.path}`)).toEqual([
      'part-unreachable@$.objects.6.mainProductId',
    ]);
  });

  it('samples each distribution as whole non-negative milliseconds around its mean', () => {
    const cases: FactoryDistribution[] = [
      { type: 'const', value: 1234.4 },
      { type: 'uniform', min: 1000, max: 3000 },
      { type: 'triangular', min: 1000, mode: 1500, max: 5000 },
      { type: 'normal', mean: 2000, sd: 500 },
      { type: 'lognormal', mean: 2000, sd: 800 },
      { type: 'exponential', mean: 2000 },
      {
        type: 'empirical',
        values: [
          { value: 1000, weight: 1 },
          { value: 4000, weight: 3 },
        ],
      },
    ];
    for (const d of cases) {
      const rng = new FactoryRandom(42, d.type);
      const n = 20000;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const v = sampleDistribution(d, rng);
        expect(Number.isInteger(v) && v >= 0).toBe(true);
        sum += v;
      }
      expect(Math.abs(sum / n - distributionMean(d)) / distributionMean(d)).toBeLessThan(0.03);
    }
    const truncated = new FactoryRandom(1, 't');
    for (let i = 0; i < 1000; i++) {
      const v = sampleDistribution(
        { type: 'normal', mean: 100, sd: 1000, min: 50, max: 150 },
        truncated,
      );
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(150);
    }
    // Streams are per name: the same seed and name repeat, another name differs.
    expect(new FactoryRandom(5, 'a').next()).toBe(new FactoryRandom(5, 'a').next());
    expect(new FactoryRandom(5, 'a').next()).not.toBe(new FactoryRandom(5, 'b').next());
  });

  it('applies operations whole or not at all, retiring removed IDs', () => {
    const doc = f170SmallLine();
    const next = applyFactoryOperation(doc, { type: 'removeObject', id: 'conveyor-1' });
    expect(next.objects.some((o) => o.id === 'conveyor-1')).toBe(false);
    expect(next.links.some((l) => l.from === 'conveyor-1' || l.to === 'conveyor-1')).toBe(false);
    expect(next.retiredIds).toEqual(['conveyor-1', 'buffer-1>conveyor-1', 'conveyor-1>assembly']);
    expect(freshFactoryId(next, 'conveyor-1')).toBe('conveyor-1-2');
    expect(() =>
      applyFactoryOperation(next, {
        type: 'putObject',
        object: { id: 'conveyor-1', name: 'again', kind: 'drain' },
      }),
    ).toThrow('conveyor-1 was removed before');
    expect(() => applyFactoryOperation(doc, { type: 'removeProduct', id: 'gearset' })).toThrow(
      'in-gearset uses this product',
    );
    expect(() =>
      applyFactoryOperation(doc, {
        type: 'putObject',
        object: {
          id: 'test',
          name: 'Test',
          kind: 'source',
          interval: { type: 'const', value: 1 },
          mix: [{ productId: 'eaxle', weight: 1 }],
        },
      }),
    ).toThrow('a source cannot have links in');
    expect(() =>
      applyFactoryOperation(doc, { type: 'putLink', link: { id: 'z', from: 'out', to: 'test' } }),
    ).toThrow('a drain has no exit');
    const added = applyFactoryOperation(doc, {
      type: 'putObject',
      object: { id: 'q', name: 'Q', kind: 'buffer', capacity: 3 },
      index: 0,
    });
    expect(added.objects[0]!.id).toBe('q');
    expect(doc.objects[0]!.id).toBe('in-housing');
  });

  it('edits through one Undo step per command, checking base and authority', () => {
    const doc = f170SmallLine();
    const session = new EditorSession(doc);
    const cmd = (canEdit = () => true) =>
      factoryEditorCommand(
        [
          { type: 'renameDocument', name: 'Renamed' },
          { type: 'setRun', run: { durationMs: 3_600_000, seed: 9 } },
        ],
        { expectedHash: factoryContentHash(session.content), canEdit },
      );
    session.execute(cmd());
    expect(session.content.name).toBe('Renamed');
    expect(session.content.run.seed).toBe(9);
    session.undo();
    expect(session.content).toEqual(doc);
    const stale = factoryEditorCommand(
      { type: 'renameDocument', name: 'x' },
      { expectedHash: 'f'.repeat(64), canEdit: () => true },
    );
    expect(() => session.execute(stale)).toThrow('factory-base-mismatch');
    expect(() => session.execute(cmd(() => false))).toThrow('permission-denied');
    expect(session.content).toEqual(doc);
  });
});
