// How the Playground stores, opens and imports office records (kinds/record-kind.ts), in the
// order of kinds/office.ts. No React, and no engineering code (scripts/check-area-boundaries.mjs).
import { analysisKind } from '@editor-platform/analysis/kind';
import { animationKind } from '@editor-platform/animation/kind';
import { designKind } from '@editor-platform/design/kind';
import { documentKind } from '@editor-platform/document/kind';
import { estimateKind } from '@editor-platform/estimate/kind';
import {
  parseFictionMapArtifact,
  verifyFictionMapArtifact,
} from '@editor-platform/fiction-map/host';
import { fictionMapKind } from '@editor-platform/fiction-map/kind';
import { geoKind } from '@editor-platform/geo-inspector/kind';
import { mindmapKind } from '@editor-platform/mindmap/kind';
import { fileKind, reviewKind } from '@editor-platform/review-surfaces/kind';
import { hasSlideAnimations } from '@editor-platform/slide';
import { slideKind } from '@editor-platform/slide/kind';
import { graphSchemaMessage, readGraphDocument } from '@editor-platform/structured-graph/model';
import { whiteboardKind } from '@editor-platform/whiteboard/kind';
import { validateGeoRecord } from '../../geo/resources';
import { dataDefinition, graphDefinition, reactUiDefinition, scheduleDefinition } from '../office';
import { recordKind } from '../record-kind';

// Kinds without a reusable-definition adapter are not checked for one on import.
const noReusable = () => false;

export const officeRecords = [
  recordKind(estimateKind, { storedVersionHashes: true, reusableAdapter: noReusable }),
  recordKind(analysisKind, { storedVersionHashes: true, reusableAdapter: noReusable }),
  recordKind(animationKind, { storedVersionHashes: true, reusableAdapter: noReusable }),
  recordKind(fictionMapKind, {
    verifyStored: verifyFictionMapArtifact,
    parseNative: parseFictionMapArtifact,
    reusableAdapter: noReusable,
  }),
  recordKind(geoKind, {
    verifyStored: validateGeoRecord,
    // A Geo artifact's id is its resource scope.
    importKeepsId: {
      duplicate: 'This Geo artifact already exists. Open it from the artifact list.',
    },
    async importExtras(record, file) {
      record.geoResources = file.geoResources;
      record.geoDataInputs = file.geoDataInputs;
      await validateGeoRecord(record);
    },
    reusableAdapter: noReusable,
  }),
  recordKind(graphDefinition, {
    storedVersionHashes: true,
    // A newer Graph schema gets its own reason; the record stays exportable.
    invalidReason: graphSchemaMessage,
    // An older Graph schema opens as the current one; its saved versions are not rewritten.
    openContent: readGraphDocument,
    reusableAdapter: noReusable,
  }),
  recordKind(reactUiDefinition, { reusableAdapter: noReusable }),
  recordKind(documentKind),
  recordKind(dataDefinition),
  recordKind(reviewKind),
  recordKind(fileKind),
  recordKind(whiteboardKind),
  recordKind(mindmapKind, { reusableAdapter: noReusable }),
  recordKind(designKind, { storedVersionHashes: true }),
  recordKind(slideKind, { reusableAdapter: (content) => !hasSlideAnimations(content) }),
  recordKind(scheduleDefinition, { reusableAdapter: noReusable }),
];
