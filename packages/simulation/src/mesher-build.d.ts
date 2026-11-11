/** Supplied by the Host build (scripts/dev/fem-mesher.mjs); null when no mesher is configured. */
declare module 'virtual:fem-mesher-build' {
  const build: { buildHash: string; moduleUrl: string; wasmUrl: string } | null;
  export default build;
}
