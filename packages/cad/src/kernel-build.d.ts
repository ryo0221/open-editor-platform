/** Supplied by the Host build (scripts/dev/cad-kernel.mjs); null when no kernel is configured. */
declare module 'virtual:cad-kernel-build' {
  const build: { buildHash: string; moduleUrl: string; wasmUrl: string } | null;
  export default build;
}
