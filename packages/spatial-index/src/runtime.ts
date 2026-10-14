import { loadWasmFactory } from './wasm';
import type { WasmFactory } from './types';
let factory: WasmFactory | undefined;
let generation = 0;
export const getWasmFactory = () => factory;
/** Experimental internal opt-in. Normal Hosts need neither Rust nor an asset fetch. */
export async function initializeSpatialWasm(
  source: () => Promise<ArrayBuffer | Uint8Array>,
): Promise<boolean> {
  const current = ++generation;
  factory = undefined;
  try {
    if (typeof WebAssembly === 'undefined') return false;
    const next = await loadWasmFactory(await source(), () => {
      if (current === generation) factory = undefined;
    });
    if (current !== generation) return false;
    factory = next;
    return true;
  } catch {
    return false;
  }
}
export function useTypeScriptSpatialBackend() {
  generation++;
  factory = undefined;
}
