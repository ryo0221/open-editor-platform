import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { repositoryRoot } from './office-fonts.mjs';
import { isGeneratedEvidence } from './repository-file-policy.mjs';

const limit = 1_000_000;
const exceptions = JSON.parse(
  await readFile(new URL('../docs/large-file-exceptions.json', import.meta.url), 'utf8'),
);
const paths = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const failures = [];
for (const path of paths) {
  if (isGeneratedEvidence(path)) {
    failures.push({ path, reason: 'Generated evidence belongs in Actions artifacts or Release assets.' });
    continue;
  }
  let info;
  try {
    info = await lstat(join(repositoryRoot, path));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  if (!info.isFile() || info.size <= limit) continue;
  const exception = exceptions.find((item) => item.path === path);
  if (
    !exception?.reason?.trim() ||
    !Number.isSafeInteger(exception.maxBytes) ||
    info.size > exception.maxBytes
  )
    failures.push({ path, bytes: info.size });
}
process.stdout.write(
  `${JSON.stringify({ limitBytes: limit, checkedFiles: paths.length, failures }, null, 2)}\n`,
);
if (failures.length) process.exitCode = 1;
