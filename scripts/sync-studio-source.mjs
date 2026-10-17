import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';
const checkout = process.argv[2];
const pin = process.argv[3];
if (!checkout)
  throw Error('Usage: node scripts/sync-studio-source.mjs SITE_CHECKOUT [VERIFIED_COMMIT]');
const root = resolve(import.meta.dirname, '..'),
  site = resolve(checkout);
// Use Git's source inventory so ignored dependencies/builds never enter provenance.
const files = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'packages',
    'apps/artifact-host/src',
    'apps/artifact-host/package.json',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(
    (path) =>
      path &&
      (/\.(ts|tsx|css)$/.test(path) || path.endsWith('/package.json')) &&
      !/\.test\./.test(path),
  );
const entries = [];
for (const path of files) {
  const blob = execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim();
  if (
    pin &&
    execFileSync('git', ['rev-parse', `${pin}:${path}`], { cwd: root, encoding: 'utf8' }).trim() !==
      blob
  )
    throw Error('Working source differs from verified commit: ' + path);
  const dest = resolve(site, 'vendor/editor-platform', path);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(resolve(root, path), dest);
  entries.push({ path, sha: blob });
}
const studio = resolve(root, 'apps/studio-demo/src');
for (const name of await readdir(studio)) {
  if (name.includes('.test.')) continue;
  const path = 'apps/studio-demo/src/' + name;
  const blob = execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim();
  if (
    pin &&
    execFileSync('git', ['rev-parse', `${pin}:${path}`], { cwd: root, encoding: 'utf8' }).trim() !==
      blob
  )
    throw Error('Studio source differs from verified commit: ' + name);
  await copyFile(resolve(studio, name), resolve(site, 'src', name));
  entries.push({ path, sitePath: 'src/' + name, sha: blob });
}
async function copySiteSupport(dir) {
  for (const item of await readdir(resolve(root, dir), { withFileTypes: true })) {
    const path = dir + '/' + item.name;
    if (item.isDirectory()) {
      await copySiteSupport(path);
      continue;
    }
    const sitePath = path.replace('apps/studio-demo/site/', '');
    const blob = execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim();
    if (
      pin &&
      execFileSync('git', ['rev-parse', `${pin}:${path}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim() !== blob
    )
      throw Error('Site support differs from verified commit: ' + path);
    await mkdir(dirname(resolve(site, sitePath)), { recursive: true });
    await copyFile(resolve(root, path), resolve(site, sitePath));
    entries.push({ path, sitePath, sha: blob });
  }
}
await copySiteSupport('apps/studio-demo/site');
// Record the checkout's repository without hard-coding a private or upstream name.
// Credentials/host selectors are never copied into the source-only manifest.
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
let repository;
try {
  repository = (
    remote.includes('://') ? new URL(remote).pathname : remote.split(':').slice(1).join(':')
  )
    .replace(/^\/+/, '')
    .replace(/\.git$/, '');
} catch {
  throw Error('Cannot identify the canonical source repository');
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
  throw Error('Cannot identify the canonical source repository');
const origin = {
  repository,
  commit: pin ?? null,
  workspaceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files: entries,
};
await writeFile(
  resolve(site, 'vendor/editor-platform/origin.json'),
  JSON.stringify(origin, null, 2) + '\n',
);
// This step copies source only. It never reads credentials or builds/pushes/deploys.
const manifest = JSON.parse(await readFile(resolve(site, '.openai/hosting.json'), 'utf8'));
process.stdout.write(
  JSON.stringify({
    checkout: relative('/workspace', site),
    project_id: manifest.project_id,
    commit: origin.commit,
    sourceFiles: entries.length,
  }) + '\n',
);
