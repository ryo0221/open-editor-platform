/** A Host-verified OCCT build. The Worker fetches nothing else and runs no other code. */
export interface KernelBuild {
  /** `sha256:<hex>` of the Wasm bytes. */
  buildHash: string;
  /** Emscripten module factory (ES module default export) that accepts `{ wasmBinary }`. */
  moduleUrl: string;
  wasmUrl: string;
}

/** Marks in the Worker's performance timeline for the start-up phases of one build. */
export interface KernelLoadMarks {
  start: string;
  fetched: string;
  verified: string;
  moduleLoaded: string;
  compiled: string;
  instantiated: string;
}
/** The start-up marks of a domain's kernel, `<prefix>:load-start` … `<prefix>:instantiated`. */
export const kernelLoadMarksOf = (prefix: string): Readonly<KernelLoadMarks> =>
  Object.freeze({
    start: `${prefix}:load-start`,
    fetched: `${prefix}:fetched`,
    verified: `${prefix}:verified`,
    moduleLoaded: `${prefix}:module-loaded`,
    compiled: `${prefix}:compiled`,
    instantiated: `${prefix}:instantiated`,
  });

/**
 * Browser loader: fetch Wasm from the Host-approved URL, verify SHA-256, then instantiate.
 * Returns the module the factory resolves to (the Embind surface).
 */
export async function loadKernelBuild(
  build: KernelBuild,
  marks: KernelLoadMarks,
): Promise<unknown> {
  performance.mark(marks.start);
  const bytes = new Uint8Array(
    await (await fetch(build.wasmUrl, { credentials: 'same-origin' })).arrayBuffer(),
  );
  performance.mark(marks.fetched);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (`sha256:${hex}` !== build.buildHash) throw new Error('kernel-build-hash');
  performance.mark(marks.verified);
  // The Emscripten module factory itself (e.g. opencascade.full.js), not a wrapper that locates files.
  const { default: factory } = await import(/* @vite-ignore */ build.moduleUrl);
  performance.mark(marks.moduleLoaded);
  // Compiled here and instantiated through Emscripten's instantiateWasm hook, so the two phases
  // can be told apart; the verified bytes and the module's own imports are used as before.
  const module = await WebAssembly.compile(bytes);
  performance.mark(marks.compiled);
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => (fail = reject));
  const oc = await Promise.race([
    factory({
      instantiateWasm(
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) {
        WebAssembly.instantiate(module, imports).then((i) => receive(i, module), fail);
        return {};
      },
    }),
    failed,
  ]);
  performance.mark(marks.instantiated);
  return oc;
}
