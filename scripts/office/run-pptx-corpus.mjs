import { verifyOfficeFonts } from '../office-fonts.mjs';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { mkdir } from 'node:fs/promises';
await verifyOfficeFonts();
const output = 'node_modules/.cache/editor-office';
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['scripts/office/pptx-corpus.ts'],
  outfile: `${output}/pptx-corpus.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@napi-rs/canvas'],
  banner: {
    js: "import { createRequire as __officeRequire } from 'node:module'; const require = __officeRequire(import.meta.url);",
  },
});
const result = spawnSync(
  process.execPath,
  [`${output}/pptx-corpus.mjs`, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);
process.exitCode = result.status ?? 1;
