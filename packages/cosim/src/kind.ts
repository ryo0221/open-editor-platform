import { defineKind } from '@editor-platform/artifact-kinds';
import { cosimStarter, isCosimDocument, type CosimDocument } from '@editor-platform/cosim-core';

/** The Co-simulation kind (docs/kind-registry-design.md). */
export const cosimKind = defineKind<CosimDocument>({
  kind: 'cosim',
  area: 'engineering',
  label: 'Co-simulation',
  icon: '⇄',
  description: 'Run a saved ladder program against a saved schematic: buttons, LEDs, GPIO',
  creatable: true,
  create: (count) => ({ name: `Co-simulation ${count}`, content: cosimStarter() }),
  validate: isCosimDocument,
});
