import cadKernelBuild, { kernels as cadKernelCatalog } from 'virtual:cad-kernel-build';

/**
 * The Host-supplied CAD kernel build (the custom development OpenCascade.js while D0 is open).
 * New CAD artifacts are offered only when one is configured; documents always name the build
 * they need.
 */
export const cadKernel = cadKernelBuild;
/** Older kernel builds and approved reference substitutions (scripts/cad-kernel/build.mjs). */
export const cadKernels = cadKernelCatalog;
export const cadKernelProfile = {
  id: cadKernelBuild?.id ?? 'unavailable',
  buildHash: cadKernelBuild?.buildHash ?? `sha256:${'0'.repeat(64)}`,
};
