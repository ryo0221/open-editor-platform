import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

// Areas of the workspace and of the browser specs in tests/e2e, used to run only the
// specs a change can affect (scripts/e2e/affected.mjs) and to split the full run into
// suites (tests/playwright/suites.ts). Packages not listed below are in the office area.

/** Platform packages every editor builds on. A change here affects every non-heavy spec. */
export const corePackages = [
  'artifact-core',
  'artifact-kinds',
  'artifact-output',
  'artifact-references',
  'calculation-core',
  'canvas-ui',
  'collaboration-core',
  'easing',
  'editor-core',
  'editor-host',
  'editor-ui',
  'export-core',
  'extension-contract',
  'extension-runtime',
  'extension-sample',
  'geometry-core',
  'property-input',
  'review-surfaces',
  'reuse-core',
  'spatial-index',
  'time-axis',
];

/** CAD, building, analysis, character, circuit and drawing packages and their geometry. */
export const engineeringPackages = [
  'bim',
  'bim-core',
  'bim-ifc',
  'cad',
  'cad-core',
  'cad-kernel-occt',
  'character',
  'character-core',
  'circuit-sim-core',
  'construction',
  'construction-core',
  'cosim',
  'cosim-core',
  'drawing',
  'drawing-core',
  'estimate-engineering',
  'factory',
  'factory-core',
  'fem-mesher',
  'geometry-cfd',
  'geometry-fem',
  'geometry-kernel-occt',
  'geometry-mesh',
  'geometry-view',
  'ladder',
  'ladder-core',
  'pcb',
  'pcb-core',
  'schematic',
  'schematic-core',
  'simulation',
  'simulation-core',
];

/** @param {string} name workspace directory name under packages/ */
export function packageArea(name) {
  if (corePackages.includes(name)) return 'core';
  if (engineeringPackages.includes(name)) return 'engineering';
  return 'office';
}

/**
 * Spec families, first match wins. `owners` are the packages whose UI the specs drive;
 * the dependency graph adds everything those packages use. `broad` specs exercise many
 * office editors at once and run for any core or office change. `heavy` specs compute
 * real geometry (minutes per test) and run only when their own packages change, or
 * nightly. `suite` names the tests/playwright/suites.ts suite that starts the extra
 * servers a spec needs beyond the development set. `needs` lists those servers' ports for
 * specs that reach them only through the suite's baseURL (no literal URL in the source).
 */
