import type { Domain } from '@editor-platform/collaboration-core';
import { animationEditorCodec } from './animation';
import { documentEditorCodec } from './document-editor';
import {
  scheduleEditorCodec,
  structuredGraphEditorCodec,
  analysisEditorCodec,
  estimateEditorCodec,
  fictionMapEditorCodec,
  geoEditorCodec,
  ladderEditorCodec,
  schematicEditorCodec,
  drawingEditorCodec,
  pcbEditorCodec,
  constructionEditorCodec,
  factoryEditorCodec,
  cosimEditorCodec,
  cadEditorCodec,
  bimEditorCodec,
  characterEditorCodec,
  simulationEditorCodec,
  slideEditorCodec,
  mangaEditorCodec,
  whiteboardEditorCodec,
  dataEditorCodec,
} from './editor-transactions';
import { mindmapEditorCodec } from './mindmap';
import { reactUiEditorCodec } from './react-ui';
import { reviewCodec, fileCodec } from './review';

/** Standard native documents. Hosts register their trusted graph profiles, reference resolvers and pinned Video timelines separately. */
export const nativeEditorCodecs = {
  'react-ui': reactUiEditorCodec,
  animation: animationEditorCodec,
  mindmap: mindmapEditorCodec,
  schedule: scheduleEditorCodec,
  'structured-graph': structuredGraphEditorCodec,
  analysis: analysisEditorCodec,
  estimate: estimateEditorCodec,
  'fiction-map': fictionMapEditorCodec,
  geo: geoEditorCodec,
  ladder: ladderEditorCodec,
  schematic: schematicEditorCodec,
  drawing: drawingEditorCodec,
  pcb: pcbEditorCodec,
  construction: constructionEditorCodec,
  factory: factoryEditorCodec,
  cosim: cosimEditorCodec,
  cad: cadEditorCodec,
  bim: bimEditorCodec,
  character: characterEditorCodec,
  simulation: simulationEditorCodec,
  slide: slideEditorCodec,
  design: mangaEditorCodec,
  whiteboard: whiteboardEditorCodec,
  data: dataEditorCodec,
  document: documentEditorCodec,
  review: reviewCodec,
  file: fileCodec,
} satisfies Record<Exclude<Domain, 'video'>, unknown>;
