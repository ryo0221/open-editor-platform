import ts from 'typescript';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
const requestFile = process.argv[2],
  previousFile = process.argv[3];
if (!requestFile)
  throw Error('Usage: node scripts/react-ui-register.mjs REQUEST.json [PREVIOUS_CANDIDATES.json]');
const root = resolve(import.meta.dirname, '..'),
  base = dirname(resolve(requestFile));
const request = JSON.parse(await readFile(requestFile, 'utf8'));
// Bundles only checked-in tooling, never the Host component source files.
const target = resolve(root, 'work/issue-38/registration-tooling.mjs');
await mkdir(dirname(target), { recursive: true });
await build({
  stdin: {
    contents:
      'export { extractReactRegistrationCandidates, validateReactExtractionRequest } from "@editor-platform/react-ui-tooling"; export { diffReactRegistrationCandidates } from "@editor-platform/react-ui-core";',
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['typescript'],
  outfile: target,
});
const api = await import(pathToFileURL(target).href);
if (!request || typeof request !== 'object' || Array.isArray(request))
  throw Error('Invalid extraction request fields');
const { tsconfig, ...metadata } = request;
if (
  Object.hasOwn(request, 'tsconfig') &&
  (typeof tsconfig !== 'string' || !tsconfig.trim() || tsconfig.length > 4096)
)
  throw Error('Invalid extraction tsconfig');
api.validateReactExtractionRequest(metadata);
const configPath = tsconfig && resolve(base, tsconfig);
const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  configPath ? dirname(configPath) : base,
);
// Entrypoints are explicitly added below, so a glob finding no inputs (18003)
// does not invalidate the request. Every other configuration diagnostic is fatal.
const configErrors = parsed.errors.filter((d) => d.code !== 18003);
if (configErrors.length)
  throw Error(
    configErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
  );
const entries = metadata.entries.map((entry) => ({ ...entry, file: resolve(base, entry.file) }));
const options = {
  strict: true,
  skipLibCheck: true,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  ...parsed.options,
  noEmit: true,
};
const program = ts.createProgram(
  [...new Set([...parsed.fileNames, ...entries.map((e) => e.file)])],
  options,
);
const result = api.extractReactRegistrationCandidates(program, { ...metadata, entries });
const snapshot = {
  sourceRevision: result.sourceRevision,
  candidates: result.candidates.map((c) => c.proposed),
};
const previous = previousFile ? JSON.parse(await readFile(previousFile, 'utf8')) : undefined;
if (previous?.diagnostics?.length)
  throw Error('Resolve previous extraction diagnostics before comparing candidates');
const differences =
  previous && !result.diagnostics.length
    ? api.diffReactRegistrationCandidates(
        { sourceRevision: previous.sourceRevision, candidates: previous.candidates },
        snapshot,
      )
    : undefined;
console.log(
  JSON.stringify(
    {
      ...snapshot,
      diagnostics: result.diagnostics,
      excluded: result.excluded,
      ...(differences ? { differences } : {}),
    },
    null,
    2,
  ),
);
if (result.diagnostics.length) process.exitCode = 1;
