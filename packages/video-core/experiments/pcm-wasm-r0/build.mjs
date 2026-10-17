/** Manual-only, offline build. Toolchain installation is a separate verified step. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const [prefix, destination] = process.argv.slice(2);
if (!prefix || !destination)
  throw Error('Exact toolchain prefix and fresh external output required');
const out = path.resolve(destination);
if (out.startsWith(path.resolve(root, '../../../..') + '/'))
  throw Error('Keep artifacts outside Git');
await mkdir(out); // Refuse overwrite: failures/evidence stay retained.
const run = (exe, args, env = {}) =>
  execFileSync(exe, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
const proof = JSON.parse(await readFile(path.join(prefix, 'r0-install-proof.json'), 'utf8'));
const pinned = JSON.parse(await readFile(path.join(root, 'toolchain-inputs.json'), 'utf8'));
if (JSON.stringify(proof.pins) !== JSON.stringify(pinned))
  throw Error('Toolchain provenance mismatch');
for (const [name, expected] of Object.entries(proof.installedSha256)) {
  if (name.includes('..') || path.isAbsolute(name)) throw Error('Invalid installation proof');
  const actual = createHash('sha256')
    .update(await readFile(path.join(prefix, name)))
    .digest('hex');
  if (actual !== expected) throw Error('Installed toolchain was modified: ' + name);
}
const rustc = path.resolve(prefix, 'bin/rustc'),
  cargo = path.resolve(prefix, 'bin/cargo');
const compiler = run(rustc, ['-vV']);
if (
  !compiler.includes('commit-hash: 1159e78c4747b02ef996e55082b704c09b970588') ||
  !compiler.includes('LLVM version: 20.1.8')
)
  throw Error('Unreviewed compiler');
const flags = [
  '-Ctarget-cpu=mvp',
  '-Ctarget-feature=-simd128,-relaxed-simd,-atomics,-bulk-memory,-reference-types,-multivalue,-sign-ext,-nontrapping-fptoint',
  '-Clink-arg=--initial-memory=786432',
  '-Clink-arg=--max-memory=786432',
  '-Clink-arg=-zstack-size=65536',
  '--remap-path-prefix=' + root + '=/pcm-r0',
];
const args = [
  'build',
  '--release',
  '--frozen',
  '--target',
  'wasm32-unknown-unknown',
  '--target-dir',
  path.join(out, 'target'),
];
run(cargo, args, {
  RUSTC: rustc,
  CARGO_HOME: path.join(out, 'cargo-home'),
  CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f'),
});
const bytes = await readFile(
  path.join(out, 'target/wasm32-unknown-unknown/release/private_pcm_r0.wasm'),
);
const sha = (b) => createHash('sha256').update(b).digest('hex');
// Minimal section reader: enforce fixed nonshared wasm32 memory declaration, imports and surface.
let at = 8;
const leb = () => {
  let n = 0,
    s = 0,
    b;
  do {
    b = bytes[at++];
    n += (b & 127) * 2 ** s;
    s += 7;
    if (s > 35) throw Error('LEB');
  } while (b & 128);
  return n;
};
let memory;
while (at < bytes.length) {
  const id = bytes[at++],
    length = leb(),
    end = at + length;
  if (id === 5) {
    if (leb() !== 1 || leb() !== 1) throw Error('Memory profile');
    memory = [leb(), leb()];
  }
  at = end;
}
if (String(memory) !== '12,12') throw Error('Memory bound');
const module = new globalThis.WebAssembly.Module(bytes);
if (globalThis.WebAssembly.Module.imports(module).length) throw Error('Unexpected imports');
const exports = globalThis.WebAssembly.Module.exports(module);
if (
  exports
    .map((e) => e.name)
    .sort()
    .join(',') !== '__data_end,__heap_base,abi,arena,arena_bytes,kernel,memory,written'
)
  throw Error('Unexpected exports');
const featureSections = globalThis.WebAssembly.Module.customSections(module, 'target_features');
if (featureSections.length !== 1) throw Error('Target feature declaration');
const featureBytes = new Uint8Array(featureSections[0]);
let featureAt = 0;
const featureLeb = () => {
  let n = 0,
    shift = 0,
    byte;
  do {
    if (featureAt >= featureBytes.length || shift >= 35) throw Error('Feature LEB');
    byte = featureBytes[featureAt++];
    n += (byte & 127) * 2 ** shift;
    shift += 7;
  } while (byte & 128);
  return n;
};
const targetFeatures = [],
  featureCount = featureLeb();
for (let i = 0; i < featureCount; i++) {
  const prefix = featureBytes[featureAt++],
    size = featureLeb();
  const name = new globalThis.TextDecoder().decode(
    featureBytes.subarray(featureAt, featureAt + size),
  );
  featureAt += size;
  if (prefix !== 43) throw Error('Unexpected target feature prefix');
  targetFeatures.push(name);
}
const reviewedFeatures = [
  'bulk-memory',
  'bulk-memory-opt',
  'call-indirect-overlong',
  'multivalue',
  'mutable-globals',
  'nontrapping-fptoint',
  'reference-types',
  'sign-ext',
];
if (featureAt !== featureBytes.length || targetFeatures.join(',') !== reviewedFeatures.join(','))
  throw Error('Unreviewed emitted target features');
const instance = new globalThis.WebAssembly.Instance(module);
if (
  instance.exports.abi() !== 1 ||
  instance.exports.arena_bytes() !== 657408 ||
  instance.exports.arena() % 8
)
  throw Error('Arena layout');
await writeFile(path.join(out, 'pcm.wasm'), bytes);
await cp(path.join(prefix, 'share/doc/rust'), path.join(out, 'notices/rust'), { recursive: true });
await cp(path.join(prefix, 'share/doc/cargo'), path.join(out, 'notices/cargo'), {
  recursive: true,
});
await cp(
  path.resolve(root, '../../../../scripts/public-export/overlays/LICENSE'),
  path.join(out, 'notices/EXISTING-PUBLIC-EXPORT-LICENSE-NOT-A-PRIVATE-LICENSE-GRANT'),
);
const inputs = {};
for (const name of [
  'Cargo.toml',
  'Cargo.lock',
  'src/lib.rs',
  'rust-toolchain.toml',
  'toolchain-inputs.json',
  'build.mjs',
])
  inputs[name] = sha(await readFile(path.join(root, name)));
const notices = {};
async function scan(dir, relative = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = relative + e.name;
    if (e.isDirectory()) await scan(path.join(dir, e.name), name + '/');
    else notices[name] = sha(await readFile(path.join(dir, e.name)));
  }
}
await scan(path.join(out, 'notices'));
const manifest = {
  sourceCommit: run('git', ['rev-parse', 'HEAD']),
  workingTree: run('git', ['status', '--porcelain']),
  compiler,
  cargo: run(cargo, ['-V']),
  target: 'wasm32-unknown-unknown',
  flags: flags.map((f) => (f.startsWith('--remap') ? '--remap-path-prefix=<source>=/pcm-r0' : f)),
  command:
    'cargo build --release --frozen --target wasm32-unknown-unknown --target-dir <fresh-output>/target',
  inputs,
  toolchain: JSON.parse(await readFile(path.join(root, 'toolchain-inputs.json'), 'utf8')),
  wasmSha256: sha(bytes),
  bytes: bytes.length,
  memoryPages: memory,
  stackBytes: 65536,
  arenaBytes: 657408,
  targetFeatures,
  imports: [],
  exports,
  notices,
};
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  JSON.stringify({ wasmSha256: manifest.wasmSha256, bytes: bytes.length, memoryPages: memory }),
);
