import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';

// Each wording dictionary is keyed by text written in its package's views. An entry whose key no
// longer appears in the source is dead: the text was reworded and silently lost its wording.
const packages = ['editor-ui', 'canvas-ui', 'document', 'structured-data', 'design'];

function keysOf(source) {
  const keys = [];
  // Entry lines of the dictionaries: `Key: '…',`, `'Key': '…',` or a key on its own line.
  for (const line of source.split('\n')) {
    const match = /^\s{4}(?:'((?:[^'\\]|\\.)+)'|([\p{L}\p{N}_$]+)):/u.exec(line);
    if (match) keys.push((match[1] ?? match[2]).replace(/\\'/g, "'"));
  }
  return keys;
}

for (const name of packages) {
  test(`${name}: every wording key is text written in the package`, () => {
    const dir = new URL(`../../packages/${name}/src/`, import.meta.url);
    const files = readdirSync(dir).filter((file) => /\.tsx?$/.test(file) && !/\.test\./.test(file));
    const wordingFile = files.find((file) => /^wording\.tsx?$/.test(file));
    assert.ok(wordingFile, 'wording file');
    const sources = files
      .filter((file) => file !== wordingFile || name === 'editor-ui')
      .map((file) => readFileSync(new URL(file, dir), 'utf8'))
      .join('\n');
    const body =
      name === 'editor-ui'
        ? sources.replace(/export const editorUiWording[\s\S]*?\n};\n/, '')
        : sources;
    const keys = keysOf(readFileSync(new URL(wordingFile, dir), 'utf8'));
    assert.ok(keys.length > 0, 'keys');
    const dead = keys.filter((key) => !body.includes(key));
    assert.deepEqual(dead, []);
  });
}
