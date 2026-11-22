import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifySpecs, workspaceGraph } from './areas.mjs';
import { planCommands, planRun } from './affected.mjs';
import { runErrors, testStatuses } from './compare.mjs';

// The nightly full browser run, in four groups that each fit in about 90 minutes on a
// 4-core cloud machine (measured 2026-11-22 on main 96878ab with --trace off). The groups
// start at the same time on separate machines; each writes a Markdown summary.
//
//   node scripts/e2e/nightly.mjs <group> [--setup] [--previous <failures.txt>] [--out <dir>]
//     [--only <step,...>]
//
// --setup fetches the CAD kernel, FontTools and the builds the group needs (a fresh clone).
// --previous names the failure list an earlier night wrote; the summary then lists the
// failures that are new and the ones that were fixed since.

/** Whole-car and watch tests: most of cad-playground's time (CR7 about 62 min, watch 52). */
export const cadCar = '\\(CR7[b-g]';
const cadPlayground = 'tests/e2e/cad-playground.spec.ts';

/** Suites whose specs live outside tests/e2e, each with its own server. */
export const packageSuites = [
  'animation-player',
  'animation',
  'animation-controlled',
  'geo-inspector',
  'extension-reference',
  'fiction-map-d2',
  'fiction-map-d3',
  'fiction-map-d4',
  'bim',
  'pcb',
  'schematic',
  'ladder',
  'cosim',
  'drawing',
  'character',
  'cad',
];

/** Suites outside tests/e2e the nightly run leaves out, and why. */
export const skippedSuites = {
  scale: 'no specs in tests/scale',
  'scale.production': 'no specs in tests/scale',
  'react-ui-scale': 'needs the work/complete24 workload, not in a fresh clone',
  'react-ui-scale-output': 'needs the work/complete24 workload, not in a fresh clone',
};

/** Vite builds a preview server serves; package previews build their own config. */
const productionBuilds = [
  [],
  ['--config', 'vite.artifact-host.config.ts'],
  ['--config', 'vite.animation-host.config.ts'],
  ['--config', 'vite.react-ui.config.ts'],
  ['--config', 'vite.fiction-map.config.ts'],
  ['--config', 'packages/animation-player/vite.config.ts'],
  ['--config', 'packages/animation/vite.config.ts'],
  ['--config', 'packages/animation/tests/controlled/vite.config.ts'],
  ['--config', 'packages/geo-inspector/vite.config.ts'],
  ['--config', 'apps/extension-reference/vite.config.ts'],
];

/**
 * The steps of each group. A step is one Playwright run: a suite plus arguments.
 * @param {string} root repository root
 * @returns {Record<string, {builds: boolean, steps: {name: string, suite: string, args: string[]}[]}>}
 */
export function nightlyGroups(root) {
  const plan = planRun([], classifySpecs(root), workspaceGraph(root), { all: true });
  const named = planCommands(plan).named.map(({ suite, files }) => ({
    name: suite,
    suite,
    args: files,
  }));
  return {
    1: {
      builds: false,
      steps: [
        { name: 'office', suite: 'office', args: [] },
        { name: 'engineering', suite: 'engineering', args: [] },
      ],
    },
    2: {
      builds: true,
      steps: [
        ...named,
        ...packageSuites.map((suite) => ({ name: suite, suite, args: [] })),
        {
          name: 'character-playground',
          suite: 'engineering-heavy',
          args: ['tests/e2e/character-playground.spec.ts'],
        },
      ],
    },
    3: {
      builds: false,
      steps: [
        {
          name: 'cad-playground-car',
          suite: 'engineering-heavy',
          args: [cadPlayground, '--grep', cadCar],
        },
        {
          name: 'simulation-drawing',
          suite: 'engineering-heavy',
          args: ['tests/e2e/simulation-playground.spec.ts', 'tests/e2e/drawing-sets.spec.ts'],
        },
      ],
    },
    4: {
      builds: false,
      steps: [
        {
          name: 'cad-playground-rest',
          suite: 'engineering-heavy',
          args: [cadPlayground, '--grep-invert', cadCar],
        },
      ],
    },
  };
}

/** Ports the suites' servers listen on, freed before and after each step. */
export function suitePorts(root) {
  const source = readFileSync(join(root, 'tests/playwright/suites.ts'), 'utf8');
  return [...new Set([...source.matchAll(/127\.0\.0\.1:(\d{4})/g)].map((match) => match[1]))];
}

/** Failure keys and counts of one Playwright JSON report. */
export function summarizeReport(report) {
  const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  const failures = [];
  for (const [key, status] of testStatuses(report)) {
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === 'unexpected') failures.push(key);
  }
  return { counts, failures, errors: runErrors(report) };
}

/** New and fixed failures against an earlier night's list (tests not run are not "fixed"). */
export function compareFailures(failures, previous, ran) {
  const before = new Set(previous);
  const now = new Set(failures);
  return {
    added: failures.filter((key) => !before.has(key)),
    fixed: previous.filter((key) => !now.has(key) && ran.has(key)),
  };
}

const sh = (command, args, options = {}) =>
  spawnSync(command, args, { stdio: 'inherit', ...options }).status ?? 1;

