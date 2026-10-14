import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const runner = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const corpus = 'packages/slide-import/src/import.test.ts';
const args = process.argv.slice(2);
// Keep focused/custom Vitest arguments unchanged. The ordinary complete check
// gives the native-codec corpus a fresh process after the remaining files.
const runs = args.length ? [args] : [['--exclude', corpus], [corpus]];
for (const options of runs) {
  const result = spawnSync(process.execPath, [runner, 'run', ...options], {
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
