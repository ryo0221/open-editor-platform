import cadKernelBuild from 'virtual:cad-kernel-build';

/** The Host-supplied CAD kernel build that a new CAD part names (see the Playground's kinds/kernel.ts). */
export const cadKernelProfile = {
  id: cadKernelBuild?.id ?? 'unavailable',
  buildHash: cadKernelBuild?.buildHash ?? `sha256:${'0'.repeat(64)}`,
};
