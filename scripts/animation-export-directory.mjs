import { createHash } from 'node:crypto';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Identify every emitted file by relative name and bytes, independent of staging location. */
export async function animationExportDigest(directory) {
  const files = [];
  async function visit(relative = '') {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, name));
        files.push([name, bytes.length, createHash('sha256').update(bytes).digest('hex')]);
      } else throw Error('Animation export contains a non-file entry');
    }
  }
  await visit();
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export async function publishAnimationExport(staging, root, prefix) {
  const digest = await animationExportDigest(staging),
    destination = path.join(root, prefix + '-' + digest);
  try {
    await rename(staging, destination);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    if ((await animationExportDigest(destination)) !== digest)
      throw Error('Existing Animation export differs from the complete emitted files');
    await rm(staging, { recursive: true });
  }
  return destination;
}
