import { defineKind } from '@editor-platform/artifact-kinds';
import { isLadderDocument, ladderStarter, type LadderDocument } from '@editor-platform/ladder-core';

/** The Ladder kind (docs/kind-registry-design.md). */
export const ladderKind = defineKind<LadderDocument>({
  kind: 'ladder',
  area: 'engineering',
  label: 'Ladder',
  icon: '⊣⊢',
  description: 'Write a PLC ladder program (IEC 61131-3) and run it scan by scan',
  creatable: true,
  create: (count) => ({ name: `Ladder ${count}`, content: ladderStarter() }),
  validate: isLadderDocument,
});
