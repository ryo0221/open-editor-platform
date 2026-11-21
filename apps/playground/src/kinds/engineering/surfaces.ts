// The Playground's engineering Surfaces, in the order of kinds/engineering.ts, and the Host
// connections that office kinds receive from engineering code.
import { playgroundEstimateGeometry } from '../../app/estimate-bim';
import { bimSurface } from './bim';
import { cadSurface } from './cad';
import { characterSurface } from './character';
import { constructionSurface } from './construction';
import { cosimSurface } from './cosim';
import { drawingSurface } from './drawing';
import { factorySurface } from './factory';
import { ladderSurface } from './ladder';
import { pcbSurface } from './pcb';
import { schematicSurface } from './schematic';
import { simulationSurface } from './simulation';

export const engineeringSurfaces = [
  cadSurface,
  bimSurface,
  characterSurface,
  simulationSurface,
  constructionSurface,
  pcbSurface,
  schematicSurface,
  ladderSurface,
  cosimSurface,
  drawingSurface,
  factorySurface,
];

/** CAD/BIM quantity reading for Estimate (ES11, ES16); the CAD/BIM code loads on first use. */
export const estimateGeometry = playgroundEstimateGeometry;
