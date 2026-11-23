// Run the unit tests or lint for only what a branch changed since a base revision.
// Usage: node scripts/gates/affected.mjs unit|lint [--base main]
// Unit tests: the test files that import a changed file (vitest related). Paths are
// classified like scripts/e2e/affected.mjs; a change to shared configuration runs everything.
import console from 'node:console';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { classifyPath } from '../e2e/affected.mjs';
import { workspaceGraph } from '../e2e/areas.mjs';

const argv = process.argv.slice(2);
const mode = argv[0];
const baseAt = argv.indexOf('--base');
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
const resolves = (ref) => {
  try {
    return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)[0];
  } catch {
    return undefined;
  }
};
// The base: --base, else main or origin/main. A copy without those refs (an isolated checkout)
// falls back to the last main merged into the branch, named in its merge message.
function baseCommit() {
  if (baseAt >= 0) return resolves(argv[baseAt + 1]);
  for (const ref of ['main', 'origin/main']) {
    const sha = resolves(ref);
    if (sha) return sha;
  }
  // A shallow history can end in a missing parent: read what git printed before it stopped.
  const log =
    spawnSync('git', ['log', '--format=%s', '-n', '200'], { encoding: 'utf8' }).stdout ?? '';
  for (const subject of log.split('\n')) {
    const m = /main を取り込む（([0-9a-f]{7,40})）|Merge branch 'main'/.exec(subject);
    if (m?.[1] && resolves(m[1])) return m[1];
  }
  return undefined;
}
const base = baseCommit();
if (!base) {
  console.log('No base revision found (no main ref): checking everything.');
  if (mode === 'lint') {
    const r = spawnSync('npx', ['eslint', '.'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (mode === 'unit') {
    const r = spawnSync('npm', ['test'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
const from = git('merge-base', base, 'HEAD')[0];
console.log(`Base: ${from.slice(0, 12)}`);
const changed = [
  ...new Set([
    ...git('diff', '--name-only', from),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]),
].sort();
// Lint and format settings change no test result.
const lintOnly = /^(eslint\.config\.[cm]?js|\.prettierrc(\.json)?|\.prettierignore)$/;
const code = (path) =>
  /\.(m?[jt]sx?|cjs|json)$/.test(path) &&
  !/^(docs|design|trace)\//.test(path) &&
  !lintOnly.test(path) &&
  path !== 'workflow.json' &&
  path !== 'definition.json';
const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  process.exit(r.error || r.status !== 0 ? (r.status ?? 1) : 0);
};

if (mode === 'lint') {
  const files = changed.filter((p) => /\.(m?[jt]sx?|cjs)$/.test(p) && existsSync(p));
  if (!files.length) {
    console.log('No changed source files to lint.');
    process.exit(0);
  }
  run('npx', ['eslint', '--no-warn-ignored', ...files]);
} else if (mode === 'unit') {
  const graph = workspaceGraph(process.cwd());
  const packages = new Set(graph.users.keys());
  const direct = new Set();
  let everything = false;
  for (const path of changed.filter(code)) {
    const what = classifyPath(path, packages);
    if (what.kind === 'package') direct.add(what.name);
    else if (what.kind === 'kinds') what.names.forEach((n) => packages.has(n) && direct.add(n));
    else if (
      what.kind !== 'none' &&
      what.kind !== 'spec' &&
      what.kind !== 'helper' &&
      what.kind !== 'fixture'
    )
      everything = true;
  }
  if (everything) run('npm', ['test']);
  if (!direct.size) {
    console.log('No package code changed: no unit tests to run.');
    process.exit(0);
  }
  // Only the test files that import a changed file, directly or through other modules.
  // Workspace packages export their src, so Vitest's module graph crosses package lines.
  const files = changed.filter((p) => code(p) && /^(packages|apps)\//.test(p) && existsSync(p));
  console.log(
    `Changed packages: ${[...direct].sort().join(', ')}\nTesting the files that reach ${files.length} changed files.`,
  );
  run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'related',
    '--run',
    '--passWithNoTests',
    ...files,
  ]);
} else {
  console.error('usage: node scripts/gates/affected.mjs unit|lint [--base main]');
  process.exit(2);
}
