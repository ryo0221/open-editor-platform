/** Supplied by the Host build (scripts/dev/cad-kernel.mjs); null when no kernel is configured. */
declare module 'virtual:cad-kernel-build' {
  type Build = { id: string; buildHash: string; moduleUrl: string; wasmUrl: string };
  const build: Build | null;
  export default build;
  /** Older builds the Host serves, revocations and approved read-only substitutions. */
  export const kernels: {
    retained?: Build[];
    revoked?: string[];
    substitutes?: { from: string; to: string; semanticsVersion: number }[];
  };
}
