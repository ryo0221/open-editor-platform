import console from 'node:console';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifySpecs, dependents, packageArea, workspaceGraph } from './areas.mjs';

// Select the tests/e2e specs a change can affect, from the files changed since a base
// revision. See docs/developer-guide.md ("Playwrightのスイート").
//
//   node scripts/e2e/affected.mjs                    # changes since origin/main: print the plan
//   node scripts/e2e/affected.mjs --base main --json # machine-readable plan
//   node scripts/e2e/affected.mjs --all              # the full run: every spec and suite
//   node scripts/e2e/affected.mjs --run --out work/e2e/branch.json
//   node <branch>/scripts/e2e/affected.mjs --from-json plan.json --run --out main.json
//
// Run in the checkout under test: the current directory is the repository root.

/** Files that change how browser suites start, bundle or resolve modules (Host Vite configs too). */
const everythingPattern =
  /^(?:package(?:-lock)?\.json|playwright\.config\.ts|tsconfig\.json|vite(?:\.[\w-]+)?\.config\.ts|tests\/playwright\/|scripts\/dev\/)/;
/** Development-server helpers used by the default suite's servers. */
const officeServerPattern =
  /^scripts\/(?:design-react-export|react-ui-export|collaboration)-[\w-]+\.mjs$/;
/** Playground source names that are not package directory names. */
const playgroundAliases = {
  geo: 'geo-inspector',
  collaboration: 'collaboration-adapters',
  'external-sources': 'reference-adapters',
  graph: 'structured-graph',
  template: 'templates',
  'artifact-references': 'artifact-references',
};
/** Reference apps the e2e suites serve, and the package whose surface each one mounts. */
const referenceApps = {
  'animation-reference': 'animation', // vite.animation-host.config.ts (4189)
  'react-ui-reference': 'react-ui', // vite.react-ui.config.ts
  'graph-reference': 'structured-graph', // Playground graph-host.tsx, structured-graph specs
};

/**
 * What a changed path means for browser specs.
 * @returns {{kind:'package', name:string} | {kind:'spec'|'helper'|'fixture', file:string} |
 *   {kind:'everything'|'playground'|'office'|'none'}}
 */
