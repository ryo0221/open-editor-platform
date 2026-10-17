import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Ledger, ModuleInput, prepareModule } from '../pcm-wasm-r0/kernel';
import { APPROVED_WASM_SHA, selectedPcmSession } from '../pcm-wasm-v1/selection';
import { configureM2PcmFactory, m2PcmDiagnostics } from './owners';
const [file, destination] = process.argv.slice(2);
const original = await readFile(file),
  n = original.byteLength;
assert.equal(createHash('sha256').update(original).digest('hex'), APPROVED_WASM_SHA);
assert.equal(n, 4972);
const charge = n * 2 + 32;
// Exact-cap transfer proves the startup input is reused rather than charged twice.
const exact = new Ledger(charge);
let allocations = 0;
const input = ModuleInput.allocate(
  n,
  () => {
    assert.equal(exact.bytes, n);
    allocations++;
    return new Uint8Array(original);
  },
  exact,
);
assert.equal(exact.bytes, n);
const work = prepareModule(input, APPROVED_WASM_SHA, exact);
assert.equal(exact.bytes, charge);
input.dispose();
assert.equal(exact.bytes, charge, 'Caller disposal released transferred ownership');
const pin = await work;
assert.equal(pin.chargedBytes, charge);
assert.equal(input.chargedBytes, charge);
assert.equal(allocations, 1);
const retained = pin.retain();
pin.dispose();
assert.equal(exact.bytes, charge, 'Live module reference lost its charge');
retained();
retained();
assert.equal(exact.bytes, 0);
assert.equal(input.chargedBytes, 0);
// Failed hash drops the input reference and all preparation reservations.
const bad = ModuleInput.allocate(n, () => new Uint8Array(n), exact);
await assert.rejects(prepareModule(bad, APPROVED_WASM_SHA, exact), /hash mismatch/);
assert.equal(exact.bytes, 0);
assert.equal(bad.available, false);
assert.equal(bad.chargedBytes, 0);
const realm = (globalThis as unknown as Record<symbol, Ledger>)[
  Symbol.for('editor-platform.private-pcm-budget.v1')
];
const held = realm.reserve(8 * 1024 * 1024);
let constructions = 0;
const factory = () => {
  assert.equal(realm.bytes, n);
  constructions++;
  return new Uint8Array(original);
};
assert.throws(() => configureM2PcmFactory(n, factory), /admission/);
assert.equal(constructions, 0);
held();
configureM2PcmFactory(n, factory);
const startup = m2PcmDiagnostics();
assert.equal(startup.moduleBytes, n);
assert.equal(startup.realmBytes, n);
assert.deepEqual(startup.sessions, []);
const session = await selectedPcmSession(
  {
    async decode(): Promise<never> {
      throw Error('No decode expected');
    },
  },
  'edge-hold-v0',
  new AbortController().signal,
);
assert.equal(session.diagnostics().backend, 'wasm');
await session.dispose();
const drained = m2PcmDiagnostics();
assert.equal(drained.moduleBytes, charge);
assert.equal(drained.realmBytes, charge);
assert.equal(constructions, 1);
assert(drained.sessions.every((entry) => (entry as { drained: boolean }).drained));
await writeFile(
  destination,
  JSON.stringify(
    {
      state: 'PASS',
      wasmSha256: APPROVED_WASM_SHA,
      inputBytes: n,
      preparedBytes: charge,
      fullLedgerFactoryCalls: 0,
      allocations,
      constructions,
      startup,
      drained,
      scope:
        'Actual official module admission/transfer/reference drain; no numerical or codec performance claim.',
    },
    null,
    2,
  ),
);
