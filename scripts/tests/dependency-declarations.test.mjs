import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { undeclaredImports } from '../check-dependency-declarations.mjs';

test('every workspace declares the packages its source imports', () => {
  assert.deepEqual(undeclaredImports(process.cwd()), []);
});