export const specRules = [
  { match: /^cad-hosts$/, area: 'engineering', heavy: true, owners: ['cad'], suite: 'cad.hosts' },
  { match: /^cad-playground$/, area: 'engineering', heavy: true, owners: ['cad'] },
  { match: /^simulation-/, area: 'engineering', heavy: true, owners: ['simulation'] },
  { match: /^drawing-sets$/, area: 'engineering', heavy: true, owners: ['drawing'] },
  { match: /^character-playground$/, area: 'engineering', heavy: true, owners: ['character'] },
  { match: /^character-laputa-range$/, area: 'engineering', owners: ['character', 'bim'] },
  { match: /^bim-hosts$/, area: 'engineering', owners: ['bim'], suite: 'bim.hosts' },
  { match: /^bim-/, area: 'engineering', owners: ['bim'] },
  { match: /^gulliver-/, area: 'engineering', owners: ['bim', 'cad', 'character'] },
  { match: /^construction-/, area: 'engineering', owners: ['construction'] },
  { match: /^(circuit|cosim)-/, area: 'engineering', owners: ['cosim'] },
  { match: /^drawing-/, area: 'engineering', owners: ['drawing'] },
  { match: /^factory-/, area: 'engineering', owners: ['factory'] },
  { match: /^ladder-/, area: 'engineering', owners: ['ladder'] },
  { match: /^pcb-/, area: 'engineering', owners: ['pcb'] },
  { match: /^schematic-/, area: 'engineering', owners: ['schematic'] },
  { match: /^analysis-/, area: 'office', owners: ['analysis'], suite: 'analysis.production' },
  { match: /^animation-2d$/, area: 'office', owners: ['animation'], suite: 'animation-2d' },
  {
    match: /^animation-connection$/,
    area: 'office',
    owners: ['animation', 'animation-adapters'],
    suite: 'animation-connection',
  },
  {
    match: /^animation-layer-actions$/,
    area: 'office',
    owners: ['animation'],
    suite: 'animation-layer-actions',
  },
  {
    match: /^artifact-references-extension$/,
    area: 'office',
    owners: ['artifact-references', 'extension-runtime', 'extension-sample'],
  },
  { match: /^artifact-references/, area: 'office', owners: ['artifact-references'] },
  {
    match: /^(editor-)?collaboration/,
    area: 'office',
    owners: ['collaboration-adapters', 'collaboration-core'],
  },
  { match: /^creative-map$/, area: 'office', broad: true, suite: 'creative-map' },
  {
    match: /^creative-world-generation$/,
    area: 'office',
    broad: true,
    suite: 'creative-world-generation',
  },
  {
    match: /^creative-world-context/,
    area: 'office',
    broad: true,
    suite: 'creative-world-context',
  },
  { match: /^(csv-|data-)/, area: 'office', owners: ['structured-data'] },
  {
    match: /^design-react/,
    area: 'office',
    owners: ['design-react', 'design-react-core', 'design-react-preview', 'react-ui'],
  },
  { match: /^design-path$/, area: 'office', owners: ['design'], suite: 'design-path.production' },
  { match: /^design-/, area: 'office', owners: ['design'] },
  { match: /^document-/, area: 'office', owners: ['document'] },
  {
    match: /^estimate-editor$/,
    area: 'office',
    // KR3 cut estimate's CAD/BIM dependency: the integration is named here instead.
    owners: ['estimate', 'estimate-engineering', 'cad-core', 'bim-core'],
    suite: 'estimate.production',
  },
  {
    match: /^estimate-/,
    area: 'office',
    owners: ['estimate', 'estimate-engineering', 'cad-core', 'bim-core'],
  },
  { match: /^external-sources$/, area: 'office', owners: ['reference-adapters'] },
  { match: /^fiction-map-/, area: 'office', owners: ['fiction-map'] },
  { match: /^geo-/, area: 'office', owners: ['geo-core', 'geo-inspector'] },
  { match: /^import-batch$/, area: 'office', owners: ['office-import-ui'] },
  {
    match: /^office-docx-ui$/,
    area: 'office',
    owners: ['office-export-ui', 'document-export'],
    suite: 'ci',
  },
  {
    match: /^office-/,
    area: 'office',
    owners: [
      'document-export',
      'document-import',
      'office-adapters',
      'office-export-ui',
      'office-import-core',
      'office-import-ui',
      'slide-export',
      'slide-import',
    ],
  },
  { match: /^mindmap/, area: 'office', owners: ['mindmap', 'mindmap-core'] },
  { match: /^react-ui/, area: 'office', owners: ['react-ui', 'react-ui-core', 'react-ui-tooling'] },
  { match: /^review-viewer-/, area: 'office', owners: ['review-surfaces'] },
  { match: /^schedule/, area: 'office', owners: ['schedule'] },
  { match: /^slide-animation-/, area: 'office', owners: ['slide', 'animation'] },
  { match: /^spatial-wasm/, area: 'office', owners: ['spatial-index'] },
  { match: /^story-board/, area: 'office', broad: true, suite: 'story-board' },
  {
    match: /^whiteboard-add-sticky$/,
    area: 'office',
    owners: ['whiteboard'],
    suite: 'story-board',
  },
  { match: /^story-timeline/, area: 'office', broad: true, suite: 'story-timeline' },
  {
    match: /^structured-graph/,
    area: 'office',
    owners: ['structured-graph', 'structured-data-graph'],
  },
  { match: /^templates?-/, area: 'office', owners: ['templates', 'template-ui'] },
  { match: /^templates$/, area: 'office', owners: ['templates', 'template-ui'] },
  // These skip, or open the Artifact Host's own UI, unless baseURL is 4177: E2E_SUITE=host.
  {
    match: /^host-(?:api|integration)$/,
    area: 'office',
    broad: true,
    suite: 'host',
    needs: [4177],
  },
  {
    match: /^authoring$/,
    area: 'office',
    owners: ['design', 'document'],
    suite: 'host',
    needs: [4177],
  },
  {
    match: /^novel-workspace$/,
    area: 'office',
    owners: ['document'],
    suite: 'host',
    needs: [4177],
  },
  {
    match: /^(manga-|playground-(ink|raster)$|authoring)/,
    area: 'office',
    owners: ['design', 'document'],
  },
  { match: /^novel-/, area: 'office', owners: ['document'] },
  { match: /^native-domain-collaboration$/, area: 'engineering', owners: ['collaboration-adapters', 'cad', 'simulation', 'construction', 'cosim', 'pcb', 'schematic', 'ladder', 'factory', 'analysis', 'estimate', 'fiction-map'] },
  { match: /^hosted-media-collaboration$/, area: 'engineering', owners: ['character', 'video-core', 'collaboration-adapters'] },
  { match: /^video-collaboration$/, area: 'office', owners: ['video-core', 'collaboration-adapters'] },
  {
    match: /^(canvas-|issue2-(arrange|canvas|geometry|group-review|layout|rich-canvas)$)/,
    area: 'office',
    owners: ['canvas-ui', 'design', 'whiteboard'],
  },
  { match: /^issue2-document$/, area: 'office', owners: ['document'] },
  { match: /^issue2-slide$/, area: 'office', owners: ['slide'] },
  { match: /^issue2-data$/, area: 'office', owners: ['structured-data'] },
  {
    match: /^reuse-/,
    area: 'office',
    owners: ['reuse-core', 'design', 'document', 'slide', 'structured-data', 'whiteboard'],
  },
  // Cross-editor flows: audits, issue regressions, practical, reuse, host and usability specs.
  { match: /./, area: 'office', broad: true },
];

