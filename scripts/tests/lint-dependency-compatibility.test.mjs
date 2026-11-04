import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

test('updated lint graph preserves TS/JS rules and domain import boundaries', async () => {
  const eslint = new ESLint();
  const [geometry] = await eslint.lintText("import '@editor-platform/cad';\n", {
    filePath: 'packages/geometry-mesh/src/publication-check.ts',
  });
  assert.ok(geometry.messages.some((message) => message.ruleId === 'no-restricted-imports'));
  const [character] = await eslint.lintText("import '@editor-platform/bim';\n", {
    filePath: 'packages/character/src/publication-check.ts',
  });
  assert.ok(character.messages.some((message) => message.ruleId === 'no-restricted-imports'));
  const [typescript] = await eslint.lintText('const unused: number = 1;\n', {
    filePath: 'packages/editor-core/src/publication-check.ts',
  });
  assert.ok(
    typescript.messages.some((message) => message.ruleId === '@typescript-eslint/no-unused-vars'),
  );
  const [javascript] = await eslint.lintText('unknownGlobal();\n', {
    filePath: 'scripts/publication-check.mjs',
  });
  assert.ok(javascript.messages.some((message) => message.ruleId === 'no-undef'));
  assert.equal(await eslint.isPathIgnored('work/publication-check.ts'), true);
  assert.equal(await eslint.isPathIgnored('packages/character/src/model.ts'), false);
});
