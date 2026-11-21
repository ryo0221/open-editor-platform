import console from 'node:console';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { packageArea } from './e2e/areas.mjs';

// Package dependencies must not cross the core / office / engineering areas the wrong way.
// See docs/kind-registry-design.md ("境界の確認").
//
//   node scripts/check-area-boundaries.mjs

/** Which areas each area may depend on. */
const allowed = {
  core: ['core'],
  office: ['core', 'office'],
  engineering: ['core', 'engineering'],
};

/**
 * Crossings that exist today, each removed by the stage named next to it. A listed crossing
 * that no longer exists is reported too, so the list shrinks with the code.
 */
export const knownCrossings = [
  'character -> animation-core', // KR2: Easing/Rational move to time-axis
  'character-core -> animation-core', // KR2
  'estimate -> cad-core', // KR3: CAD/BIM sources move to estimate-engineering
  'estimate -> bim-core', // KR3
  'extension-sample -> animation-core', // the sample extension shows an Animation surface
  'extension-sample -> animation-player',
];

/** Every `@editor-platform/*` dependency or peer dependency that leaves its area. */
export function areaCrossings(root) {
  const crossings = [];
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const file = join(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const from = packageArea(dir);
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
    for (const name of names.filter((entry) => entry.startsWith('@editor-platform/')).sort()) {
      const to = name.slice('@editor-platform/'.length);
      if (!allowed[from].includes(packageArea(to)))
        crossings.push({ edge: `${dir} -> ${to}`, from, to: packageArea(to) });
    }
  }
  return crossings;
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
  for (const { edge, from, to } of unexpected)
    console.error(`${edge}: ${from} must not depend on ${to}`);
  for (const edge of resolved)
    console.error(`${edge}: no longer a dependency; remove it from knownCrossings`);
  if (!unexpected.length && !resolved.length) console.log('Area boundaries: ok');
  return unexpected.length || resolved.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
