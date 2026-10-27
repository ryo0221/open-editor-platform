import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createKernelJobs,
  kernelLoadMarksOf,
  resolveKernelBuild,
  vertexNormals,
  type KernelCatalog,
} from './index';

describe('geometry-kernel-occt (R2c-1)', () => {
  it('names the start-up marks of a domain', () => {
    expect(kernelLoadMarksOf('bim-kernel')).toEqual({
      start: 'bim-kernel:load-start',
      fetched: 'bim-kernel:fetched',
      verified: 'bim-kernel:verified',
      moduleLoaded: 'bim-kernel:module-loaded',
      compiled: 'bim-kernel:compiled',
      instantiated: 'bim-kernel:instantiated',
    });
    expect(Object.isFrozen(kernelLoadMarksOf('x'))).toBe(true);
  });

  it('resolves a profile exactly, by an approved substitute, or not at all', () => {
    const b = (h: string) => ({ buildHash: h, label: h });
    const catalog: KernelCatalog<ReturnType<typeof b>> = {
      current: b('new'),
      retained: [b('old'), b('bad')],
      revoked: ['bad'],
      substitutes: [{ from: 'gone', to: 'new', semanticsVersion: 2 }],
    };
    expect(resolveKernelBuild(catalog, { buildHash: 'old', semanticsVersion: 1 })).toEqual({
      mode: 'exact',
      build: b('old'),
    });
    expect(resolveKernelBuild(catalog, { buildHash: 'gone', semanticsVersion: 2 })).toEqual({
      mode: 'reference',
      build: b('new'),
      from: 'gone',
    });
    expect(resolveKernelBuild(catalog, { buildHash: 'gone', semanticsVersion: 1 }).mode).toBe(
      'unavailable',
    );
    expect(resolveKernelBuild(catalog, { buildHash: 'bad', semanticsVersion: 1 })).toEqual({
      mode: 'unavailable',
      code: 'kernel-build-revoked',
    });
  });

  it('runs jobs one at a time and refuses one cancelled before it starts', async () => {
    const jobs = createKernelJobs();
    const order: string[] = [];
    let release!: () => void;
    const first = jobs.enqueue(
      () =>
        new Promise<void>((resolve) => {
          order.push('a:start');
          release = () => (order.push('a:end'), resolve());
        }),
    );
    jobs.cancel('b');
    const second = jobs.enqueue(async () => void order.push(jobs.take('b') ? 'b' : 'b:refused'));
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:refused']);
    // The cancel was consumed; a running job sees a later one at its own cancel points.
    expect(jobs.take('b')).toBe(true);
    jobs.cancel('c');
    expect(jobs.cancelled('c')).toBe(true);
    jobs.finish('c');
    expect(jobs.cancelled('c')).toBe(false);
  });

  it('gives each node the normalised sum of its triangles’ normals', () => {
    // Two triangles folded along x: the shared nodes get the mean direction.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5]);
    const n = vertexNormals(positions, [0, 1, 2, 1, 0, 3]);
    const r = Math.SQRT1_2;
    expect([...n].map((v) => Math.round(v * 1e6) / 1e6)).toEqual(
      [0, r, r, 0, r, r, 0, 0, 1, 0, 1, 0, 0, 0, 0].map((v) => Math.round(v * 1e6) / 1e6),
    );
  });

  it('keeps bim and geometry packages free of CAD packages (ADR 017)', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const packages = readdirSync(root).filter((p) => /^(bim|bim-.+|geometry-.+)$/.test(p));
    expect(packages).toEqual(
      expect.arrayContaining([
        'bim',
        'bim-core',
        'bim-ifc',
        'geometry-core',
        'geometry-kernel-occt',
      ]),
    );
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const path = join(dir, f);
        return statSync(path).isDirectory()
          ? sources(path)
          : /\.(ts|tsx|mjs|js)$/.test(f)
            ? [path]
            : [];
      });
    const cad = /@editor-platform\/cad\b/;
    for (const p of packages) {
      const manifest = JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      expect(
        deps.filter((d) => cad.test(d)),
        p,
      ).toEqual([]);
      for (const file of sources(join(root, p, 'src')))
        expect(cad.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });
});
