// The Playground's engineering kinds, in the order the Playground lists them. Only Host data
// (the CAD kernel build) is supplied here; the definitions come from each package's `./kind`.
import { registerKind } from '@editor-platform/artifact-kinds';
import { bimKind } from '@editor-platform/bim/kind';
import { cadKind } from '@editor-platform/cad/kind';
import { characterKind } from '@editor-platform/character/kind';
import { constructionKind } from '@editor-platform/construction/kind';
import { cosimKind } from '@editor-platform/cosim/kind';
import { drawingKind } from '@editor-platform/drawing/kind';
import { factoryKind } from '@editor-platform/factory/kind';
import { ladderKind } from '@editor-platform/ladder/kind';
import { pcbKind } from '@editor-platform/pcb/kind';
import { schematicKind } from '@editor-platform/schematic/kind';
import { simulationKind } from '@editor-platform/simulation/kind';
import { cadKernelProfile } from './kernel';

export const engineeringKinds = [
  registerKind(cadKind(cadKernelProfile)),
  registerKind(bimKind),
  registerKind(characterKind),
  registerKind(simulationKind),
  registerKind(constructionKind),
  registerKind(pcbKind),
  registerKind(schematicKind),
  registerKind(ladderKind),
  registerKind(cosimKind),
  registerKind(drawingKind),
  registerKind(factoryKind),
];
