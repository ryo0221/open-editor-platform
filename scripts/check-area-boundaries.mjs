import console from 'node:console';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { packageArea } from './e2e/areas.mjs';

// Package dependencies must not cross the core / office / engineering areas the wrong way.
// See docs/kind-registry-design.md ("境界の確認").
//
//   node scripts/check-area-boundaries.mjs

/** Which areas each area may depend on. */
const allowed = {
  host: ['core', 'office', 'engineering'],
  core: ['core'],
  office: ['core', 'office'],
  engineering: ['core', 'engineering'],
};

/**
 * Crossings that exist today, each removed by the stage named next to it. A listed crossing
 * that no longer exists is reported too, so the list shrinks with the code.
 */
export const knownCrossings = [
  'extension-sample -> animation-core', // the sample extension shows an Animation surface
  'extension-sample -> animation-player',
  'slide -> character', // the shared H.264 writer at character/video
];

// This public Host catalogue composes the two editor areas. Neither area may import it.
const dependencyArea = (dir) => dir === 'collaboration-adapters' ? 'host' : packageArea(dir);

/** Every `@editor-platform/*` dependency or peer dependency that leaves its area. */
export function areaCrossings(root) {
  const crossings = [];
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = join(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const from = dependencyArea(dir);
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    for (const name of names.filter((entry) => entry.startsWith('@editor-platform/')).sort()) {
      const to = name.slice('@editor-platform/'.length);
      if (!allowed[from].includes(dependencyArea(to)))
        crossings.push({ edge: `${dir} -> ${to}`, from, to: dependencyArea(to) });
    }
  }
  return crossings;
}

/** Host files that connect office kinds to engineering code (Estimate's CAD/BIM reading). */
export const hostConnectionFiles = ['app/estimate-bim.ts', 'estimate-bim.ts'];

const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+[^'";]*?\bfrom\s*)['"]([^'"]+)['"]/gm;

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Imports from a Host's office kinds (`src/kinds/office.ts`, `src/kinds/office/**`) that reach
 * engineering code: an engineering package, the Host's engineering kinds, a Host directory or
 * top-level file named after an engineering package (`src/cad/`, `src/bim.tsx`), or a Host
 * connection file. Engineering connections
 * reach office kinds only as arguments (kinds/surfaces.ts).
 */
export function officeKindImports(root) {
  const found = [];
  const apps = join(root, 'apps');
  if (!existsSync(apps)) return found;
  for (const app of readdirSync(apps).sort()) {
    const src = join(apps, app, 'src');
    const kinds = join(src, 'kinds');
    const files = [
      ...(existsSync(join(kinds, 'office.ts')) ? [join(kinds, 'office.ts')] : []),
      ...sourceFiles(join(kinds, 'office')),
    ].sort();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [, specifier] of text.matchAll(importPattern)) {
        const name = relative(root, file).split(sep).join('/');
        if (specifier.startsWith('@editor-platform/')) {
          const pkg = specifier.slice('@editor-platform/'.length).split('/')[0];
          if (!allowed.office.includes(dependencyArea(pkg))) found.push(`${name} -> ${specifier}`);
          continue;
        }
        if (!specifier.startsWith('.')) continue;
        const target = relative(src, resolve(dirname(file), specifier))
          .split(sep)
          .join('/');
        const [top, next] = target.split('/');
        if (
          (top === 'kinds' && (next === 'engineering' || next === 'engineering.ts')) ||
          engineeringHostDir(next === undefined ? top.replace(/\.tsx?$/, '') : top) ||
          hostConnectionFiles.some((entry) => `${target}.ts` === entry || target === entry)
        )
          found.push(`${name} -> ${specifier}`);
      }
    }
  }
  return found;
}

function engineeringHostDir(name) {
  return !name.startsWith('.') && packageArea(name) === 'engineering';
}

/** New crossings, and listed ones that are gone. */
export function checkBoundaries(root, known = knownCrossings) {
  const found = areaCrossings(root);
  const edges = new Set(found.map((entry) => entry.edge));
  return {
    unexpected: found.filter((entry) => !known.includes(entry.edge)),
    resolved: known.filter((edge) => !edges.has(edge)),
  };
}

function main() {
  const { unexpected, resolved } = checkBoundaries(process.cwd());
  const office = officeKindImports(process.cwd());
  for (const edge of office)
    console.error(`${edge}: office kinds must not import engineering code`);
  for (const { edge, from, to } of unexpected)
    console.error(`${edge}: ${from} must not depend on ${to}`);
  for (const edge of resolved)
    console.error(`${edge}: no longer a dependency; remove it from knownCrossings`);
  if (!unexpected.length && !resolved.length && !office.length) console.log('Area boundaries: ok');
  return unexpected.length || resolved.length || office.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
