import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { verifyOfficeFonts, officeFontRoot, repositoryRoot } from './office-fonts.mjs';
await verifyOfficeFonts();
const directory = path.join(repositoryRoot, 'work/issue74-2d');
await mkdir(directory, { recursive: true });
const result = spawnSync(
  'pyftsubset',
  [
    path.join(officeFontRoot, 'NotoSansCJKjp-Regular.otf'),
    '--text=日本語アニメーション編集テスト保存新旧形式テキストABC abc123',
    '--name-IDs=*',
    '--name-languages=*',
    '--name-legacy',
    '--output-file=' + path.join(directory, 'japanese-subset.otf'),
  ],
  { encoding: 'utf8' },
);
if (result.status !== 0)
  throw Error(
    'Animation font fixture needs FontTools (the same pinned tool as Office evidence): ' +
      (result.stderr || result.error || result.stdout),
  );
process.stdout.write(path.join(directory, 'japanese-subset.otf') + '\n');
