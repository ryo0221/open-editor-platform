import { Buffer } from 'node:buffer';
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['apps/collaboration-reference/src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
});
await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
