// The Artifact Host's engineering kinds. Only Host data (the CAD kernel build) is supplied here.
import type { KindDefinition } from '@editor-platform/artifact-kinds';
import { bimKind } from '@editor-platform/bim/kind';
import { cadKind } from '@editor-platform/cad/kind';
import { artifactKind } from './artifact-kind';
import { cadKernelProfile } from './kernel';

export const cadDefinition = cadKind(cadKernelProfile);

/** The typed definitions, in list order (kinds/surfaces.tsx checks each has one Surface). */
export const engineeringDefinitions: readonly KindDefinition<unknown>[] = [cadDefinition, bimKind];

const local = { undo: true, nativeJson: true, shared: false } as const;

export const engineeringKinds = [
  artifactKind(cadDefinition, {
    label: '3D CAD',
    // PNG comes from the Surface viewport (exact evaluated shape); no headless renderer here.
    adapter: { capabilities: { ...local, formats: [], preview: 'none' } },
  }),
  artifactKind(bimKind, {
    label: 'Building',
    // Drawings and IFC come with R2c-5 and R2c-6.
    adapter: { capabilities: { ...local, formats: [], preview: 'none' } },
  }),
];
