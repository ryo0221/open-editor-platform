import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { URL } from 'node:url';

export const filePolicy = JSON.parse(
  readFileSync(new URL('./repository-file-policy.json', import.meta.url), 'utf8'),
);

export function isGeneratedEvidence(path) {
  if (!filePolicy.generatedRoots.some((root) => path.startsWith(root))) return false;
  if (filePolicy.retainedPaths.includes(path)) return false;
  const name = posix.basename(path);
  return (
    filePolicy.generatedNames.includes(name) ||
    filePolicy.generatedNameFragments.some((fragment) => name.includes(fragment)) ||
    !filePolicy.sourceExtensions.includes(posix.extname(path))
  );
}
