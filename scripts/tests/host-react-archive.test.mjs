import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { extractReactArchive, reactArchiveLimits as limits } from '../lib/host-react-archive.mjs';

const page = strToU8('export function ProductPage(){ return <h1>保存したReactページ</h1> }');
test('accepts normal TSX, TS, declarations, CSS and export metadata', () => {
  const files = {
    'ProductPage.tsx': page,
    'nested/value.ts': strToU8('export const value = 1;'),
    'types.d.ts': strToU8('export type Value = number;'),
    'style.css': strToU8('h1 { color: blue; }'),
    'native.json': strToU8('{}'),
    'README.md': strToU8('Generated output'),
  };
  assert.deepEqual({ ...extractReactArchive(zipSync(files)) }, files);
});
test('rejects compressed input before parsing', () => {
  assert.throws(
    () => extractReactArchive(new Uint8Array(limits.compressedBytes + 1)),
    /Compressed ZIP limit/,
  );
});
test('rejects a highly compressed file before inflation', () => {
  const bomb = zipSync({ 'ProductPage.tsx': new Uint8Array(limits.fileBytes + 1) });
  assert.ok(bomb.length < 4096);
  assert.throws(() => extractReactArchive(bomb), /Expanded ZIP limit/);
});
test('rejects the aggregate expansion limit', () => {
  const files = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`file${i}.tsx`, new Uint8Array(limits.fileBytes)]),
  );
  assert.throws(() => extractReactArchive(zipSync(files)), /Expanded ZIP limit/);
});
test('rejects too many entries before inflation', () => {
  const files = Object.fromEntries(
    Array.from({ length: limits.entries + 1 }, (_, i) => [`file${i}.tsx`, page]),
  );
  assert.throws(() => extractReactArchive(zipSync(files)), /ZIP entry limit/);
});
test('bounds actual expansion when both local and central declared sizes lie', () => {
  const bomb = zipSync({ 'ProductPage.tsx': new Uint8Array(limits.fileBytes + 1) });
  const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  view.setUint32(22, 1, true);
  for (let at = 0; at < bomb.length - 46; at++)
    if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, 1, true);
  assert.throws(() => extractReactArchive(bomb), /Actual ZIP expansion limit/);
});
test('rejects mismatched local and central entry sizes', () => {
  const zip = zipSync({ 'ProductPage.tsx': page });
  new DataView(zip.buffer, zip.byteOffset, zip.byteLength).setUint32(22, 1, true);
  assert.throws(() => extractReactArchive(zip), /ZIP entry mismatch/);
});
for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts']) {
  test(`rejects ${extension} sources even with matching declarations`, () => {
    const zip = zipSync({
      'ProductPage.tsx': page,
      [`Runtime.${extension}`]: strToU8("export * from '@editor-platform/editor-core';"),
      'Runtime.d.ts': strToU8('export declare const runtime: unknown;'),
    });
    assert.throws(() => extractReactArchive(zip), /Unsupported export file type/);
  });
}
for (const name of ['Runtime.ts', 'Runtime.tsx', 'Runtime.d.ts', 'style.css']) {
  test(`rejects Editor dependencies in ${name}`, () => {
    const zip = zipSync({ [name]: strToU8("import '@editor-platform/editor-core';") });
    assert.throws(() => extractReactArchive(zip), /Editor runtime dependency/);
  });
}
test('checks decoded TS import strings', () => {
  const zip = zipSync({ 'Runtime.ts': strToU8("import '@editor-\\u0070latform/editor-core';") });
  assert.throws(() => extractReactArchive(zip), /Editor runtime dependency/);
});
test('rejects case-colliding paths', () => {
  const zip = zipSync({ 'ProductPage.tsx': page, 'productpage.tsx': page });
  assert.throws(() => extractReactArchive(zip), /Invalid export path/);
});
