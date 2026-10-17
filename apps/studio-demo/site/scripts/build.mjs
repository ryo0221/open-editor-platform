import console from 'node:console';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { nativeResolver } from './native-resolver.mjs';
await mkdir('dist/assets', { recursive: true });
const options = {
  bundle: true,
  minify: true,
  jsx: 'automatic',
  outdir: 'dist/assets',
  entryNames: '[name]',
  format: 'iife',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'linked',
};
// The archived pre-Host prototype is optional; current Studio has its own preview.
const hasArchivedPreview = existsSync('src/preview.jsx');
if (hasArchivedPreview) await build({ ...options, entryPoints: { preview: 'src/preview.jsx' } });
await writeFile(
  'dist/index.html',
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="description" content="SORAの企画書、事業モデル、音声認識ソフト、開発タスク、React製品サイトを編集できるEditor Platformのブラウザー保存デモ。"><title>SORA Studio — Editor Platform v2.3</title><link rel="icon" href="./favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="./assets/app.css"></head><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`,
);
const previewJS = (
  hasArchivedPreview ? await readFile('dist/assets/preview.js', 'utf8') : ''
).replace(/<\/script/gi, '<\\/script');
const previewHash = createHash('sha256').update(previewJS).digest('base64');
const previewDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${previewHash}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none';"><title>Isolated React canvas</title></head><body><div id="preview-root"></div><script>${previewJS}</script></body></html>`;
if (hasArchivedPreview) await writeFile('dist/preview.html', previewDocument);
await build({ ...options, entryPoints: { 'code-preview': 'src/code-preview.jsx' } });
const codeJS = (await readFile('dist/assets/code-preview.js', 'utf8')).replace(
  /<\/script/gi,
  '<\\/script',
);
const codeHash = createHash('sha256').update(codeJS).digest('base64');
const codeDocument = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${codeHash}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none';"><title>SORA Voice isolated preview</title><style>body{margin:0;background:#fff}</style></head><body><div id="code-root"></div><script>${codeJS}</script></body></html>`;
await writeFile('dist/code-preview.html', codeDocument);
await build({
  ...options,
  entryPoints: { 'artifact-preview': 'vendor/editor-platform/apps/artifact-host/src/preview.tsx' },
});
const artifactJS = (await readFile('dist/assets/artifact-preview.js', 'utf8')).replace(
  /<\/script/gi,
  '<\\/script',
);
const artifactHash = createHash('sha256').update(artifactJS).digest('base64');
const artifactDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${artifactHash}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"></head><body><div id="root"></div><script>${artifactJS}</script></body></html>`;
await build({
  ...options,
  format: 'esm',
  plugins: [nativeResolver],
  entryPoints: { app: 'src/studio.jsx' },
  define: {
    ...options.define,
    __PREVIEW_DOCUMENT__: JSON.stringify(previewDocument),
    __CODE_DOCUMENT__: JSON.stringify(codeDocument),
    __ARTIFACT_PREVIEW_DOCUMENT__: JSON.stringify(artifactDocument),
  },
});
await writeFile(
  'dist/favicon.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="7" fill="#f4f7ef"/><path d="M9 9h9v9H9zm13 0h9v9h-9zM9 22h9v9H9z" fill="#2d4231"/><path d="M22 22h9v9h-9z" fill="#799d87"/></svg>',
);
console.log(
  'Built SORA Artifact Host: native Slide/Whiteboard/Design, Host Code, Data Kanban, and runtime-independent React output.',
);
