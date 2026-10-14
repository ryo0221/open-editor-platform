import { URL } from 'node:url';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { link, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { downloadPinned } from './lib/pinned-download.mjs';
import {
  fontManifests,
  inspectOfficeFonts,
  officeFontRoot,
  repositoryRoot,
} from './office-fonts.mjs';

try {
  if (process.argv.length > 3) throw Error('Usage: npm run fonts:fetch -- [font-directory]');
  const root = process.argv[2] ? resolve(process.argv[2]) : officeFontRoot;
  const { missing } = await inspectOfficeFonts(root, true);
  if (!missing.length) {
    process.stdout.write('Fixed Office fonts already match all four hashes; no download needed.\n');
  } else {
    const python = process.env.EDITOR_FONT_PYTHON || 'python3';
    const probe = spawnSync(python, [
      '-I',
      '-c',
      'import sys; sys.exit(sys.version_info < (3, 10))',
    ]);
    if (probe.status !== 0)
      throw Error(
        'Font extraction requires Python 3.10+. Install it or set EDITOR_FONT_PYTHON to its executable; pip is not required.',
      );
    const pins = JSON.parse(
      await readFile(new URL('./office/fonts-source.json', import.meta.url), 'utf8'),
    );
    const cache =
      process.env.EDITOR_FONT_CACHE || join(repositoryRoot, 'node_modules/.cache/office-fonts');
    await mkdir(cache, { recursive: true });
    for (const pin of [pins.archive, pins.fonttools])
      process.stdout.write(`${pin.file}: ${await downloadPinned(pin, join(cache, pin.file))}\n`);
    // Extraction is private working data, never a publicDir/build asset.
    const staged = await mkdtemp(join(cache, '.extract-'));
    try {
      const result = spawnSync(
        python,
        [
          '-I',
          join(repositoryRoot, 'scripts/office/extract-office-fonts.py'),
          join(cache, pins.archive.file),
          join(cache, pins.fonttools.file),
          root,
          staged,
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0)
        throw Error(
          'Fixed font extraction failed; existing fonts and expected hashes were preserved.',
        );
      for (const name of fontManifests) await copyFile(join(root, name), join(staged, name));
      await inspectOfficeFonts(staged);
      for (const face of missing) {
        try {
          await link(join(staged, face.file), join(root, face.file));
        } catch (error) {
          if (error.code === 'EXDEV') {
            try {
              await copyFile(
                join(staged, face.file),
                join(root, face.file),
                constants.COPYFILE_EXCL,
              );
            } catch (copyError) {
              if (copyError.code !== 'EEXIST') throw copyError;
            }
          } else if (error.code !== 'EEXIST') throw error;
        }
      }
      await inspectOfficeFonts(root);
      process.stdout.write(
        'Fixed Office fonts ready; all four existing manifest hashes preserved.\n',
      );
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