export function classifyPath(path, packages) {
  if (everythingPattern.test(path)) return { kind: 'everything' };
  if (officeServerPattern.test(path)) return { kind: 'office' };
  let match = /^packages\/([^/]+)\//.exec(path);
  if (match) return packages.has(match[1]) ? { kind: 'package', name: match[1] } : { kind: 'none' };
  if (path.startsWith('scripts/cad-kernel/')) return { kind: 'package', name: 'cad-kernel-occt' };
  match = /^apps\/playground\/src\/([^/.]+)(?:[./]|$)(.*)$/.exec(path);
  if (match) {
    if (/\.test\.tsx?$/.test(path)) return { kind: 'none' };
    const entry = match[1].replace(/-host$/, '');
    const name = playgroundAliases[entry] ?? entry;
    return packages.has(name) ? { kind: 'package', name } : { kind: 'playground' };
  }
  if (path.startsWith('apps/playground/')) return { kind: 'playground' };
  // The reference Artifact Host mounts CAD, BIM, estimate and office surfaces side by side.
  match = /^apps\/artifact-host\/src\/([^/.]+)/.exec(path);
  if (match) {
    if (/\.test\.tsx?$/.test(path)) return { kind: 'none' };
    const name = [match[1], match[1].split('-')[0]].find((entry) => packages.has(entry));
    return name ? { kind: 'package', name } : { kind: 'playground' };
  }
  if (path.startsWith('apps/artifact-host/')) return { kind: 'playground' };
  match = /^apps\/([^/]+)\//.exec(path);
  if (match) {
    if (/\.test\.tsx?$/.test(path)) return { kind: 'none' };
    const name = referenceApps[match[1]];
    return name && packages.has(name) ? { kind: 'package', name } : { kind: 'office' };
  }
  if (/^(?:tests|scripts)\/fixtures\//.test(path)) return { kind: 'fixture', file: path };
  if (/^tests\/e2e\/[^/]+\.spec\.ts$/.test(path)) return { kind: 'spec', file: path };
  if (/^tests\/e2e\/[^/]+\.ts$/.test(path)) return { kind: 'helper', file: path };
  return { kind: 'none' };
}

/**
 * Plan the browser run for a list of changed paths.
 * @param {string[]} changed repository-relative paths
 * @param {ReturnType<typeof classifySpecs>} specs
 * @param {ReturnType<typeof workspaceGraph>} graph
 * @param {{heavy?: boolean, all?: boolean}} [options] heavy: also run heavy specs a broad
 *   change reaches; all: the full run (every spec, heavy ones included)
 */
export function planRun(changed, specs, graph, options = {}) {
  const packages = new Set(graph.users.keys());
  const direct = new Set();
  const changedSpecs = new Set();
  const changedHelpers = new Set();
  const changedFixtures = [];
  let everything = !!options.all,
    playground = false,
    office = false;
  for (const path of changed) {
    const what = classifyPath(path, packages);
    if (what.kind === 'package') direct.add(what.name);
    else if (what.kind === 'spec') changedSpecs.add(what.file);
    else if (what.kind === 'helper') changedHelpers.add(what.file);
    else if (what.kind === 'fixture') changedFixtures.push(what.file);
    else if (what.kind === 'everything') everything = true;
    else if (what.kind === 'playground') playground = true;
    else if (what.kind === 'office') office = true;
  }
  for (const name of direct) if (packageArea(name) !== 'engineering') office = true;
  const usesFixture = (spec, file) => spec.paths.some((prefix) => file.startsWith(prefix));
  // A browser fixture no tests/e2e spec names may serve another suite: run every light spec.
  for (const file of changedFixtures)
    if (file.startsWith('tests/') && !specs.some((spec) => usesFixture(spec, file)))
      playground = true;
  const affected = dependents(graph, [...direct]);
  const engineering = dependents(
    graph,
    [...direct].filter((name) => packageArea(name) === 'engineering'),
  );
  const run = [],
    deferred = [];
  for (const spec of specs) {
    const own = changedSpecs.has(spec.file);
    const reached =
      everything ||
      playground ||
      own ||
      spec.helpers.some((helper) => changedHelpers.has(helper)) ||
      changedFixtures.some((file) => usesFixture(spec, file)) ||
      spec.owners.some((owner) => affected.has(owner)) ||
      (spec.broad && office);
    if (!reached) continue;
    // Heavy specs follow their own packages (and their engineering dependencies) only.
    if (
      spec.heavy &&
      !own &&
      !options.heavy &&
      !options.all &&
      !spec.owners.some((o) => engineering.has(o))
    )
      deferred.push(spec);
    else run.push(spec);
  }
  const reasons = [];
  if (options.all) reasons.push('full run requested');
  else if (everything) reasons.push('shared configuration changed');
  if (playground) reasons.push('shared Playground source changed');
  if (direct.size) reasons.push(`packages: ${[...direct].sort().join(', ')}`);
  if (changedSpecs.size) reasons.push(`specs: ${changedSpecs.size}`);
  if (changedFixtures.length) reasons.push(`fixtures: ${changedFixtures.length}`);
  if (changedHelpers.size) reasons.push(`spec helpers: ${[...changedHelpers].sort().join(', ')}`);
  return { reasons, run, deferred };
}

/** Commands for a plan: the development suite, then each named suite with extra servers. */
export function planCommands(plan) {
  const dev = plan.run.filter((spec) => spec.needs.length === 0).map((spec) => spec.file);
  const named = new Map();
  for (const spec of plan.run.filter((entry) => entry.needs.length)) {
    const suite = spec.suite ?? 'production';
    named.set(suite, [...(named.get(suite) ?? []), spec.file]);
  }
  return { dev, named: [...named].map(([suite, files]) => ({ suite, files })) };
}

function changedSince(base) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n');
  const from = git('merge-base', base, 'HEAD')[0];
  return [
    ...new Set(
      [...git('diff', '--name-only', from), ...git('ls-files', '--others', '--exclude-standard')]
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = process.cwd();
  if (!existsSync(join(root, 'tests/e2e'))) throw new Error('Run from the repository root.');
  const specs = classifySpecs(root);
  let plan;
  const fromJson = value('--from-json');
  if (fromJson) {
    const saved = JSON.parse(readFileSync(fromJson, 'utf8'));
    const byFile = new Map(specs.map((spec) => [spec.file, spec]));
    const missing = saved.run.filter((file) => !byFile.has(file));
    if (missing.length) console.warn(`Not in this checkout, skipped: ${missing.join(', ')}`);
    plan = {
      reasons: saved.reasons,
      run: saved.run.filter((file) => byFile.has(file)).map((file) => byFile.get(file)),
      deferred: [],
    };
  } else {
    const base = value('--base') ?? 'origin/main';
    plan = planRun(changedSince(base), specs, workspaceGraph(root), {
      heavy: argv.includes('--heavy'),
      all: argv.includes('--all'),
    });
  }
  const commands = planCommands(plan);
  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          reasons: plan.reasons,
          run: plan.run.map((spec) => spec.file),
          deferred: plan.deferred.map((spec) => spec.file),
          ...commands,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Changes: ${plan.reasons.join('; ') || 'none that reach browser specs'}`);
    console.log(`Development suite: ${commands.dev.length} spec files`);
    for (const file of commands.dev) console.log(`  ${file}`);
    for (const { suite, files } of commands.named)
      console.log(`Needs E2E_SUITE=${suite} (extra servers): ${files.join(' ')}`);
    if (plan.deferred.length)
      console.log(
        `Heavy specs left to the nightly run (or pass --heavy): ${plan.deferred.map((spec) => spec.file).join(' ')}`,
      );
  }
  if (!argv.includes('--run') || !commands.dev.length) return 0;
  const out = resolve(value('--out') ?? 'work/e2e/affected.json');
  const extra = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      '--reporter=list,json',
      ...commands.dev,
      ...extra,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, E2E_SUITE: 'default', PLAYWRIGHT_JSON_OUTPUT_NAME: out },
    },
  );
  console.log(`JSON results: ${out}`);
  if (commands.named.length)
    console.log('Specs that need extra servers were not run; use the E2E_SUITE commands above.');
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
