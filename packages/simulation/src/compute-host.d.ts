/** Supplied by the Host build (scripts/dev/simulation-host.mjs); null without a compute Host. */
declare module 'virtual:simulation-compute-host' {
  const host: import('./compute').SimulationComputeDescriptor | null;
  export default host;
}