/**
 * The packages behind each kind: the one with its shared definition (`<package>/kind`) and the
 * ones whose Surface a Host mounts for it. A Host's per-kind file
 * (`apps/<host>/src/kinds/<area>/<kind>.tsx`) counts as a change to these packages. Kind names
 * and package names differ (`data` is `structured-data`).
 */
export const kindPackages = {
  analysis: ['analysis'],
  animation: ['animation', 'animation-adapters'],
  bim: ['bim'],
  cad: ['cad'],
  character: ['character'],
  construction: ['construction'],
  cosim: ['cosim'],
  data: ['structured-data', 'structured-data-graph'],
  design: ['design', 'design-react', 'design-react-core'],
  document: ['document'],
  drawing: ['drawing'],
  estimate: ['estimate'],
  factory: ['factory'],
  'fiction-map': ['fiction-map'],
  file: ['review-surfaces'],
  geo: ['geo-inspector'],
  ladder: ['ladder'],
  mindmap: ['mindmap'],
  pcb: ['pcb'],
  'react-ui': ['react-ui'],
  review: ['review-surfaces'],
  schedule: ['schedule'],
  schematic: ['schematic'],
  simulation: ['simulation'],
  slide: ['slide'],
  'structured-graph': ['structured-graph'],
  whiteboard: ['whiteboard'],
};

/**
 * Host files that connect office kinds to engineering code (Estimate's CAD/BIM reading), relative
 * to `apps/<host>/src/`. An area list reaches them through its Host parts.
 */
export const hostConnectionFiles = ['app/estimate-bim.ts', 'estimate-bim.ts'];

/**
 * Dependencies cut on purpose, and where the code went. A change to `from` may stop selecting
 * the specs that reached it only through `user`; a change to `to` must select both sides.
 */
export const removedDependencies = [
  { stage: 'native collaboration', user: 'templates', from: 'collaboration-adapters', to: 'collaboration-office' },
  { stage: 'native collaboration', user: 'template-ui', from: 'collaboration-adapters', to: 'collaboration-office' },
  { stage: 'KR2', user: 'character', from: 'animation-core', to: 'easing' },
  { stage: 'KR3', user: 'estimate', from: 'cad-core', to: 'estimate-engineering' },
  { stage: 'KR3', user: 'estimate', from: 'bim-core', to: 'estimate-engineering' },
];

const relativeImportPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+[^'";]*?\bfrom\s*)['"](\.[^'"]+)['"]/gm;

/**
 * The workspace packages a kind source names: every `<package>/kind` definition, and the other
 * non-core packages it imports (core helpers such as artifact-core are not what it lists).
 */
function listedPackages(text) {
  const found = new Set();
  for (const [, name] of text.matchAll(importPattern))
    if (packageArea(name) !== 'core') found.add(name);
  for (const [, name] of text.matchAll(kindImportPattern)) found.add(name);
  return found;
}
const kindImportPattern = /['"]@editor-platform\/([a-z0-9-]+)\/kind['"]/g;

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * What a change to a Host's kind source means, as workspace packages, or undefined when the
 * path is not a per-kind file or area list (shared kinds/ files keep the Playground rule).
 *
 * - `kinds/<area>/<kind>.tsx`: the kind's packages (`kindPackages`).
 * - `kinds/<area>.ts`, or another file in `kinds/<area>/` (its Surface list, records, a
 *   Host-local kind): the area list. Every package whose definition it lists and every non-core
 *   package it and its Host parts (`kinds/<area>/**`) import, and those of the Host connection
 *   files they import. Not narrowed by area: `kinds/engineering.ts` reaches Estimate through
 *   `app/estimate-bim.ts`. A core package named here (review-surfaces defines `review`) stands
 *   for its own kind only: affected.mjs matches it against spec owners, not its dependents.
 * @param {string} root repository root
 * @param {string} path repository-relative path
 * @returns {string[] | undefined}
 */
export function kindSourcePackages(root, path) {
  const match = /^apps\/([^/]+)\/src\/kinds\/(office|engineering)(?:\.ts|\/(.+))$/.exec(path);
  if (!match) return undefined;
  const [, app, area, rest] = match;
  if (rest !== undefined) {
    if (/\.test\.tsx?$/.test(rest)) return [];
    const kind = /^([\w-]+)\.tsx?$/.exec(rest)?.[1];
    if (kind && Object.hasOwn(kindPackages, kind)) return [...kindPackages[kind]];
  }
  const src = join(root, 'apps', app, 'src');
  const listFile = join(src, 'kinds', `${area}.ts`);
  const files = [
    ...(existsSync(listFile) ? [listFile] : []),
    ...listFiles(join(src, 'kinds', area)),
  ];
  const found = new Set();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of listedPackages(text)) found.add(name);
    for (const [, specifier] of text.matchAll(relativeImportPattern)) {
      const target = posix.relative(
        src.split('\\').join('/'),
        posix.join(posix.dirname(file.split('\\').join('/')), specifier),
      );
      const connection = hostConnectionFiles.find(
        (entry) => entry === target || entry === `${target}.ts`,
      );
      if (!connection) continue;
      for (const name of listedPackages(readFileSync(join(src, connection), 'utf8')))
        found.add(name);
    }
  }
  return [...found].sort();
}

/** Servers the default (development) suite starts; see tests/playwright/suites.ts. */
export const defaultPorts = [4175, 4176, 4180, 5173, 5174];

const portPattern = /(?:127\.0\.0\.1|localhost):(\d{4,5})/g;
/** Static (`from '…'`) and literal dynamic (`import('…')`) workspace imports. */
const importPattern = /(?:from\s+|import\(\s*)['"]@editor-platform\/([a-z0-9-]+)/g;
const relativePattern = /['"`]((?:\.\.\/)+[\w@./-]+)['"`]/g;
/** Local helpers, static (`from './…'`) or literal dynamic (`import('./…')`). */
const helperPattern = /(?:from\s+|import\(\s*)['"]\.\/([\w.-]+?)(?:\.ts)?['"]/g;

/**
 * A scripts/fixtures module and the sibling fixture modules it imports, transitively
 * (gulliver-brobdingnag.ts builds on gulliver-lilliput.ts), with their package imports.
 * @returns {{paths: string[], packages: string[]}}
 */
function scriptFixtureClosure(root, target) {
  const paths = new Set(),
    packages = new Set();
  const queue = [target.replace(/\.[cm]?[jt]sx?$/, '')];
  while (queue.length) {
    const stem = queue.pop();
    if (paths.has(stem)) continue;
    paths.add(stem);
    const file = ['.ts', '.tsx', '.mjs', '.js', '']
      .map((ext) => stem + ext)
      .find((path) => existsSync(join(root, path)));
    if (!file || !statSync(join(root, file)).isFile()) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const [, name] of text.matchAll(helperPattern))
      queue.push(posix.join(posix.dirname(stem), name.replace(/\.[cm]?[jt]sx?$/, '')));
    for (const [, name] of text.matchAll(importPattern))
      if (existsSync(join(root, 'packages', name))) packages.add(name);
  }
  return { paths: [...paths], packages: [...packages] };
}

const fixtureCache = new Map();
/** Workspace packages imported anywhere under a tests/fixtures directory. */
function fixtureImports(root, dir) {
  if (fixtureCache.has(dir)) return fixtureCache.get(dir);
  const found = new Set();
  const walk = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name))
        for (const [, name] of readFileSync(child, 'utf8').matchAll(importPattern))
          if (existsSync(join(root, 'packages', name))) found.add(name);
    }
  };
  walk(join(root, dir));
  fixtureCache.set(dir, found);
  return found;
}

