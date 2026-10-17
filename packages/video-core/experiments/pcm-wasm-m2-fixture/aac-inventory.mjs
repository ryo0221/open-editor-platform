/** Static inspection only: do not instantiate a worker/WASM or allocate its declared memory. */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
const root = resolve(process.argv[2], 'node_modules/@mediabunny/aac-encoder');
const bundle = readFileSync(resolve(root, 'dist/bundles/mediabunny-aac-encoder.mjs'), 'utf8');
const sha = (x) => createHash('sha256').update(x).digest('hex');
if (sha(bundle) !== 'a8f777ab53d8d654bd2339e974de8c80f457e68943afd72e7e55ca0f0dbea214')
  throw Error('AAC bundle drift');
let bytes;
function visit(n, depth = 0) {
  if (ts.isStringLiteralLike(n) && n.text.length > 10000) {
    if (n.text.charCodeAt(0) === 0 && n.text.slice(1, 4) === 'asm') {
      if (bytes) throw Error('Multiple embedded binaries');
      // Exact binaryDecode operation in shipped worker (no eval).
      bytes = Uint8Array.from(n.text, (c) => (~c.charCodeAt(0) >> 8) & c.charCodeAt(0));
    } else if (depth === 0)
      visit(ts.createSourceFile('embedded-worker.js', n.text, ts.ScriptTarget.Latest, true), 1);
  }
  ts.forEachChild(n, (child) => visit(child, depth));
}
visit(ts.createSourceFile('aac-bundle.mjs', bundle, ts.ScriptTarget.Latest, true));
if (!bytes || sha(bytes) !== '8488acb0bc9f43055b83600cc4c2c07d20f07675aa65671f91ac1d75515845d9')
  throw Error('Embedded WASM drift');
let at = 8;
function leb() {
  let n = 0,
    shift = 0,
    b;
  do {
    if (at >= bytes.length || shift > 28) throw Error('Invalid LEB');
    b = bytes[at++];
    n += (b & 127) * 2 ** shift;
    shift += 7;
  } while (b & 128);
  return n;
}
const memories = [];
let memorySection;
while (at < bytes.length) {
  const sectionOffset = at;
  const id = bytes[at++],
    size = leb(),
    end = at + size;
  if (end > bytes.length) throw Error('Invalid section');
  if (id === 5) {
    memorySection = {
      sectionOffset,
      payloadOffset: at,
      payloadBytes: size,
      payloadHex: Buffer.from(bytes.subarray(at, end)).toString('hex'),
      sectionHex: Buffer.from(bytes.subarray(sectionOffset, end)).toString('hex'),
    };
    const count = leb();
    for (let i = 0; i < count; i++) {
      const flags = leb();
      if (flags !== 1) throw Error('Unexpected memory flags');
      const initialPages = leb(),
        maximumPages = leb();
      memories.push({
        initialPages,
        initialBytes: initialPages * 65536,
        maximumPages,
        maximumBytes: maximumPages * 65536,
      });
    }
  }
  at = end;
}
if (memories.length !== 1 || memories[0].initialBytes !== 18087936)
  throw Error('Memory declaration drift');
console.log(
  JSON.stringify(
    {
      bundleSha256: sha(bundle),
      wasmSha256: sha(bytes),
      wasmBytes: bytes.length,
      memories,
      memorySection,
      accountingScope:
        'Existing codec-owned heap, separate from accepted managed PCM/native-audio backing ledger. Not a total process memory guarantee. No fit/non-fit inference from comparing these different scopes.',
      managedPcmBudgetBytes: 8388608,
      method:
        'Static embedded-binary section decode; no worker/WASM instantiated. Maximum is a growth limit, not resident allocation.',
    },
    null,
    2,
  ),
);
