import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #93：入口（`.`・`./fmea`・`./graph`）から辿れるモジュールに画面の CSS が無いこと。CSS があると、
// CSS を読めない Host（tsx の API、Playwright の spec）は入口を読んだ時点で落ちる。
const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function packageEntry(spec: string): string | undefined {
  const m = /^@editor-platform\/([^/]+)(\/.*)?$/.exec(spec);
  if (!m) return undefined;
  const dir = join(packages, m[1]!);
  const exports = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).exports ?? {};
  const target = exports[m[2] ? `.${m[2]}` : '.'];
  const path = typeof target === 'string' ? target : (target?.import ?? target?.default);
  return path ? join(dir, path) : undefined;
}

function resolveFile(from: string, spec: string): string | undefined {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(from), spec);
    return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
      (f) => existsSync(f) && !f.endsWith('/'),
    );
  }
  return packageEntry(spec);
}

function cssReachable(entry: string): string[] {
  const seen = new Set<string>(),
    css: string[] = [];
  const walk = (file: string, via: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(IMPORT)) {
      const spec = m[1]!;
      if (m[0].includes('import type') || m[0].includes('export type')) continue;
      if (spec.endsWith('.css')) {
        css.push([...via, file, spec].join(' → '));
        continue;
      }
      const next = resolveFile(file, spec);
      if (next && existsSync(next) && /\.tsx?$/.test(next)) walk(next, [...via, file]);
    }
  };
  walk(entry, []);
  return css;
}

describe('analysis-templates entries load without a CSS loader (#93)', () => {
  for (const entry of [
    '@editor-platform/analysis-templates',
    '@editor-platform/analysis-templates/fmea',
    '@editor-platform/analysis-templates/graph',
  ])
    it(entry, () => {
      expect(cssReachable(packageEntry(entry)!)).toEqual([]);
    });
});