/** Local helper modules (tests/e2e/*.ts) a spec or helper imports, transitively. */
function helpers(dir, file, seen = new Set()) {
  const text = readFileSync(join(dir, file), 'utf8');
  for (const [, name] of text.matchAll(helperPattern)) {
    const helper = `${name}.ts`;
    if (seen.has(helper) || !existsSync(join(dir, helper))) continue;
    seen.add(helper);
    helpers(dir, helper, seen);
  }
  return seen;
}

/**
 * Every spec in tests/e2e with its area, owners (rule owners plus the workspace packages
 * the spec imports), local helpers, fixture paths outside tests/e2e (`paths`, prefixes)
 * and the ports it opens
 * beyond the development servers (`needs`).
 * @param {string} root repository root
 */
export function classifySpecs(root) {
  const dir = join(root, 'tests/e2e');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.spec.ts'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.spec.ts'.length);
      const rule = specRules.find((entry) => entry.match.test(name));
      const local = [...helpers(dir, file)].sort();
      const ports = new Set(rule.needs ?? []);
      const owners = new Set(rule.owners ?? []);
      const paths = new Set();
      for (const source of [file, ...local]) {
        const text = readFileSync(join(dir, source), 'utf8');
        for (const [, port] of text.matchAll(portPattern))
          if (!defaultPorts.includes(Number(port))) ports.add(Number(port));
        // Fixtures outside tests/e2e that a spec bundles or reads ('../fixtures/spatial/host.tsx').
        for (const [, relative] of text.matchAll(relativePattern)) {
          const target = posix.join('tests/e2e', relative);
          const fixture = /^tests\/fixtures\/[^/]+/.exec(target);
          const pkg = /^packages\/([^/]+)\//.exec(target);
          if (fixture) {
            paths.add(`${fixture[0]}/`);
            // Packages the bundled or loaded fixture sources import are owners as well.
            for (const name of fixtureImports(root, fixture[0])) owners.add(name);
          } else if (pkg && existsSync(join(root, 'packages', pkg[1]))) owners.add(pkg[1]);
          else if (target.startsWith('scripts/fixtures/')) {
            const closure = scriptFixtureClosure(root, target);
            for (const path of closure.paths) paths.add(path);
            for (const name of closure.packages) owners.add(name);
          }
        }
        // Packages the spec or its helpers import are owners too (fixtures, models).
        for (const [, name] of text.matchAll(importPattern))
          if (existsSync(join(root, 'packages', name))) owners.add(name);
      }
      return {
        file: `tests/e2e/${file}`,
        name,
        area: rule.area,
        heavy: !!rule.heavy,
        broad: !!rule.broad,
        owners: [...owners].sort(),
        suite: rule.suite,
        helpers: local.map((helper) => `tests/e2e/${helper}`),
        paths: [...paths].sort(),
        needs: [...ports].sort((a, b) => a - b),
      };
    });
}

/** Specs the default development suite can run: no server beyond the development set. */
export function developmentSpecs(specs) {
  return specs.filter((spec) => spec.needs.length === 0);
}

/**
 * Workspace dependency graph from package.json (dependencies and peerDependencies on
 * @editor-platform/*; test-only devDependencies do not reach a browser), keyed by
 * directory name, with the reverse edges.
 * @param {string} root repository root
 */
export function workspaceGraph(root) {
  const deps = new Map();
  const dirs = new Map();
  for (const group of ['packages', 'apps'])
    for (const name of readdirSync(join(root, group))) {
      const manifest = join(root, group, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      dirs.set(pkg.name, name);
      deps.set(
        name,
        [pkg.dependencies, pkg.peerDependencies]
          .filter(Boolean)
          .flatMap(Object.keys)
          .filter((dep) => dep.startsWith('@editor-platform/')),
      );
    }
  const users = new Map([...deps.keys()].map((name) => [name, new Set()]));
  for (const [name, list] of deps)
    for (const dep of list) {
      const target = dirs.get(dep);
      if (target && target !== name) users.get(target).add(name);
    }
  return { users };
}

/** The packages that use `names`, directly or through others, including `names`. */
export function dependents(graph, names) {
  const seen = new Set(names);
  const queue = [...names];
  while (queue.length)
    for (const user of graph.users.get(queue.pop()) ?? [])
      if (!seen.has(user)) {
        seen.add(user);
        queue.push(user);
      }
  return seen;
}
