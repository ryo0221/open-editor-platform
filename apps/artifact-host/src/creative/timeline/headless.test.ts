import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { resolve } from 'node:path';

describe('public Timeline readers in a Node Host', () => {
  it('reads explicit owner bindings and tl1 tables without loading a Surface or modifying input', async () => {
    const fixture = JSON.parse(readFileSync('docs/story-timeline/fixtures/f0.json', 'utf8'));
    const result = await build({
      stdin: {
        contents: `
          import { readTimelineTable } from '@editor-platform/reference-artifact-host/creative/timeline/table';
          import { readWorkspaceLinks } from '@editor-platform/reference-artifact-host/creative/workspace/links';
          const fixture = ${JSON.stringify(fixture)};
          const before = JSON.stringify(fixture);
          const links = readWorkspaceLinks(fixture.links);
          const story = links.story;
          const owners = [
            [story.composition, 'composition'], [story.worldSettings, 'world'],
            ...story.ledgers.map(l => [l.artifactId, 'ledger']),
            ...story.sceneCards.map(id => [id, 'scene-cards']),
          ];
          const states = owners.map(([id, role]) => readTimelineTable(role,
            fixture.artifacts.find(a => a.id === id).draft.content).state);
          let refused = false;
          try { readWorkspaceLinks({ ...fixture.links, future: true }); } catch { refused = true; }
          console.log(JSON.stringify({ states, refused, unchanged: before === JSON.stringify(fixture),
            dom: typeof document !== 'undefined' || typeof window !== 'undefined' }));
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).filter((path) =>
        /(?:react-dom|node_modules\/react\/|\.tsx$|\.css$)/.test(path),
      ),
    ).toEqual([]);
    const output = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module'], {
        input: result.outputFiles[0].text,
        encoding: 'utf8',
      }),
    );
    expect(output.states.length).toBeGreaterThan(0);
    expect(output.states.every((state: string) => state === 'valid')).toBe(true);
    expect(output.refused).toBe(true);
    expect(output.unchanged).toBe(true);
    expect(output.dom).toBe(false);
  });
});

it('typechecks a consumer with only the public readers as roots, without repository ambient files', () => {
  const file = resolve('headless-consumer.ts');
  const source = `import { readWorkspaceLinks } from '@editor-platform/reference-artifact-host/creative/workspace/links';
import { readTimelineTable } from '@editor-platform/reference-artifact-host/creative/timeline/table';
void readWorkspaceLinks; void readTimelineTable;`;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) =>
    path === file
      ? ts.createSourceFile(path, source, languageVersion)
      : original(path, languageVersion, ...rest);
  const program = ts.createProgram([file], options, host);
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}, 30_000);
