import console from 'node:console';
import process from 'node:process';
/** Rebuild/check the independent oracle from local, reviewed Git objects only. */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
export const pin = 'c27b96cf7ebb6bafa2581b6b5bf0be45152a2348';
const base = dirname(fileURLToPath(import.meta.url));
const core = 'packages/video-core/src/';
const roots = [
  'packages/video-metadata/host-media/m2/mix-v2.ts',
  'packages/video-core/experiments/pcm-renderer/session.ts',
];
const facadeRoots = [
  'time',
  'model',
  'v1/model',
  'v1/validation',
  'v1/evaluate',
  'v2/model',
  'v2/validation',
  'v2/gain',
];
const facade = facadeRoots.map((p) => `export * from './${core}${p}';`).join('\n') + '\n';
const git = (...args) => execFileSync('git', args, { cwd: base, encoding: 'utf8' });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const expected = new Map([['frozen/core.ts', facade]]),
  files = [];
const seen = new Set();
function visit(path) {
  if (seen.has(path)) return;
  seen.add(path);
  const original = git('show', `${pin}:${path}`);
  const ast = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
  let frozen = original;
  const replacements = [];
  for (const node of ast.statements) {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier)
      continue;
    const spec = node.moduleSpecifier.text;
    if (spec === '@editor-platform/video-core') {
      const target = posix.relative(posix.dirname(path), 'core');
      replacements.push([
        node.moduleSpecifier.getStart(ast),
        node.moduleSpecifier.end,
        `'${target.startsWith('.') ? target : './' + target}'`,
      ]);
    } else {
      if (!spec.startsWith('.')) throw Error(`Unexpected oracle dependency ${path}: ${spec}`);
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      visit(target.endsWith('.ts') ? target : target + '.ts');
    }
  }
  for (const [start, end, text] of replacements.reverse())
    frozen = frozen.slice(0, start) + text + frozen.slice(end);
  const destination = 'frozen/' + path;
  expected.set(destination, frozen);
  files.push({
    original: path,
    gitBlob: git('rev-parse', `${pin}:${path}`).trim(),
    originalSha256: hash(original),
    frozen: destination,
    frozenSha256: hash(frozen),
  });
}
for (const p of [...roots, ...facadeRoots.map((p) => core + p + '.ts')]) visit(p);
expected.set(
  'oracle-inputs.json',
  JSON.stringify(
    {
      pin,
      scope:
        'Whole numerical dependency closure from deterministic decoded planes through source renderer, request ordering, gain/fade, mix and final guard. Native decoding/ownership excluded.',
      change:
        'Only package-barrel imports redirected to frozen/core.ts; local paths and all original numerical statements unchanged. Facade selects original source exports; no live numerical imports.',
      facadeSha256: hash(facade),
      files: files.sort((a, b) => a.original.localeCompare(b.original)),
    },
    null,
    2,
  ) + '\n',
);
if (process.argv.includes('--write')) {
  for (const [path, data] of expected) {
    mkdirSync(dirname(resolve(base, path)), { recursive: true });
    writeFileSync(resolve(base, path), data);
  }
} else {
  for (const [path, data] of expected)
    if (readFileSync(resolve(base, path), 'utf8') !== data) throw Error(`Oracle drift: ${path}`);
  const actual = readdirSync(resolve(base, 'frozen'), { recursive: true, withFileTypes: true })
    .filter((x) => x.isFile())
    .map((x) => relative(base, resolve(x.parentPath, x.name)));
  if (actual.some((p) => !expected.has(p)) || actual.length !== expected.size - 1)
    throw Error('Unexpected frozen file');
}
console.log(
  JSON.stringify({
    pin,
    files: files.length,
    mode: process.argv.includes('--write') ? 'write' : 'check',
    manifestSha256: hash(expected.get('oracle-inputs.json')),
  }),
);
