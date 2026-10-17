// @ts-expect-error Private runtime scalar AAC inventory is deliberately outside public types.
import { codecInputDiagnostics } from './codec-inputs.mjs';
/** Private M2 consumer ownership. No package entrypoint or saved-schema exposure. */
import { Ledger, ModuleInput } from '../pcm-wasm-r0/kernel';
import {
  configurePcmBackend,
  pcmBackendDiagnostics,
  APPROVED_WASM_SHA,
} from '../pcm-wasm-v1/selection';
class ObservedLedger extends Ledger {
  peak = 0;
  constructor(private shared?: Ledger) {
    super(8 * 1024 * 1024);
  }
  override get bytes() {
    return this.shared?.bytes ?? super.bytes;
  }
  override reserve(bytes: number) {
    const release = this.shared ? this.shared.reserve(bytes) : super.reserve(bytes);
    this.peak = Math.max(this.peak, this.bytes);
    return release;
  }
}
// Exact accepted #215 identity; never install a second budget beside a loaded Host bundle.
const key = Symbol.for('editor-platform.private-pcm-budget.v1');
const globalBudget = globalThis as unknown as Record<symbol, Ledger | undefined>;
const existing = globalBudget[key];
if (existing && (existing.limit !== 8 * 1024 * 1024 || typeof existing.reserve !== 'function'))
  throw Error('Private PCM budget identity');
const realm = new ObservedLedger(existing);
if (!existing)
  Object.defineProperty(globalBudget, key, { value: realm, configurable: false, writable: false });
let configured = false;
const live = new Set<ConsumerOwner>();
const retired: object[] = [];
export function configureM2Pcm(mode: 'js' | 'wasm', bytes?: Uint8Array<ArrayBuffer>) {
  if (configured || live.size) throw Error('M2 PCM selection already active');
  configurePcmBackend({
    mode,
    realm,
    bytes,
    sha256: mode === 'wasm' ? APPROVED_WASM_SHA : undefined,
  });
  configured = true;
}
export function configureM2PcmFactory(length: number, make: () => Uint8Array<ArrayBuffer>) {
  if (configured || live.size) throw Error('M2 PCM selection already active');
  const input = ModuleInput.allocate(length, make, realm);
  try {
    configurePcmBackend({ mode: 'wasm', realm, input, sha256: APPROVED_WASM_SHA });
    configured = true;
  } catch (error) {
    input.dispose();
    throw error;
  }
}
export function m2PcmRealm() {
  if (!configured) configureM2Pcm('js');
  return realm;
}
export function m2PcmDiagnostics() {
  return {
    ...pcmBackendDiagnostics(),
    codecInputs: codecInputDiagnostics(),
    realmLimit: realm.limit,
    realmPeak: realm.peak,
    owners: [...retired, ...[...live].map((o) => o.evidence())],
  };
}
/** Cumulative owner ceilings do not replace the single unchanged realm admission. */
export class ConsumerOwner {
  private bytes = 0;
  private peak = 0;
  private closed = false;
  private categories = new Map<string, number>();
  constructor(
    private label: string,
    private ceiling: number,
  ) {
    m2PcmRealm();
    live.add(this);
  }
  reserve(bytes: number, category = 'pcm') {
    if (
      this.closed ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.ceiling - this.bytes
    )
      throw Error('M2 PCM owner admission');
    const done = realm.reserve(bytes);
    this.bytes += bytes;
    this.peak = Math.max(this.peak, this.bytes);
    this.categories.set(category, (this.categories.get(category) ?? 0) + bytes);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      done();
      this.bytes -= bytes;
      this.categories.set(category, this.categories.get(category)! - bytes);
      this.retire();
    };
  }
  evidence() {
    return {
      label: this.label,
      bytes: this.bytes,
      peak: this.peak,
      closed: this.closed,
      categories: Object.fromEntries(this.categories),
    };
  }
  close() {
    this.closed = true;
    this.retire();
  }
  private retire() {
    if (this.closed && this.bytes === 0 && live.delete(this)) {
      if (retired.length >= 64) retired.shift();
      retired.push(this.evidence());
    }
  }
}
