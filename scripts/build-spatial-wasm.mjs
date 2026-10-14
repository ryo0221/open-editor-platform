import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = fileURLToPath(new URL('../work/spatial-target/', import.meta.url));
const output = fileURLToPath(new URL('../work/spatial-wasm/', import.meta.url));
execFileSync(
  'cargo',
  [
    '+1.90.0',
    'build',
    '--locked',
    '--offline',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    `${root}packages/spatial-index/rust/Cargo.toml`,
    '--target-dir',
    target,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: '-C link-arg=--max-memory=67108864' },
  },
);
mkdirSync(output, { recursive: true });
copyFileSync(
  `${target}/wasm32-unknown-unknown/release/editor_spatial_index.wasm`,
  `${output}/spatial.wasm`,
);
process.stdout.write('Optional spatial artifact: work/spatial-wasm/spatial.wasm (not committed)\n');
if (process.argv.includes('--test')) {
  execFileSync(
    'cargo',
    [
      '+1.90.0',
      'test',
      '--locked',
      '--offline',
      '--manifest-path',
      `${root}packages/spatial-index/rust/Cargo.toml`,
      '--target-dir',
      target,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      'packages/spatial-index',
      'packages/canvas-ui/src/spatial-query.test.ts',
      '--maxWorkers=1',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, SPATIAL_WASM_REQUIRED: '1' },
    },
  );
}
