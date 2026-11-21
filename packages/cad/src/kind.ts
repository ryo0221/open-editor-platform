import { defineKind } from '@editor-platform/artifact-kinds';
import {
  emptyCad,
  isCadDocument,
  type CadDocument,
  type CadKernelProfile,
} from '@editor-platform/cad-core';

/** The 3D CAD kind. A new part names the Host's kernel build. */
export const cadKind = (kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>) =>
  defineKind<CadDocument>({
    kind: 'cad',
    area: 'engineering',
    label: '3D CAD',
    icon: '⬢',
    description: 'Model parametric solids in millimetres',
    creatable: true,
    create: (count) => ({ name: `3D CAD ${count}`, content: emptyCad(kernel) }),
    validate: isCadDocument,
  });
