import { endpoints, type SpatialIndex, type WasmFactory } from './types';
interface Exports {
  memory: WebAssembly.Memory;
  spatial_version(): number;
  spatial_alloc(count: number): number;
  spatial_free(ptr: number, count: number): void;
  spatial_build(ptr: number, count: number): number;
  spatial_query(handle: number, x: number, y: number, right: number, bottom: number): number;
  spatial_results(handle: number): number;
  spatial_drop(handle: number): void;
}
/** Reject imports and unknown ABI before any handle is allocated. */
export async function loadWasmFactory(
  bytes: ArrayBuffer | Uint8Array,
  onRetire: () => void,
): Promise<WasmFactory> {
  const module = await WebAssembly.compile(
    bytes instanceof Uint8Array ? Uint8Array.from(bytes) : new Uint8Array(bytes),
  );
  if (WebAssembly.Module.imports(module).length)
    throw new Error('Spatial Wasm must have no imports.');
  const instance = await WebAssembly.instantiate(module, {});
  return factoryFromExports(instance.exports, onRetire);
}
/** Internal seam for functional fault injection, not exported by the package. */
export function factoryFromExports(
  exports: WebAssembly.Exports,
  onRetire: () => void = () => {},
): WasmFactory {
  const e = exports as unknown as Exports;
  if (
    !(e.memory instanceof WebAssembly.Memory) ||
    [
      'spatial_version',
      'spatial_alloc',
      'spatial_free',
      'spatial_build',
      'spatial_query',
      'spatial_results',
      'spatial_drop',
    ].some((name) => typeof exports[name] !== 'function') ||
    e.spatial_version() !== 1
  )
    throw new Error('Unsupported spatial Wasm ABI.');
  let healthy = true;
  const retire = () => {
    if (healthy) {
      healthy = false;
      onRetire();
    }
  };
  return (data) => {
    if (!healthy) return undefined;
    let ptr = 0,
      handle = 0;
    try {
      if (data.length) {
        ptr = e.spatial_alloc(data.length);
        if (!ptr || ptr % 8) throw new Error('Spatial input allocation failed.');
        // Allocation can grow memory: always construct views from the current buffer.
        new Float64Array(e.memory.buffer, ptr, data.length).set(data);
      }
      handle = e.spatial_build(ptr, data.length / 4);
      if (!handle) throw new Error('Spatial index construction failed.');
    } catch (error) {
      retire();
      if (handle) {
        try {
          e.spatial_drop(handle);
        } catch {
          /* Retire this instance. */
        }
      }
      throw error;
    } finally {
      if (ptr) {
        try {
          e.spatial_free(ptr, data.length);
        } catch {
          retire();
        }
      }
    }
    let disposed = false;
    const result: SpatialIndex = {
      backend: 'wasm',
      query(bounds) {
        if (disposed || !healthy) throw new Error('Spatial Wasm instance is unavailable.');
        try {
          const count = e.spatial_query(handle, ...endpoints(bounds));
          if (!Number.isInteger(count) || count < 0 || count > data.length / 4)
            throw new Error('Invalid spatial Wasm result count.');
          const ptr = e.spatial_results(handle);
          const found = Array.from(new Uint32Array(e.memory.buffer, ptr, count));
          if (found.some((id, i) => id >= data.length / 4 || (i > 0 && found[i - 1] >= id)))
            throw new Error('Invalid spatial Wasm result order.');
          return found; // Own the result; later queries/growth/disposal cannot invalidate it.
        } catch (error) {
          retire();
          throw error;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          e.spatial_drop(handle);
        } catch {
          retire();
        }
        handle = 0;
      },
    };
    return result;
  };
}
