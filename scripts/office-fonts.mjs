import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { fileDigest } from './lib/pinned-download.mjs';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const officeFontRoot = join(repositoryRoot, 'apps/playground/public/office-fonts');
export const fontManifests = ['manifest.json', 'mono-manifest.json'];
export const fontHelp =
  'Run npm run fonts:fetch in the Editor Platform checkout, then rebuild before preview/export. No fallback font is used.';

export async function inspectOfficeFonts(root = officeFontRoot, allowMissing = false) {
  const faces = [],
    missing = [];
  for (const name of fontManifests) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, name), 'utf8'));
    } catch (error) {
      throw Error(`Cannot read the fixed Office font manifest ${join(root, name)}. ${fontHelp}`, {
        cause: error,
      });
    }
    if (!Array.isArray(manifest.faces) || manifest.faces.length !== 2)
      throw Error(`Invalid fixed Office font manifest: ${name}; exactly two faces are required.`);
    for (const face of manifest.faces) {
      if (basename(face.file) !== face.file || !/^[a-f0-9]{64}$/.test(face.sha256))
        throw Error(`Invalid fixed Office font manifest: ${name}`);
      faces.push(face);
      const path = join(root, face.file);
      try {
        if (!(await stat(path)).isFile() || (await fileDigest(path)) !== face.sha256)
          throw Error(
            `Fixed Office font SHA-256 mismatch: ${path}. Remove the invalid generated file before fetching again. ${fontHelp}`,
          );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push(face);
      }
    }
  }
  if (missing.length && !allowMissing)
    throw Error(
      `Missing fixed Office fonts: ${missing.map((face) => face.file).join(', ')}. ${fontHelp}`,
    );
  return { faces, missing };
}

export async function verifyOfficeFonts(root = officeFontRoot) {
  await inspectOfficeFonts(root);
}
