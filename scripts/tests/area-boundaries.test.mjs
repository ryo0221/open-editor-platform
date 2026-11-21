import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { areaCrossings, checkBoundaries } from '../check-area-boundaries.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('the repository has no area crossings beyond the known list', () => {
  assert.deepEqual(checkBoundaries(root), { unexpected: [], resolved: [] });
});

test('a crossing is reported, and a resolved known crossing too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'area-boundaries-'));
  const manifest = (name, dependencies) => {
    mkdirSync(join(dir, 'packages', name), { recursive: true });
    writeFileSync(
      join(dir, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@editor-platform/${name}`, dependencies }),
    );
  };
  manifest('document', { '@editor-platform/cad-core': '*', '@editor-platform/editor-core': '*' });
  manifest('editor-core', {});
  manifest('cad-core', { '@editor-platform/editor-core': '*' });
  assert.deepEqual(
    areaCrossings(dir).map((entry) => entry.edge),
    ['document -> cad-core'],
  );
  const result = checkBoundaries(dir, ['cad-core -> slide']);
  assert.deepEqual(
    result.unexpected.map((entry) => entry.edge),
    ['document -> cad-core'],
  );
  assert.deepEqual(result.resolved, ['cad-core -> slide']);
});
