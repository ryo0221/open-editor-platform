import { build } from 'esbuild';
import { expect, it } from 'vitest';

for (const platform of ['node', 'browser'] as const)
  it(`public Document preflight bundles for ${platform} without React or an Office encoder`, async () => {
    const result = await build({
      stdin: {
        contents: `export { captureDocumentExportSnapshot, prepareDocumentDocx } from '@editor-platform/document-export/plan';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform,
      format: 'esm',
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some((p) =>
        /react|canvas-ui|editor-ui|slide-export|pptxgenjs|node_modules\/docx\//.test(p),
      ),
    ).toBe(false);
    expect(result.outputFiles[0].text).not.toMatch(/\b(window|document|fetch)\./);
  });