function freePorts(ports) {
  spawnSync('pkill', ['-f', 'node_modules/.bin/vite|scripts/[a-z-]*server\\.mjs|vite preview']);
  spawnSync('fuser', ['-k', ...ports.map((port) => `${port}/tcp`)], { stdio: 'ignore' });
}

function setup(root, group, kernel) {
  if (!existsSync(join(root, 'node_modules'))) sh('npm', ['ci'], { cwd: root });
  if (!existsSync(join(kernel, 'NOTICE.txt')))
    sh('node', ['scripts/cad-kernel/fetch.mjs', kernel, '--source'], { cwd: root });
  if (!group.builds) return 0;
  // animation-2d builds its font fixture with the FontTools the Office evidence pins.
  sh('python3', ['-m', 'pip', 'install', '--quiet', 'fonttools==4.61.1']);
  const env = { ...process.env, CAD_OCCT_DIST: kernel };
  for (const args of productionBuilds) {
    const status = sh('npx', ['vite', 'build', ...args], { cwd: root, env });
    if (status) return status;
  }
  return 0;
}

function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = process.cwd();
  if (!existsSync(join(root, 'tests/e2e'))) throw new Error('Run from the repository root.');
  const groups = nightlyGroups(root);
  const id = argv[0];
  const group = groups[id];
  if (!group) {
    console.error(`Usage: node scripts/e2e/nightly.mjs <${Object.keys(groups).join('|')}> ...`);
    return 2;
  }
  const out = resolve(value('--out') ?? 'work/e2e/nightly');
  mkdirSync(out, { recursive: true });
  const kernel = resolve(process.env.CAD_OCCT_DIST ?? 'work/cad-kernel');
  const started = Date.now();
  const lines = [`## Nightly e2e group ${id}`, ''];
  if (argv.includes('--setup')) {
    const status = setup(root, group, kernel);
    lines.push(`Setup: ${status ? `failed (exit ${status})` : 'ok'}, ${minutes(started)} min`);
    if (status) return finish(out, id, lines, [], argv, new Set());
  }
  // Each step stops after 100 minutes so a hung run cannot hold the group.
  const stepTimeout = Number(process.env.NIGHTLY_STEP_TIMEOUT ?? 6000);
  const ports = suitePorts(root);
  const failures = [];
  const ran = new Set();
  lines.push(
    ...(lines.length > 2 ? [''] : []),
    '| Step | Passed | Failed | Flaky | Skipped | Minutes |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  const notes = [];
  const only = value('--only')?.split(',');
  for (const step of group.steps.filter((entry) => !only || only.includes(entry.name))) {
    freePorts(ports);
    const json = join(out, `${step.name}.json`);
    const stepStart = Date.now();
    const status = sh(
      'timeout',
      [
        String(stepTimeout),
        process.execPath,
        join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--trace',
        'off',
        '--reporter=list,json',
        ...step.args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          E2E_SUITE: step.suite,
          CAD_OCCT_DIST: kernel,
          PLAYWRIGHT_JSON_OUTPUT_NAME: json,
        },
      },
    );
    freePorts(ports);
    const took = minutes(stepStart);
    if (!existsSync(json)) {
      lines.push(`| ${step.name} | – | – | – | – | ${took} |`);
      notes.push(`${step.name}: no report (exit ${status}${status === 124 ? ', timed out' : ''})`);
      continue;
    }
    const report = JSON.parse(readFileSync(json, 'utf8'));
    const summary = summarizeReport(report);
    for (const key of testStatuses(report).keys()) ran.add(key);
    const { expected, unexpected, flaky, skipped } = summary.counts;
    lines.push(`| ${step.name} | ${expected} | ${unexpected} | ${flaky} | ${skipped} | ${took} |`);
    if (status === 124) notes.push(`${step.name}: timed out after ${stepTimeout} s`);
    for (const error of summary.errors) notes.push(`${step.name}: ${error}`);
    failures.push(...summary.failures);
  }
  lines.push('', `Total: ${minutes(started)} min`);
  if (notes.length) lines.push('', '**Run problems**', ...notes.map((note) => `- ${note}`));
  return finish(out, id, lines, failures, argv, ran);
}

function finish(out, id, lines, failures, argv, ran) {
  const previousFile = argv.includes('--previous') ? argv[argv.indexOf('--previous') + 1] : '';
  if (previousFile && existsSync(previousFile)) {
    const previous = readFileSync(previousFile, 'utf8').split('\n').filter(Boolean);
    const { added, fixed } = compareFailures(failures, previous, ran);
    lines.push(
      '',
      `**New failures since the last night: ${added.length}**`,
      ...added.map((key) => `- ${key}`),
    );
    lines.push(
      '',
      `**Fixed since the last night: ${fixed.length}**`,
      ...fixed.map((key) => `- ${key}`),
    );
  }
  lines.push('', `<details><summary>All failures: ${failures.length}</summary>`, '');
  lines.push(...failures.map((key) => `- ${key}`), '', '</details>');
  writeFileSync(join(out, `failures-${id}.txt`), failures.map((key) => `${key}\n`).join(''));
  writeFileSync(join(out, `summary-${id}.md`), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return 0;
}

const minutes = (since) => Math.round((Date.now() - since) / 6000) / 10;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
